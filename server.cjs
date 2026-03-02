require('dotenv').config();
const express = require('express');
const fs = require('fs');
const cors = require('cors');
const path = require('path');
const { initDb, createDbStore, isDbAvailable } = require('./db.cjs');

const app = express();
const PORT = process.env.PORT || 3002;

// ============ Store Setup (DB or JSON fallback) ============

// JSON file store factory — used as fallback when no DATABASE_URL
function createJsonStore(filePath, defaultValue) {
    return {
        read() {
            if (!fs.existsSync(filePath)) {
                return typeof defaultValue === 'function' ? defaultValue() : defaultValue;
            }
            const data = fs.readFileSync(filePath, 'utf8');
            return JSON.parse(data);
        },
        write(data) {
            fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        }
    };
}

// Wrap sync JSON stores in async interface for uniform usage
function asyncJsonStore(filePath, defaultValue) {
    const store = createJsonStore(filePath, defaultValue);
    return {
        async read() { return store.read(); },
        async write(data) { return store.write(data); }
    };
}

const DEFAULTS = {
    items: () => ({ items: [], nextId: 1 }),
    timeline: () => ({ entries: [], nextId: 1 }),
    settings: () => ({ dayStartHour: 8, dayStartMinute: 0, dayEndHour: 22, dayEndMinute: 0 }),
    ai_chat: () => ({ messages: [] }),
    preferences: () => ({})
};

let itemsStore, timelineStore, settingsStore, chatStore, preferencesStore;

function initStores() {
    if (isDbAvailable()) {
        console.log('Using PostgreSQL storage (DATABASE_URL detected)');
        itemsStore = createDbStore('items', DEFAULTS.items);
        timelineStore = createDbStore('timeline', DEFAULTS.timeline);
        settingsStore = createDbStore('settings', DEFAULTS.settings);
        chatStore = createDbStore('ai_chat', DEFAULTS.ai_chat);
        preferencesStore = createDbStore('preferences', DEFAULTS.preferences);
    } else {
        console.log('Using JSON file storage (no DATABASE_URL)');
        if (!fs.existsSync('./data')) {
            fs.mkdirSync('./data', { recursive: true });
        }
        itemsStore = asyncJsonStore('./data/items.json', DEFAULTS.items);
        timelineStore = asyncJsonStore('./data/timeline.json', DEFAULTS.timeline);
        settingsStore = asyncJsonStore('./data/settings.json', DEFAULTS.settings);
        chatStore = asyncJsonStore('./data/ai_chat.json', DEFAULTS.ai_chat);
        preferencesStore = asyncJsonStore('./data/preferences.json', DEFAULTS.preferences);
    }
}

// ============ SSE Sync Infrastructure ============

const sseClients = new Map(); // clientId -> res

function notifyClients(type, excludeClientId) {
    const msg = `data: ${JSON.stringify({ type })}\n\n`;
    for (const [cid, res] of sseClients) {
        if (cid === excludeClientId) continue;
        try { res.write(msg); } catch { /* client gone */ }
    }
}

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('.'));

// ============ SSE Sync Endpoint ============

app.get('/api/sync', (req, res) => {
    const clientId = req.query.clientId || `anon-${Date.now()}`;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    // Send connected confirmation
    res.write(`data: ${JSON.stringify({ type: 'connected', clientId })}\n\n`);

    sseClients.set(clientId, res);
    console.log(`SSE client connected: ${clientId} (total: ${sseClients.size})`);

    // Heartbeat every 20s to keep connection alive
    const heartbeat = setInterval(() => {
        try { res.write(': heartbeat\n\n'); } catch { clearInterval(heartbeat); }
    }, 20000);

    req.on('close', () => {
        clearInterval(heartbeat);
        sseClients.delete(clientId);
        console.log(`SSE client disconnected: ${clientId} (total: ${sseClients.size})`);
    });
});

// ============ Items API (unified tree) ============

app.get('/api/items', async (req, res) => {
    res.json(await itemsStore.read());
});

// Add a new item (optionally under a parent)
app.post('/api/items', async (req, res) => {
    const data = await itemsStore.read();
    const { name, parentId, timeContexts, contextDurations } = req.body;

    const newItem = {
        id: data.nextId++,
        name: name || 'New Item',
        children: [],
        expanded: false,
        createdAt: Date.now(),
        done: false,
        timeContexts: (timeContexts && timeContexts.length > 0) ? timeContexts : ['ongoing']
    };

    // Attach contextDurations if provided
    if (contextDurations && typeof contextDurations === 'object' && Object.keys(contextDurations).length > 0) {
        newItem.contextDurations = contextDurations;
    }

    if (parentId) {
        // Insert as child of parent
        const insertInto = (items) => {
            for (const item of items) {
                if (item.id === parentId) {
                    item.children = item.children || [];
                    item.children.unshift(newItem);
                    return true;
                }
                if (item.children && insertInto(item.children)) return true;
            }
            return false;
        };
        if (!insertInto(data.items)) {
            return res.status(404).json({ error: 'Parent not found' });
        }
    } else {
        // Insert after Inbox (index 0) so new root items appear first
        const inboxIdx = data.items.findIndex(i => i.isInbox);
        data.items.splice(inboxIdx >= 0 ? inboxIdx + 1 : 0, 0, newItem);
    }

    await itemsStore.write(data);
    notifyClients('items', req.headers['x-client-id']);
    res.status(201).json(newItem);
});

