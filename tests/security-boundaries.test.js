const test = require('node:test');
const assert = require('node:assert/strict');

const security = require('../server/security');
const {
    assertReadonlySql,
    applySqlLimit
} = require('../server/services/database-mcp/sql-governance');
const {
    assertSafeDatabaseHost
} = require('../server/services/database-mcp/connection-policy');
const {
    validateDatabaseConnectionPayload,
    assertDatabaseConnectionSharingPolicy
} = require('../server/services/database-mcp');
const {
    getPermissionTier,
    hasPermissionCapability,
    requireCapability
} = require('../server/permissions');
const { normalizeDagNodePolicy } = require('../server/services/agent-dag-utils');

test('SQL read-only governance rejects write-like clauses and side-effect functions', () => {
    const blocked = [
        'SELECT id INTO copied_users FROM users',
        "SELECT * FROM users INTO OUTFILE '/tmp/users.csv'",
        "SELECT pg_read_file('/etc/hosts')",
        "SELECT setval('users_id_seq', 99)",
        'SELECT * FROM users FOR UPDATE',
        'SELECT pg_sleep(5)'
    ];
    for (const sql of blocked) {
        assert.throws(() => assertReadonlySql(sql), /只读|写入|管理/);
    }
    assert.equal(assertReadonlySql("SELECT 'into' AS value"), "SELECT 'into' AS value");
});

test('new secret envelopes bind their ciphertext to a context and reject ciphertext input', () => {
    const plain = 'context-bound-secret';
    const envelope = security.encryptSecret(plain, 'models.api_key');
    assert.match(envelope, /^enc:v2:/);
    assert.equal(security.decryptSecret(envelope, 'models.api_key'), plain);
    assert.throws(() => security.decryptSecret(envelope, 'mcp_servers.api_key'), /密钥解密失败/);
    assert.throws(() => security.encryptSecret(envelope), error => error.code === 'ENCRYPTED_SECRET_INPUT_REJECTED');
    assert.equal(security.preserveEncryptedSecret(envelope, 'mcp_servers.api_key'), envelope);
});

test('audit details redact nested secrets, bearer tokens and query credentials', () => {
    const details = security.redactAuditDetails({
        url: '/api/test?access_token=secret-value&ok=1',
        authorization: 'Bearer very-long-token-value-123456789',
        nested: { api_key: 'plain-api-key' },
        message: 'enc:v2:abc.def.ghi'
    });
    assert.doesNotMatch(details, /secret-value|plain-api-key|abc\.def\.ghi/);
    assert.match(details, /REDACTED/);
});

test('SQL row limits clamp user-supplied LIMIT instead of trusting it', () => {
    assert.equal(
        applySqlLimit('SELECT * FROM users LIMIT 999999999', 101, 'postgres'),
        'SELECT * FROM users LIMIT 101'
    );
    assert.equal(
        applySqlLimit('SELECT * FROM users LIMIT 999999999 OFFSET 10', 101, 'mysql'),
        'SELECT * FROM users LIMIT 101 OFFSET 10'
    );
    assert.equal(
        applySqlLimit('SELECT * FROM users', 101, 'sqlserver'),
        'SELECT TOP (101) * FROM users'
    );
});

test('IPv6 policy classifies equivalent loopback and private forms by address value', () => {
    const loopbacks = ['::1', '0:0:0:0:0:0:0:1', '0::1', '::0:0:1'];
    const privateHosts = ['::', 'fc00::1', 'fd00::1', 'fe90::1', '::ffff:192.168.1.1'];
    for (const host of loopbacks) {
        assert.equal(security.isPrivateHost(host), true, host);
        assert.equal(security.isLoopbackHost(host), true, host);
    }
    for (const host of privateHosts) {
        assert.equal(security.isPrivateHost(host), true, host);
    }
    assert.equal(security.isPrivateHost('2001:db8::1'), false);
});

test('database host validation rejects paths, bracketed IPv6 and host:port forms', () => {
    const invalidHosts = ['/var/run/postgresql', '[::1]', 'db.internal:5432', 'db internal'];
    for (const host of invalidHosts) {
        assert.throws(
            () => validateDatabaseConnectionPayload({ database_type: 'postgres', host, database_name: 'pivot', username: 'reader' }, { role: 'admin', username: 'admin' }),
            error => error.code === 'DB_HOST_INVALID'
        );
    }
});

