/**
 * One-time migration: reads existing JSON files from data/ and writes them
 * into the PostgreSQL kv_store table.
 *
 * Usage: DATABASE_URL=postgres://... node migrate-to-db.cjs
 */

require('dotenv').config();
const fs = require('fs');
const { initDb, createDbStore, isDbAvailable, getPool } = require('./db.cjs');

const FILES = {
    items: { path: './data/items.json', default: { items: [], nextId: 1 } },
    timeline: { path: './data/timeline.json', default: { entries: [], nextId: 1 } },
    settings: { path: './data/settings.json', default: { dayStartHour: 8, dayStartMinute: 0, dayEndHour: 22, dayEndMinute: 0 } },
    ai_chat: { path: './data/ai_chat.json', default: { messages: [] } },
    preferences: { path: './data/preferences.json', default: {} }
};

async function migrate() {
    if (!isDbAvailable()) {
        console.error('ERROR: DATABASE_URL is not set. Cannot migrate without a database connection.');
        console.error('Usage: DATABASE_URL=postgres://user:pass@host:port/db node migrate-to-db.cjs');
        process.exit(1);
    }

    await initDb();
    console.log('Database initialized.\n');

    for (const [key, config] of Object.entries(FILES)) {
        const store = createDbStore(key, config.default);

        if (!fs.existsSync(config.path)) {
            console.log(`⏭️  ${key}: No local file found at ${config.path}, skipping.`);
            continue;
        }

        try {
            const raw = fs.readFileSync(config.path, 'utf8');
            const data = JSON.parse(raw);
            const sizeKB = (Buffer.byteLength(raw, 'utf8') / 1024).toFixed(1);

            await store.write(data);
            console.log(`✅ ${key}: Migrated (${sizeKB} KB)`);
        } catch (err) {
            console.error(`❌ ${key}: Failed to migrate — ${err.message}`);
        }
    }

    console.log('\nMigration complete!');

    // Close the pool
    const pool = getPool();
    await pool.end();
}

migrate().catch(err => {
    console.error('Migration failed:', err);
    process.exit(1);
});
