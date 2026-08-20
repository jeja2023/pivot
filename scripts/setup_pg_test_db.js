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
    await withClient(client => client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`));
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
    // SQLite's FTS virtual tables are represented as read-only views in the
    // isolated PG schema so legacy fixture assertions can inspect row counts.
    await withClient(async client => {
        await client.query(`SET search_path TO "${schema}", public`);
        await client.query(`
            CREATE OR REPLACE VIEW knowledge_chunks_fts AS
            SELECT id AS rowid, id, COALESCE(search_content, content, '') AS content
            FROM knowledge_chunks
        `);
        await client.query(`
            CREATE OR REPLACE VIEW messages_fts AS
            SELECT id AS rowid, id, COALESCE(content, '') AS content
            FROM messages
        `);
    });
}

async function cleanup() {
    await withClient(client => client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`));
}

(process.argv.includes('--cleanup') ? cleanup() : setup())
    .catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
