const { Client } = require('pg');

const schema = String(process.env.PG_TEST_SCHEMA || '').trim();
if (!/^[a-z_][a-z0-9_]{0,62}$/i.test(schema)) {
    throw new Error('PG_TEST_SCHEMA must be a safe PostgreSQL identifier');
}

async function withClient(callback) {
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    await client.query("SET timezone = 'Asia/Shanghai'");
    try { return await callback(client); } finally { await client.end(); }
}

async function setup() {
    await withClient(async client => {
        await client.query(`
            DO $$
            BEGIN
                IF EXISTS (
                    SELECT 1 FROM pg_extension e
                    JOIN pg_namespace n ON e.extnamespace = n.oid
                    WHERE e.extname = 'vector' AND n.nspname <> 'public'
                ) THEN
                    ALTER EXTENSION vector SET SCHEMA public;
                END IF;
                IF EXISTS (
                    SELECT 1 FROM pg_extension e
                    JOIN pg_namespace n ON e.extnamespace = n.oid
                    WHERE e.extname = 'pg_trgm' AND n.nspname <> 'public'
                ) THEN
                    ALTER EXTENSION pg_trgm SET SCHEMA public;
                END IF;
            END $$;
        `).catch(() => {});
        await client.query('CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public').catch(() => {});
        await client.query('CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public').catch(() => {});
        await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    });
    process.env.PG_TEST_SCHEMA = schema;
    const { initSchemaPg } = require('../server/db/schema');
    const { runMigrationsPg } = require('../server/db/migrate');
    const { runSeedsPg } = require('../server/db/seed');
    const { closePgPool } = require('../server/db/pg-connection');
    try {
        await initSchemaPg();
        await runMigrationsPg();
        await runSeedsPg();
    } finally {
        await closePgPool();
    }
}

async function cleanup() {
    await withClient(client => client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`));
}

(process.argv.includes('--cleanup') ? cleanup() : setup())
    .catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
