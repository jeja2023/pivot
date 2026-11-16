'use strict';
const crypto = require('node:crypto');
const repository = require('../repositories/web-local-helper');
const devices = require('./agent-local-devices');
const { assertTenantContext } = require('./agent-tenant-context');
const { helperBrowserKey } = require('./helper-browser-key');
const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const error = (message, status = 403) => Object.assign(new Error(message), { code: 'LOCAL_HELPER_FORBIDDEN', status, expose: true });
function id(value) { if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(String(value))) throw error('助手配对标识无效。',400); return value; }
function bearer(req) { const value = String(req.headers.authorization || ''); if (!/^Bearer [A-Za-z0-9_-]{32,128}$/.test(value)) throw error('缺少有效助手凭据。'); return value.slice(7); }
async function create(user, req) {
    await repository.prune();
    const browserKey = helperBrowserKey(req,user); if (!browserKey) throw error('请在浏览器重新登录后配对。');
    const tenant = await assertTenantContext(user), code = crypto.randomBytes(24).toString('base64url'), binding = crypto.randomBytes(32).toString('base64url');
    const value = { id: crypto.randomUUID(), userId: user.id, tenantId: tenant.tenantId, browserKey, bindingHash: hash(binding), codeHash: hash(code), nonce: crypto.randomBytes(32).toString('hex'), tokenVersion: Number(user.token_version || 0) };
    await repository.revoke(user.id,{browserKey});
    let row;
    try { row = await repository.create(value); } catch (cause) { if (cause.code === '23505') throw error('已有配对请求正在处理，请刷新状态后重试。',409); throw cause; }
    return { id: row.id, code: `${row.id}.${code}`, binding, expiresAt: row.expires_at };
}
function parseCode(value) {
    const parts = String(value || '').trim().split('.');
    if (parts.length !== 2 || !/^[A-Za-z0-9_-]{32}$/.test(parts[1])) throw error('配对码格式无效，请从浏览器重新复制。',400);
    return { id: id(parts[0]), hash: hash(parts[1]) };
}
async function offer(code) {
    const parsed = parseCode(code), row = await repository.offer(parsed.id,parsed.hash);
    if (!row) throw error('配对码已过期、已使用或已撤销。');
    return { id: row.id, nonce: row.nonce, account: row.nickname || row.username, username: row.username };
}
async function exchange(input) {
    const parsed = parseCode(input.code), publicKey = String(input.publicKey || ''), deviceId = devices.normalizeDeviceId(input.deviceId);
    if (publicKey.length > 4096 || !deviceId.startsWith('webhelper-')) throw error('助手设备身份无效。',400);
    let key; try { key = crypto.createPublicKey(publicKey); } catch (_) { throw error('助手公钥无效。',400); }
    if (key.asymmetricKeyType !== 'ed25519') throw error('助手必须使用 Ed25519 设备身份。',400);
    const token = crypto.randomBytes(32).toString('base64url');
    const result = await repository.exchange(parsed.id,parsed.hash,async (trx,pair,user) => {
        if (!user || user.status === 'disabled' || Number(user.token_version || 0) !== Number(pair.token_version)) throw error('配对账号已失效，请重新登录。');
        if (!devices.verifySignatureWithPublicKey(publicKey,`helper-pair:${pair.id}:${pair.nonce}:${deviceId}`,input.signature)) throw error('助手设备签名校验失败。');
        await repository.activate(trx,pair,{ id: deviceId, name: String(input.deviceName || 'Windows 本机助手').slice(0,128), publicKey, fingerprint: devices.computeKeyFingerprint(publicKey) },hash(token));
        return { token, id: pair.id, account: user.nickname || user.username, username: user.username, deviceId };
    });
    if (!result) throw error('配对码已过期或已使用。');
    return result;
}
async function authenticate(req, offline = false) {
    const pair = await repository.credential(hash(bearer(req)));
    if (!pair || pair.user_status === 'disabled' || Number(pair.current_token_version || 0) !== Number(pair.token_version) || (!offline && !pair.browser_online)) throw error('浏览器已离线、退出或助手连接已失效，请重新配对。');
    const user = { id: pair.user_id, username: pair.username, nickname: pair.nickname, role: pair.role, unit: pair.unit };
    const tenant = await assertTenantContext(user); if (Number(pair.tenant_id) !== tenant.tenantId) throw error('账号所属组织已变化，请重新配对。');
    return { pair,user };
}
async function challenge(req) {
    const {pair,user} = await authenticate(req,true);
    return devices.issueDeviceChallenge(user,{ deviceId: pair.device_id, purpose: 'connector' });
}
function channelPayload(nonce,action,payload) { return `helper:${nonce}:${action}:${hash(JSON.stringify(payload || {}))}`; }
async function channel(req) {
    const { action, payload = {}, nonce, signature } = req.body || {};
    if (!['status','heartbeat','claim','result','preflight','revoke'].includes(action)) throw error('助手操作未登记。',400);
    const {pair,user} = await authenticate(req,action === 'revoke');
    await devices.assertDeviceSignature(user,{deviceId: pair.device_id,purpose:'connector',nonce,signature,payload:channelPayload(nonce,action,payload)});
    const connector = require('./agent-local-connector');
    if (action === 'revoke') return { revoked: await repository.revoke(user.id,{id:pair.id}) };
    if (action === 'status') return { id:pair.id,account:pair.nickname || pair.username,deviceId:pair.device_id };
    if (action === 'heartbeat') return connector.heartbeatConnector(user,{deviceId:pair.device_id,grants:{local_desktop_control:payload.grants?.local_desktop_control || {authorized:false}}});
    if (action === 'claim') {
        const claimed = await connector.claimConnectorTask(user,{deviceId:pair.device_id});
        if (claimed.task) claimed.task.inputDigest = hash(JSON.stringify(claimed.task.input || {}));
        return claimed;
    }
    if (action === 'result') return connector.completeConnectorTask(user,String(payload.taskId || ''),{...payload,deviceId:pair.device_id});
    if (!await repository.preflight(user.id,pair.device_id,String(payload.taskId || ''),hash(payload.claimToken || ''))) throw error('本机任务已过期或授权已撤销。');
    return {ready:true};
}
async function touchBrowser(user,req,input) {
    const row = await repository.heartbeat(user.id,helperBrowserKey(req,user),id(input.id),hash(input.binding || ''));
    if (!row) throw error('助手配对已过期或不属于当前浏览器。');
    return row;
}
module.exports = { create,offer,exchange,challenge,channel,channelPayload,touchBrowser,hash,helperBrowserKey,repository,error };
