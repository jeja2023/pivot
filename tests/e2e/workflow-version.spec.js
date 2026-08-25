const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('@playwright/test');

function initialAdminPassword() {
    if (String(process.env.DEFAULT_ADMIN_PASSWORD || '').trim()) {
        return String(process.env.DEFAULT_ADMIN_PASSWORD).trim();
    }
    if (String(process.env.PIVOT_E2E_ADMIN_PASSWORD || '').trim()) {
        return String(process.env.PIVOT_E2E_ADMIN_PASSWORD).trim();
    }
    const dataDir = process.env.DATA_DIR || path.resolve(__dirname, '..', '..', 'data');
    const credentialFile = path.join(dataDir, 'initial-admin-password.txt');
    const content = fs.readFileSync(credentialFile, 'utf8');
    const match = content.match(/^password=(.*)$/m);
    if (!match?.[1]) throw new Error(`E2E admin credential file has no password: ${credentialFile}`);
    return match[1].trim();
}

async function login(api, username, password) {
    const response = await api.post('/api/auth/login', {
        data: { username, password }
    });
    assert.equal(response.status(), 200, await response.text());
    const cookies = response.headersArray()
        .filter(item => item.name.toLowerCase() === 'set-cookie')
        .map(item => item.value);
    const access = cookies.map(item => item.match(/(?:^|;)\s*pivot_access_token=([^;]+)/))
        .find(Boolean);
    assert.ok(access?.[1], 'login response should set pivot_access_token');
    return decodeURIComponent(access[1]);
}

async function call(api, method, url, token, data) {
    const response = await api[method](url, {
        headers: { Authorization: `Bearer ${token}` },
        ...(data === undefined ? {} : { data })
    });
    const body = await response.json().catch(() => ({}));
    return { response, body };
}

test('receiver dependency mapping becomes stale after a newly published workflow version', async ({ request }) => {
    const adminToken = await login(request, 'admin', initialAdminPassword());
    const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const receiverUsername = `e2e_receiver_${suffix}`;
    const receiverPassword = 'Receiver123';
    let receiverId = null;
    let workflowId = null;
    let credentialId = null;
    let receiverToken = null;

    try {
        const createdUser = await call(request, 'post', '/api/admin/users', adminToken, {
            username: receiverUsername,
            password: receiverPassword,
            nickname: 'E2E Receiver',
            unit: 'QA',
            role: 'user'
        });
        assert.equal(createdUser.response.status(), 200, JSON.stringify(createdUser.body));
        receiverId = Number(createdUser.body.user.id);
        assert.ok(receiverId > 0);
        receiverToken = await login(request, receiverUsername, receiverPassword);

        const credential = await call(request, 'post', '/api/agents/credentials', receiverToken, {
            name: 'E2E receiver credential',
            slug: `E2E_RECEIVER_${suffix.toUpperCase()}`,
            secretValue: 'e2e-secret-value'
        });
        assert.equal(credential.response.status(), 201, JSON.stringify(credential.body));
        credentialId = Number(credential.body.credential.id);
        assert.ok(credentialId > 0);

        const workflow = await call(request, 'post', '/api/agents/workflows', adminToken, {
            name: `E2E stale workflow ${suffix}`,
            description: 'version one',
            scope: 'shared',
            allowedUserIds: [receiverId],
            dagSpec: {
                nodes: [{
                    id: 'http',
                    title: 'Webhook',
                    tool: 'agent.http',
                    input: {
                        url: 'https://example.com/health',
                        method: 'GET',
                        credentialSecret: 'OWNER_CREDENTIAL'
                    }
                }]
            }
        });
        assert.equal(workflow.response.status(), 201, JSON.stringify(workflow.body));
        workflowId = Number(workflow.body.workflow.id);
        assert.ok(workflowId > 0);

        const firstPublish = await call(request, 'post', `/api/agents/workflows/${workflowId}/publish`, adminToken, {
            version: 'current', fixedEvaluationRequired: false
        });
        assert.equal(firstPublish.response.status(), 200, JSON.stringify(firstPublish.body));

        const initialDependencies = await call(request, 'get', `/api/agents/workflows/${workflowId}/dependencies`, receiverToken);
        assert.equal(initialDependencies.response.status(), 200, JSON.stringify(initialDependencies.body));
        assert.equal(initialDependencies.body.stale, false);
        assert.equal(initialDependencies.body.status, 'blocked');

        const savedDependencies = await call(request, 'put', `/api/agents/workflows/${workflowId}/dependencies`, receiverToken, {
            bindings: {
                models: {},
                tools: {},
                credentials: { OWNER_CREDENTIAL: String(credentialId) }
            }
        });
        assert.equal(savedDependencies.response.status(), 200, JSON.stringify(savedDependencies.body));
        assert.equal(savedDependencies.body.status, 'ready');
        assert.equal(savedDependencies.body.stale, false);

        const updatedWorkflow = await call(request, 'put', `/api/agents/workflows/${workflowId}`, adminToken, {
            name: `E2E stale workflow ${suffix}`,
            description: 'version two',
            dagSpec: {
                nodes: [{
                    id: 'http',
                    title: 'Webhook v2',
                    tool: 'agent.http',
                    input: {
                        url: 'https://example.com/health',
                        method: 'GET',
                        credentialSecret: 'OWNER_CREDENTIAL'
                    }
                }]
            }
        });
        assert.equal(updatedWorkflow.response.status(), 200, JSON.stringify(updatedWorkflow.body));
        assert.equal(Number(updatedWorkflow.body.workflow.current_version), 2);

        const secondPublish = await call(request, 'post', `/api/agents/workflows/${workflowId}/publish`, adminToken, {
            version: 'current', fixedEvaluationRequired: false
        });
        assert.equal(secondPublish.response.status(), 200, JSON.stringify(secondPublish.body));
        assert.equal(Number(secondPublish.body.workflow.published_version), 2);

        const staleDependencies = await call(request, 'get', `/api/agents/workflows/${workflowId}/dependencies`, receiverToken);
        assert.equal(staleDependencies.response.status(), 200, JSON.stringify(staleDependencies.body));
        assert.equal(staleDependencies.body.stale, true);
        assert.equal(staleDependencies.body.status, 'blocked');
        assert.notEqual(Number(staleDependencies.body.bound_version_id), Number(staleDependencies.body.version_id));
    } finally {
        if (workflowId) await call(request, 'delete', `/api/agents/workflows/${workflowId}`, adminToken);
        if (credentialId && receiverToken) await call(request, 'delete', `/api/agents/credentials/${credentialId}`, receiverToken);
        if (receiverId) await call(request, 'delete', `/api/admin/users/${receiverId}`, adminToken);
    }
});
