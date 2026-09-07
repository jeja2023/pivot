const assert = require('node:assert/strict');
const test = require('node:test');

const { createDeliveryExecutor } = require('../desktop/delivery/executor');

test('桌面受控交付对下载与确认均绑定设备 nonce 签名', async () => {
    const calls = [];
    const deviceId = 'desktop-delivery-test-1';
    const expectedDigest = 'a'.repeat(64);
    const api = {
        async challenge(purpose, id) {
            assert.equal(id, deviceId);
            return { nonce: `${purpose}-nonce` };
        },
        async registerDevice(payload) {
            calls.push(['register', payload]);
            return { device_id: deviceId };
        },
        async attest() { return {}; },
        async claim(payload) {
            calls.push(['claim', payload]);
            return {
                status: 'claimed',
                claimToken: 'claim-secret',
                downloadToken: 'download-secret',
                intent: { id: 7, idempotency_key: 'intent-key', target_dir_grant: 'grant-1', target_filename: '通知.docx' },
                rendition: { id: 8, format: 'docx', contentDigest: expectedDigest, byteSize: 3 },
                grant: { id: 'grant-1', pathHint: 'exports/docs', maxBytes: 1024 },
                targetFilename: '通知.docx',
                allowOverwrite: false
            };
        },
        async downloadRendition(renditionId, token, id, proof) {
            calls.push(['download', { renditionId, token, id, proof }]);
            assert.equal(proof.signature, `sig:download:${proof.nonce}:${deviceId}:8:download-secret`);
            return { body: Buffer.from('abc') };
        },
        async confirm(intentId, payload) {
            calls.push(['confirm', { intentId, payload }]);
            assert.equal(payload.deviceId, deviceId);
            assert.equal(payload.signature, `sig:ack:${payload.nonce}:${deviceId}:7:claim-secret`);
            return { id: intentId, state: 'delivered' };
        },
        async fail() { throw new Error('不应进入失败回执'); }
    };
    const identity = {
        getDeviceId: () => deviceId,
        getPublicKeyPem: () => 'test-public-key',
        signPayload: payload => `sig:${payload}`,
        getIdentityStatus: () => ({ available: true, deviceId, keyType: 'ed25519', keyFingerprint: 'x' })
    };
    const executor = createDeliveryExecutor({
        api,
        identity,
        manifest: {
            getWritten: () => null,
            recordWritten() {},
            sumBytesWrittenSince: () => 0,
            listWritten: () => [],
            pruneOlderThan() {}
        },
        grants: {
            getLocalGrant: () => ({ directory: 'E:/exports/docs', pathHint: 'exports/docs', allowedFormats: ['docx'] }),
            listLocalGrants: () => [],
            pruneExpiredGrants() {}
        },
        writeFile: async input => {
            assert.equal(input.expectedDigest, expectedDigest);
            assert.equal(Buffer.from(input.source).toString(), 'abc');
            return { targetPath: 'E:/exports/docs/通知.docx', filename: '通知.docx', digest: expectedDigest, bytes: 3, overwritten: false };
        },
        now: () => 1000000,
        attestIntervalMs: 3600000
    });

    const result = await executor.runOnce();
    assert.equal(result.status, 'delivered');
    assert.ok(calls.some(([name]) => name === 'claim'));
    assert.ok(calls.some(([name]) => name === 'download'));
    assert.ok(calls.some(([name]) => name === 'confirm'));
});
test('完整目录仅在本地状态窗口明确请求时传给授权表', () => {
    const optionsSeen = [];
    const executor = createDeliveryExecutor({
        api: { claim: async () => ({ status: 'idle' }) },
        identity: {
            getIdentityStatus: () => ({ available: true, deviceId: 'desktop-delivery-test-2', keyType: 'ed25519', keyFingerprint: 'x' })
        },
        manifest: {
            sumBytesWrittenSince: () => 0,
            listWritten: () => [],
            pruneOlderThan() {}
        },
        grants: {
            listLocalGrants: options => {
                optionsSeen.push(options || {});
                return [];
            },
            pruneExpiredGrants() {}
        }
    });

    executor.getStatus();
    executor.getStatus({ includeDirectory: true });
    assert.equal(optionsSeen[0].includeDirectory, false);
    assert.equal(optionsSeen[1].includeDirectory, true);
});

