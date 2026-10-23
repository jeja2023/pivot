'use strict';
function postgresCommandEnv(connection, env = process.env) {
    const url = new URL(connection);
    if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('PostgreSQL 连接格式无效。');
    return { ...env, PGDATABASE: decodeURIComponent(url.pathname.slice(1)), PGHOST: url.hostname, PGPORT: url.port || '5432',
        PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password), PGCONNECT_TIMEOUT: '10',
        ...(url.searchParams.has('sslmode') ? { PGSSLMODE: url.searchParams.get('sslmode') } : {}) };
}
module.exports = { postgresCommandEnv };
