/**
 * PostgreSQL persistence layer for Anything Mini.
 * Uses single-row JSONB tables to replace JSON file stores.
 * Falls back to JSON files when DATABASE_URL is not set.
 */

const { Pool } = require('pg');

let pool = null;

function getPool() {
    if (!pool) {
        pool = new Pool({
            connectionString: process.env.DATABASE_URL,
            ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
            max: 5,
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 5000
        });
        pool.on('error', (err) => {
            console.error('Unexpected pool error:', err);
        });
    }
    return pool;
}

/**
 * Initialize the database: create the kv_store table if it doesn't exist.
 * All data domains share one table with a text key and JSONB value.
 */
async function initDb() {
    const db = getPool();
    await db.query(`
        CREATE TABLE IF NOT EXISTS kv_store (
            key TEXT PRIMARY KEY,
            value JSONB NOT NULL DEFAULT '{}',
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    console.log('Database initialized (kv_store table ready)');
}

/**
 * Create a database-backed store that mirrors the JSON file store interface.
 * Returns { read(), write(data) } — both async.
 *
 * @param {string} key — unique key in kv_store (e.g. 'items', 'timeline')
 * @param {Function|Object} defaultValue — default if no row exists
 */
function createDbStore(key, defaultValue) {
    const db = getPool();
    return {
        async read() {
            const result = await db.query(
                'SELECT value FROM kv_store WHERE key = $1',
                [key]
            );
            if (result.rows.length === 0) {
                return typeof defaultValue === 'function' ? defaultValue() : defaultValue;
            }
            return result.rows[0].value;
        },
        async write(data) {
            await db.query(
                `INSERT INTO kv_store (key, value, updated_at)
                 VALUES ($1, $2, NOW())
                 ON CONFLICT (key)
                 DO UPDATE SET value = $2, updated_at = NOW()`,
                [key, JSON.stringify(data)]
            );
        }
    };
}

/**
 * Check if PostgreSQL is available (DATABASE_URL is set).
 */
function isDbAvailable() {
    return !!process.env.DATABASE_URL;
}

module.exports = { initDb, createDbStore, isDbAvailable, getPool };
