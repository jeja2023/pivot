const { Client } = require('pg');

async function fixOwnership() {
    const postgresUrl = 'postgresql://postgres:123456@localhost:5432/pivot';
    const client = new Client({ connectionString: postgresUrl });
    try {
        await client.connect();
        console.log('Connected to PostgreSQL as postgres superuser.');
        await client.query('GRANT ALL PRIVILEGES ON DATABASE pivot TO pivot;');
        await client.query('GRANT ALL PRIVILEGES ON SCHEMA public TO pivot;');
        await client.query('ALTER SCHEMA public OWNER TO pivot;');

        const tablesRes = await client.query(`
            SELECT tablename FROM pg_tables WHERE schemaname = 'public'
        `);
        for (const row of tablesRes.rows) {
            await client.query(`ALTER TABLE public."${row.tablename}" OWNER TO pivot;`);
        }
        console.log(`Transferred ${tablesRes.rows.length} tables to pivot user.`);

        const seqRes = await client.query(`
            SELECT sequencename FROM pg_sequences WHERE schemaname = 'public'
        `);
        for (const row of seqRes.rows) {
            await client.query(`ALTER SEQUENCE public."${row.sequencename}" OWNER TO pivot;`);
        }
        console.log(`Transferred ${seqRes.rows.length} sequences to pivot user.`);

        const fnRes = await client.query(`
            SELECT p.proname, pg_get_function_identity_arguments(p.oid) as args
            FROM pg_proc p
            JOIN pg_namespace n ON p.pronamespace = n.oid
            WHERE n.nspname = 'public'
        `);
        for (const row of fnRes.rows) {
            await client.query(`ALTER FUNCTION public."${row.proname}"(${row.args}) OWNER TO pivot;`);
        }
        console.log(`Transferred ${fnRes.rows.length} functions to pivot user.`);

        await client.query('GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO pivot;');
        await client.query('GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO pivot;');
        await client.query('GRANT ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public TO pivot;');
        await client.query('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO pivot;');
        await client.query('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO pivot;');
        await client.query('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO pivot;');
        console.log('PostgreSQL permissions and ownership fixed successfully!');
        await client.end();
    } catch (err) {
        console.error('Error fixing ownership:', err);
    }
}

fixOwnership();
