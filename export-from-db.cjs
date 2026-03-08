/**
 * One-time export: reads all data from PostgreSQL kv_store and writes
 * it to local data/*.json files — the reverse of migrate-to-db.cjs.
 *
 * Usage: node export-from-db.cjs
 */

require('dotenv').config();
const fs = require('fs');
const { initDb, createDbStore, isDbAvailable, getPool } = require('./db.cjs');

const FILES = {
    items: { path: './data/items.json', default: { items: [], nextId: 1 } },
    timeline: { path: './data/timeline.json', default: { entries: [], nextId: 1 } },
    settings: { path: './data/settings.json', default: {} },
    ai_chat: { path: './data/ai_chat.json', default: { messages: [] } },
    preferences: { path: './data/preferences.json', default: {} },
};

async function exportFromDb() {
    if (!isDbAvailable()) {
        console.error('ERROR: DATABASE_URL is not set.');
        process.exit(1);
    }

    await initDb();
    console.log('Connected to database.\n');

    if (!fs.existsSync('./data')) fs.mkdirSync('./data', { recursive: true });

    for (const [key, config] of Object.entries(FILES)) {
        try {
            const store = createDbStore(key, config.default);
            const data = await store.read();
            const json = JSON.stringify(data, null, 2);
            const sizeKB = (Buffer.byteLength(json, 'utf8') / 1024).toFixed(1);

            // Back up existing local file if it exists
            if (fs.existsSync(config.path)) {
                fs.copyFileSync(config.path, config.path + '.bak');
                console.log(`  📦 Backed up existing ${config.path} → ${config.path}.bak`);
            }

            fs.writeFileSync(config.path, json);
            console.log(`✅ ${key}: exported (${sizeKB} KB) → ${config.path}`);
        } catch (err) {
            console.error(`❌ ${key}: Failed — ${err.message}`);
        }
    }

    console.log('\n✅ Export complete! You can now remove DATABASE_URL from .env to run locally.');
    const pool = getPool();
    await pool.end();
}

exportFromDb().catch(err => {
    console.error('Export failed:', err);
    process.exit(1);
});