test('shared database connections require an explicit table allowlist', () => {
    const connection = validateDatabaseConnectionPayload({
        database_type: 'postgres',
        host: 'db.internal',
        database_name: 'pivot',
        username: 'reader',
        table_allowlist: []
    }, { role: 'admin', username: 'admin' });
    assert.throws(
        () => assertDatabaseConnectionSharingPolicy(connection, { shared: true }),
        error => error.code === 'DB_SHARED_TABLE_ALLOWLIST_REQUIRED' && error.status === 400
    );
    const governed = validateDatabaseConnectionPayload({
        database_type: 'postgres',
        host: 'db.internal',
        database_name: 'pivot',
        username: 'reader',
        table_allowlist: ['users']
    }, { role: 'admin', username: 'admin' });
    assert.doesNotThrow(() => assertDatabaseConnectionSharingPolicy(governed, { shared: true }));
});

test('ordinary users cannot pass expanded IPv6 loopback to database connection checks', async () => {
    const previous = process.env.MCP_RESTRICT_PRIVATE_DATABASE_HOSTS_TO_ADMIN;
    process.env.MCP_RESTRICT_PRIVATE_DATABASE_HOSTS_TO_ADMIN = 'true';
    try {
        await assert.rejects(
            assertSafeDatabaseHost('0:0:0:0:0:0:0:1', { id: 7, role: 'user', username: 'user' }),
            error => error.code === 'MCP_PRIVATE_HOST_RESTRICTED' && error.status === 403
        );
    } finally {
        if (previous === undefined) delete process.env.MCP_RESTRICT_PRIVATE_DATABASE_HOSTS_TO_ADMIN;
        else process.env.MCP_RESTRICT_PRIVATE_DATABASE_HOSTS_TO_ADMIN = previous;
    }
});

test('capability middleware denies manager access to global settings and audit export', () => {
    const manager = { id: 2, username: 'ops_admin', role: 'admin' };
    assert.equal(getPermissionTier(manager), 'manager');
    assert.equal(hasPermissionCapability(manager, 'manageGlobalSettings'), false);
    assert.equal(hasPermissionCapability(manager, 'exportAudit'), false);

    const denied = requireCapability('exportAudit');
    const response = {
        statusCode: 200,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; }
    };
    denied({ user: manager }, response, () => { throw new Error('管理员应当被拒绝访问'); });
    assert.equal(response.statusCode, 403);
    assert.equal(response.body.code, 'PERMISSION_CAPABILITY_REQUIRED');
});

test('DAG policy disables automatic retries for non-idempotent side effects', () => {
    const node = { retryLimit: 3, timeoutMs: 1000, onError: 'stop' };
    const run = { tool_timeout_ms: 1000 };
    assert.equal(normalizeDagNodePolicy(node, run, 30000, { side_effect: true, idempotent: false }).retryLimit, 0);
    assert.equal(normalizeDagNodePolicy(node, run, 30000, { side_effect: false, idempotent: true }).retryLimit, 3);
});

test('DAG execution records the actual scoped approval state before a tool can run', () => {
    const { resolveDagToolApproval, stableDagOperationKey } = require('../server/services/agent-dag-approval');
    const calls = [];
    const result = resolveDagToolApproval({
        run: { id: 'run-1' },
        node: { id: 'node-1', tool: 'database.insert' },
        selectedTool: { name: 'database.insert' },
        input: { value: 7 },
        isApprovalGranted(...args) { calls.push(args); return false; }
    });
    assert.equal(result.approvalKey, 'database.insert:node-1');
    assert.equal(result.approvalGranted, false);
    assert.deepEqual(calls[0], [{ id: 'run-1' }, 'database.insert', 'database.insert:node-1', { value: 7 }]);
    assert.equal(resolveDagToolApproval({ node: { id: 'node-2', tool: 'filesystem.read' }, input: {} }).approvalGranted, false);
    const stableKey = stableDagOperationKey({ id: 'run-1' }, { id: 'node-1' }, { value: 7 });
    assert.equal(stableKey, stableDagOperationKey({ id: 'run-1' }, { id: 'node-1' }, { value: 7 }));
    assert.notEqual(stableKey, stableDagOperationKey({ id: 'run-1' }, { id: 'node-1' }, { value: 8 }));
    assert.doesNotMatch(stableKey, /:1$|:2$/);
});
