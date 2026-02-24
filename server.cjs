require('dotenv').config();
const express = require('express');
const fs = require('fs');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = 3002;

// Generic JSON file store factory (same pattern as anything-5.0)
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

// Data stores
const itemsStore = createJsonStore('./data/items.json', () => ({
    items: [],
    nextId: 1
}));


const timelineStore = createJsonStore('./data/timeline.json', () => ({
    entries: [],
    nextId: 1
}));

const settingsStore = createJsonStore('./data/settings.json', () => ({
    dayStartHour: 8,
    dayStartMinute: 0,
    dayEndHour: 22,
    dayEndMinute: 0
}));

const chatStore = createJsonStore('./data/ai_chat.json', () => ({
    messages: []
}));

// Ensure data directory exists
if (!fs.existsSync('./data')) {
    fs.mkdirSync('./data', { recursive: true });
}

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('.'));

// ============ Items API (unified tree) ============

app.get('/api/items', (req, res) => {
    res.json(itemsStore.read());
});

// Add a new item (optionally under a parent)
app.post('/api/items', (req, res) => {
    const data = itemsStore.read();
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

    itemsStore.write(data);
    res.status(201).json(newItem);
});

app.patch('/api/items/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    const updates = req.body;
    const data = itemsStore.read();

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

    itemsStore.write(data);
    res.json(updated);
});

app.delete('/api/items/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    const data = itemsStore.read();

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

    itemsStore.write(data);
    res.json({ message: 'Deleted' });
});

// Bulk save the full items tree (for expanded state, reordering, etc.)
app.put('/api/items', (req, res) => {
    itemsStore.write(req.body);
    res.json(req.body);
});

// ============ Timeline API ============

app.get('/api/timeline', (req, res) => {
    res.json(timelineStore.read());
});

app.post('/api/timeline', (req, res) => {
    const data = timelineStore.read();
    const entry = {
        ...req.body,
        id: data.nextId++,
        timestamp: req.body.startTime || Date.now()
    };
    data.entries.push(entry);
    timelineStore.write(data);
    res.status(201).json(entry);
});

app.patch('/api/timeline/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    const updates = req.body;
    const data = timelineStore.read();
    const entry = data.entries.find(e => e.id === id);
    if (!entry) return res.status(404).json({ error: 'Timeline entry not found' });

    Object.assign(entry, updates);
    // Keep timestamp in sync with startTime if startTime was updated
    if (updates.startTime !== undefined) {
        entry.timestamp = updates.startTime;
    }
    timelineStore.write(data);
    res.json(entry);
});

app.delete('/api/timeline/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    const data = timelineStore.read();
    const idx = data.entries.findIndex(e => e.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Timeline entry not found' });

    data.entries.splice(idx, 1);
    timelineStore.write(data);
    res.json({ message: 'Deleted' });
});

// ============ Settings API ============

app.get('/api/settings', (req, res) => {
    res.json(settingsStore.read());
});

app.put('/api/settings', (req, res) => {
    const current = settingsStore.read();
    const updated = { ...current, ...req.body };
    settingsStore.write(updated);
    res.json(updated);
});

// ============ Preferences API ============

const preferencesStore = createJsonStore('./data/preferences.json', () => ({}));

app.get('/api/preferences', (req, res) => {
    res.json(preferencesStore.read());
});

app.put('/api/preferences', (req, res) => {
    const current = preferencesStore.read();
    const updated = { ...current, ...req.body };
    preferencesStore.write(updated);
    res.json(updated);
});

// ============ AI Copilot API ============

const { chat: aiChat, executeAndContinue } = require('./ai/executor.cjs');

app.post('/api/ai/chat', async (req, res) => {
    try {
        const { message, writeMode } = req.body;
        if (!message) return res.status(400).json({ error: 'Message is required' });

        // Load persisted history, send last 50 as context
        const chatData = chatStore.read();
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

        const result = await aiChat(message, recentHistory, writeMode || false);

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

        chatStore.write(chatData);
        res.json(result);
    } catch (err) {
        console.error('AI chat error:', err);
        res.status(500).json({ error: err.message || 'AI request failed' });
    }
});

app.post('/api/ai/execute', async (req, res) => {
    try {
        const { toolCalls } = req.body;
        if (!toolCalls || !Array.isArray(toolCalls)) {
            return res.status(400).json({ error: 'toolCalls array is required' });
        }

        // Load chat history for continuation context
        const chatData = chatStore.read();
        const recentHistory = chatData.messages
            .filter(m => m.role === 'user' || m.role === 'assistant')
            .slice(-50)
            .map(m => ({ role: m.role, content: m.content }));

        const { results, summary } = await executeAndContinue(toolCalls, recentHistory);

        // Persist AI summary from continuation if any
        if (summary) {
            chatData.messages.push({
                role: 'assistant',
                content: summary,
                timestamp: Date.now()
            });
            chatStore.write(chatData);
        }

        res.json({ results, summary });
    } catch (err) {
        console.error('AI execute error:', err);
        res.status(500).json({ error: err.message || 'Execution failed' });
    }
});

app.get('/api/ai/config', (req, res) => {
    const settings = settingsStore.read();
    const provider = settings.aiProvider || process.env.AI_PROVIDER || 'gemini';
    const model = settings.aiModel || process.env.AI_MODEL || 'gemini-2.0-flash';
    const hasKey = !!(settings.aiApiKey || process.env.AI_API_KEY);
    res.json({ provider, model, available: hasKey });
});

// Chat history
app.get('/api/ai/history', (req, res) => {
    const chatData = chatStore.read();
    res.json(chatData);
});

app.delete('/api/ai/history', (req, res) => {
    chatStore.write({ messages: [] });
    res.json({ cleared: true });
});

// Update plan status (applied/cancelled)
app.patch('/api/ai/plan/:index', (req, res) => {
    const { status } = req.body;
    const idx = parseInt(req.params.index, 10);
    const chatData = chatStore.read();
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
    chatStore.write(chatData);
    res.json({ updated: true });
});

// ============ Start ============

app.listen(PORT, () => {
    console.log(`Anything Mini running at http://localhost:${PORT}`);
});
