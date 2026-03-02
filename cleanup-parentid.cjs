/**
 * One-off script to strip stale `parentId` properties from all items in the tree.
 * The AI copilot added these via Object.assign, but they don't do anything —
 * tree position (children arrays) is the source of truth.
 *
 * Usage: node cleanup-parentid.cjs
 */
require('dotenv').config();
const { initDb, createDbStore, isDbAvailable } = require('./db.cjs');
const fs = require('fs');

async function main() {
    let itemsStore;

    if (isDbAvailable()) {
        await initDb();
        itemsStore = createDbStore('items', () => ({ items: [], nextId: 1 }));
        console.log('Using PostgreSQL');
    } else {
        // JSON fallback
        const filePath = './data/items.json';
        if (!fs.existsSync(filePath)) {
            console.log('No items.json found');
            return;
        }
        itemsStore = {
            async read() { return JSON.parse(fs.readFileSync(filePath, 'utf8')); },
            async write(data) { fs.writeFileSync(filePath, JSON.stringify(data, null, 2)); }
        };
        console.log('Using JSON file');
    }

    const data = await itemsStore.read();
    let cleaned = 0;

    function cleanRecursive(items) {
        for (const item of items) {
            if ('parentId' in item) {
                delete item.parentId;
                cleaned++;
            }
            if (item.children) cleanRecursive(item.children);
        }
    }

    cleanRecursive(data.items || []);
    console.log(`Cleaned ${cleaned} stale parentId properties`);

    if (cleaned > 0) {
        await itemsStore.write(data);
        console.log('Saved cleaned data');
    } else {
        console.log('No stale parentId properties found');
    }
}

main().catch(err => { console.error(err); process.exit(1); });