app.patch('/api/items/:id', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const updates = req.body;
    const data = await itemsStore.read();

    const updateRecursive = (items) => {
        for (let i = 0; i < items.length; i++) {
            if (items[i].id === id) {
                Object.assign(items[i], updates);
                return items[i];
            }
            if (items[i].children) {
                const found = updateRecursive(items[i].children);
                if (found) return found;
            }
        }
        return null;
    };

    const updated = updateRecursive(data.items);
    if (!updated) return res.status(404).json({ error: 'Item not found' });

    await itemsStore.write(data);
    notifyClients('items', req.headers['x-client-id']);
    res.json(updated);
});

app.delete('/api/items/:id', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const data = await itemsStore.read();

    const deleteRecursive = (items) => {
        for (let i = 0; i < items.length; i++) {
            if (items[i].id === id) {
                items.splice(i, 1);
                return true;
            }
            if (items[i].children && deleteRecursive(items[i].children)) return true;
        }
        return false;
    };

    if (!deleteRecursive(data.items)) {
        return res.status(404).json({ error: 'Item not found' });
    }

    await itemsStore.write(data);
    notifyClients('items', req.headers['x-client-id']);
    res.json({ message: 'Deleted' });
});

// Bulk save the full items tree (for expanded state, reordering, etc.)
app.put('/api/items', async (req, res) => {
    // Guard against stale tabs overwriting newer data
    const incoming = req.body;
    const current = await itemsStore.read();
    if (incoming.nextId && current.nextId && incoming.nextId < current.nextId) {
        return res.status(409).json({
            error: 'Stale write rejected',
            message: `Your data (nextId: ${incoming.nextId}) is older than the server (nextId: ${current.nextId}). Please reload.`,
            serverNextId: current.nextId,
            clientNextId: incoming.nextId
        });
    }
    await itemsStore.write(incoming);
    notifyClients('items', req.headers['x-client-id']);
    res.json(incoming);
});

// ============ Timeline API ============

app.get('/api/timeline', async (req, res) => {
    res.json(await timelineStore.read());
});

app.post('/api/timeline', async (req, res) => {
    const data = await timelineStore.read();
    const entry = {
        ...req.body,
        id: data.nextId++,
        timestamp: req.body.startTime || Date.now()
    };
    data.entries.push(entry);
    await timelineStore.write(data);
    notifyClients('timeline', req.headers['x-client-id']);
    res.status(201).json(entry);
});

app.patch('/api/timeline/:id', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const updates = req.body;
    const data = await timelineStore.read();
    const entry = data.entries.find(e => e.id === id);
    if (!entry) return res.status(404).json({ error: 'Timeline entry not found' });

    Object.assign(entry, updates);
    // Keep timestamp in sync with startTime if startTime was updated
    if (updates.startTime !== undefined) {
        entry.timestamp = updates.startTime;
    }
    await timelineStore.write(data);
    notifyClients('timeline', req.headers['x-client-id']);
    res.json(entry);
});

app.delete('/api/timeline/:id', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const data = await timelineStore.read();
    const idx = data.entries.findIndex(e => e.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Timeline entry not found' });

    data.entries.splice(idx, 1);
    await timelineStore.write(data);
    notifyClients('timeline', req.headers['x-client-id']);
    res.json({ message: 'Deleted' });
});

// ============ Settings API ============

app.get('/api/settings', async (req, res) => {
    res.json(await settingsStore.read());
});

app.put('/api/settings', async (req, res) => {
    const current = await settingsStore.read();
    const updated = { ...current, ...req.body };
    await settingsStore.write(updated);
    notifyClients('settings', req.headers['x-client-id']);
    res.json(updated);
});

// ============ Preferences API ============

app.get('/api/preferences', async (req, res) => {
    res.json(await preferencesStore.read());
});

app.put('/api/preferences', async (req, res) => {
    const current = await preferencesStore.read();
    const updated = { ...current, ...req.body };
    await preferencesStore.write(updated);
    notifyClients('preferences', req.headers['x-client-id']);
    res.json(updated);
});

// ============ AI Copilot API ============

const { chat: aiChat, executeAndContinue } = require('./ai/executor.cjs');

