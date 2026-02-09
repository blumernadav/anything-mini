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
    const { name, parentId } = req.body;

    const newItem = {
        id: data.nextId++,
        name: name || 'New Item',
        children: [],
        expanded: false,
        createdAt: Date.now(),
        done: false
    };

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

// ============ Start ============

app.listen(PORT, () => {
    console.log(`Anything Mini running at http://localhost:${PORT}`);
});