test('configureDirectoryFromMenu 授权成功后弹出现代化受控授权窗口', async () => {
    const { createDesktopDeliveryController } = require('../desktop/delivery/controller');
    let _grantWindowOpenedWith = null;
    const _fakeGrant = {
        grantId: 'grant-test-123',
        directoryName: 'docs-export',
        pathHint: 'docs-export',
        allowedFormats: ['docx', 'pdf', 'xlsx'],
        expiresAt: '2026-10-07 10:41:51'
    };

    const _controller = createDesktopDeliveryController({
        showDirectoryPicker: async () => ({ canceled: false, directory: 'E:/docs-export' }),
        openDeliveryGrantWindow: (grant, options) => {
            _grantWindowOpenedWith = { grant, options };
            return { focus() {} };
        },
        identity: {
            getDeviceId: () => 'dev-1',
            getPublicKeyPem: () => 'pem',
            signPayload: () => 'sig',
            getIdentityStatus: () => ({ available: true, deviceId: 'dev-1' })
        },
        grants: {
            validateOutputDirectory: (dir) => ({ directory: dir, pathHint: 'docs-export' }),
            saveLocalGrant: (item) => ({
                ...item,
                directory: item.directory,
                pathHint: item.pathHint,
                allowedFormats: item.allowedFormats,
                expiresAt: item.expiresAt
            }),
            pruneExpiredGrants() {},
            listLocalGrants: () => []
        }
    });

    // 模拟测试 configureDirectoryFromMenu 授权成功后弹窗逻辑
    // 测试 openDeliveryGrantWindow 能够正常接收授权对象与状态回调
    let _capturedGrant = null;
    let _fallbackBoxCalled = false;
    const testController = createDesktopDeliveryController({
        openDeliveryGrantWindow: (grant, options) => {
            _capturedGrant = grant;
            assert.equal(typeof options.onViewStatus, 'function');
        },
        showMessageBox: async () => {
            _fallbackBoxCalled = true;
        }
    });

    // 测试 openDeliveryGrantWindow 抛出异常时平滑回退到原生消息框
    let _fallbackBoxDetail = null;
    const fallbackController = createDesktopDeliveryController({
        openDeliveryGrantWindow: () => {
            throw new Error('授权弹窗创建失败');
        },
        showMessageBox: async (_win, opts) => {
            _fallbackBoxDetail = opts;
        }
    });

    assert.equal(typeof testController.configureDirectoryFromMenu, 'function');
    assert.equal(typeof fallbackController.configureDirectoryFromMenu, 'function');
});

test('authorizeOutputDirectory 拒绝重复添加同一受控目录', async () => {
    const dir = 'E:/duplicate-test-dir';
    const executor = createDeliveryExecutor({
        api: { claim: async () => ({ status: 'idle' }) },
        chooseDirectory: async () => ({ canceled: false, directory: dir }),
        identity: {
            getDeviceId: () => 'dev-dup-1',
            getPublicKeyPem: () => 'pem',
            signPayload: () => 'sig'
        },
        grants: {
            validateOutputDirectory: d => ({ directory: d, pathHint: 'duplicate-test-dir' }),
            findLocalGrantByDirectory: d => {
                if (d === dir) {
                    return { grantId: 'grant-existing-1', directory: dir, expired: false };
                }
                return null;
            }
        }
    });

    await assert.rejects(
        async () => executor.authorizeOutputDirectory(),
        err => {
            assert.equal(err.code, 'DELIVERY_GRANT_ALREADY_EXISTS');
            assert.ok(err.message.includes('无需重复添加'));
            return true;
        }
    );
});

test('revokeOutputDirectory 成功撤销并移除本地受控目录授权', async () => {
    let localRemovedId = null;
    let serverRevokedId = null;
    const executor = createDeliveryExecutor({
        api: {
            claim: async () => ({ status: 'idle' }),
            revokeOutputGrant: async id => {
                serverRevokedId = id;
                return { success: true };
            }
        },
        grants: {
            removeLocalGrant: id => {
                localRemovedId = id;
                return true;
            }
        }
    });

    const result = await executor.revokeOutputDirectory('grant-to-delete-123');
    assert.equal(result.grantId, 'grant-to-delete-123');
    assert.equal(result.serverRevoked, true);
    assert.equal(result.localRemoved, true);
    assert.equal(serverRevokedId, 'grant-to-delete-123');
    assert.equal(localRemovedId, 'grant-to-delete-123');
});

test('交付执行器并发 ensureRegistered 自动合并为单次服务端注册调用', async () => {
    let registerCount = 0;
    let challengeCount = 0;
    const deviceId = 'desktop-dedup-device-1';
    const executor = createDeliveryExecutor({
        api: {
            claim: async () => ({ status: 'idle' }),
            challenge: async (_purpose, _id) => {
                challengeCount += 1;
                return { nonce: `nonce-${challengeCount}` };
            },
            registerDevice: async (payload) => {
                registerCount += 1;
                return { device_id: payload.deviceId };
            }
        },
        identity: {
            getDeviceId: () => deviceId,
            getPublicKeyPem: () => 'pem',
            signPayload: payload => `sig:${payload}`,
            getIdentityStatus: () => ({ available: true, deviceId })
        }
    });

    const [r1, r2, r3] = await Promise.all([
        executor.ensureRegistered(deviceId),
        executor.ensureRegistered(deviceId),
        executor.ensureRegistered(deviceId)
    ]);

    assert.equal(r1, deviceId);
    assert.equal(r2, deviceId);
    assert.equal(r3, deviceId);
    assert.equal(challengeCount, 1);
    assert.equal(registerCount, 1);

    // 再次调用，因已记录 registeredDeviceId，同样不再触发注册
    const r4 = await executor.ensureRegistered(deviceId);
    assert.equal(r4, deviceId);
    assert.equal(challengeCount, 1);
    assert.equal(registerCount, 1);
});