app.post('/api/ai/chat', async (req, res) => {
    try {
        const { message, writeMode } = req.body;
        if (!message) return res.status(400).json({ error: 'Message is required' });

        // SSE headers
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();

        const sendEvent = (data) => {
            res.write(`data: ${JSON.stringify(data)}\n\n`);
        };

        // Load persisted history, send last 50 as context
        const chatData = await chatStore.read();
        const recentHistory = chatData.messages
            .filter(m => m.role === 'user' || m.role === 'assistant')
            .slice(-50)
            .map(m => ({ role: m.role, content: m.content }));

        // Persist user message
        chatData.messages.push({
            role: 'user',
            content: message,
            timestamp: Date.now()
        });

        const result = await aiChat(message, recentHistory, (event) => {
            sendEvent(event);
        });

        // Persist AI response
        if (result.text) {
            chatData.messages.push({
                role: 'assistant',
                content: result.text,
                timestamp: Date.now()
            });
        }

        // Persist plan as a separate message type
        if (result.plan && result.plan.length > 0) {
            chatData.messages.push({
                role: 'plan',
                content: result.plan,
                timestamp: Date.now(),
                status: 'pending'
            });
        }

        await chatStore.write(chatData);

        // Send final result
        sendEvent({ type: 'done', text: result.text, plan: result.plan });
        res.end();
    } catch (err) {
        console.error('AI chat error:', err);
        // If headers already sent, send error as SSE event
        if (res.headersSent) {
            res.write(`data: ${JSON.stringify({ type: 'error', error: err.message || 'AI request failed' })}\n\n`);
            res.end();
        } else {
            res.status(500).json({ error: err.message || 'AI request failed' });
        }
    }
});

app.post('/api/ai/execute', async (req, res) => {
    try {
        const { toolCalls } = req.body;
        if (!toolCalls || !Array.isArray(toolCalls)) {
            return res.status(400).json({ error: 'toolCalls array is required' });
        }

        // SSE headers for streaming execution events
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();

        const sendEvent = (data) => {
            res.write(`data: ${JSON.stringify(data)}\n\n`);
        };

        // Load chat history for continuation context
        const chatData = await chatStore.read();
        const recentHistory = chatData.messages
            .filter(m => m.role === 'user' || m.role === 'assistant')
            .slice(-50)
            .map(m => ({ role: m.role, content: m.content }));

        const { results, summary } = await executeAndContinue(toolCalls, recentHistory, (event) => {
            sendEvent(event);
        });

        // Persist AI summary from continuation if any
        if (summary) {
            chatData.messages.push({
                role: 'assistant',
                content: summary,
                timestamp: Date.now()
            });
            await chatStore.write(chatData);
        }

        // Send final result as SSE event
        sendEvent({ type: 'done', results, summary });
        res.end();
    } catch (err) {
        console.error('AI execute error:', err);
        if (res.headersSent) {
            res.write(`data: ${JSON.stringify({ type: 'error', error: err.message || 'Execution failed' })}\n\n`);
            res.end();
        } else {
            res.status(500).json({ error: err.message || 'Execution failed' });
        }
    }
});

app.get('/api/ai/config', async (req, res) => {
    const settings = await settingsStore.read();
    const provider = settings.aiProvider || process.env.AI_PROVIDER || 'gemini';
    const model = settings.aiModel || process.env.AI_MODEL || 'gemini-2.0-flash';
    const hasKey = !!(settings.aiApiKey || process.env.AI_API_KEY);
    res.json({ provider, model, available: hasKey });
});

// Chat history
app.get('/api/ai/history', async (req, res) => {
    const chatData = await chatStore.read();
    res.json(chatData);
});

app.delete('/api/ai/history', async (req, res) => {
    await chatStore.write({ messages: [] });
    res.json({ cleared: true });
});

// Update plan status (applied/cancelled)
app.patch('/api/ai/plan/:index', async (req, res) => {
    const { status } = req.body;
    const idx = parseInt(req.params.index, 10);
    const chatData = await chatStore.read();
    const planMessages = chatData.messages.filter(m => m.role === 'plan');
    // Find the plan message by its index among plan messages
    let planCount = 0;
    for (const msg of chatData.messages) {
        if (msg.role === 'plan') {
            if (planCount === idx) {
                msg.status = status;
                break;
            }
            planCount++;
        }
    }
    await chatStore.write(chatData);
    res.json({ updated: true });
});

// ============ Health Check ============

app.get('/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
});

// ============ Start ============

async function start() {
    initStores();
    if (isDbAvailable()) {
        await initDb();
        console.log('PostgreSQL connected and initialized');
    }
    app.listen(PORT, () => {
        console.log(`Anything Mini running at http://localhost:${PORT}`);
        console.log(`Storage mode: ${isDbAvailable() ? 'PostgreSQL' : 'JSON files'}`);
    });
}

start().catch(err => {
    console.error('Failed to start server:', err);
    process.exit(1);
});
