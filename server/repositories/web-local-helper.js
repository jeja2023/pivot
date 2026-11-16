'use strict';
const { query, queryOne, execute, transaction } = require('../db/client');

async function create(value) {
    return queryOne(`INSERT INTO web_local_helper_pairs(id,user_id,tenant_id,browser_key,binding_hash,code_hash,nonce,token_version,expires_at)
        VALUES (?,?,?,?,?,?,?,?,NOW()+INTERVAL '5 minutes') RETURNING id,expires_at`,
    [value.id,value.userId,value.tenantId,value.browserKey,value.bindingHash,value.codeHash,value.nonce,value.tokenVersion]);
}
async function offer(id, codeHash) {
    return queryOne(`SELECT p.*,u.username,u.nickname FROM web_local_helper_pairs p JOIN users u ON u.id=p.user_id
        WHERE p.id=? AND p.code_hash=? AND p.state='pending' AND p.expires_at>NOW() AND u.status<>'disabled'`,[id,codeHash]);
}
async function exchange(id, codeHash, callback) {
    return transaction(async trx => {
        const pair = await trx.queryOne("SELECT * FROM web_local_helper_pairs WHERE id=? AND code_hash=? AND state='pending' AND expires_at>NOW() FOR UPDATE",[id,codeHash]);
        if (!pair) return null;
        const user = await trx.queryOne('SELECT * FROM users WHERE id=? FOR SHARE',[pair.user_id]);
        return callback(trx,pair,user);
    });
}
async function activate(trx, pair, device, tokenHash) {
    await trx.execute(`INSERT INTO agent_local_devices(device_id,tenant_id,user_id,device_name,provider,public_key_pem,key_fingerprint,status,last_seen_at,last_attested_at)
        VALUES (?,?,?,?,'web-helper',?,?,'active',NOW(),NOW())`,[device.id,pair.tenant_id,pair.user_id,device.name,device.publicKey,device.fingerprint]);
    await trx.execute("UPDATE web_local_helper_pairs SET state='active',device_id=?,token_hash=?,expires_at=NOW()+INTERVAL '8 hours' WHERE id=?",[device.id,tokenHash,pair.id]);
}
async function credential(tokenHash) {
    return queryOne(`SELECT p.*,u.username,u.nickname,u.role,u.unit,u.status AS user_status,u.token_version AS current_token_version,
        p.browser_seen_at>NOW()-INTERVAL '45 seconds' AS browser_online
        FROM web_local_helper_pairs p JOIN users u ON u.id=p.user_id JOIN agent_local_devices d ON d.device_id=p.device_id
        WHERE p.token_hash=? AND p.state='active' AND p.expires_at>NOW() AND d.status='active' AND d.revoked_at IS NULL`,[tokenHash]);
}
async function heartbeat(userId, browserKey, id, bindingHash) {
    return queryOne(`UPDATE web_local_helper_pairs SET browser_seen_at=NOW() WHERE id=? AND user_id=? AND browser_key=? AND binding_hash=?
        AND state IN ('pending','active') AND expires_at>NOW() RETURNING id,device_id,state,expires_at`,[id,userId,browserKey,bindingHash]);
}
async function visible(userId, browserKey) {
    return query(`SELECT p.id,p.device_id,p.state,p.expires_at,d.device_name FROM web_local_helper_pairs p LEFT JOIN agent_local_devices d ON d.device_id=p.device_id
        WHERE p.user_id=? AND p.browser_key=? AND p.state IN ('pending','active') AND p.expires_at>NOW() AND p.browser_seen_at>NOW()-INTERVAL '45 seconds'`,[userId,browserKey]);
}
async function activeDevice(userId, browserKey, deviceId) {
    return queryOne(`SELECT id FROM web_local_helper_pairs WHERE user_id=? AND browser_key=? AND device_id=? AND state='active'
        AND expires_at>NOW() AND browser_seen_at>NOW()-INTERVAL '45 seconds'`,[userId,browserKey,deviceId]);
}
async function revoke(userId, { id = null, browserKey = null } = {}) {
    return transaction(async trx => {
        const rows = await trx.query("UPDATE web_local_helper_pairs SET state='revoked',revoked_at=NOW() WHERE user_id=? AND (?::uuid IS NULL OR id=?::uuid) AND (?::text IS NULL OR browser_key=?) AND state<>'revoked' RETURNING device_id",[userId,id,id,browserKey,browserKey]);
        for (const row of rows) {
            if (!row.device_id) continue;
            await trx.execute("UPDATE agent_local_devices SET status='revoked',revoked_at=NOW() WHERE device_id=? AND user_id=?",[row.device_id,userId]);
            await trx.execute('UPDATE agent_local_connector_grants SET revoked_at=NOW() WHERE device_id=?',[row.device_id]);
            await trx.execute("UPDATE agent_local_connector_tasks SET state='failed',failure_code='LOCAL_HELPER_REVOKED',failure_reason='本机助手连接已撤销。',claim_token_hash=NULL WHERE device_id=? AND state IN ('pending','claimed')",[row.device_id]);
        }
        return rows.length;
    });
}
async function preflight(userId, deviceId, taskId, claimHash) {
    return queryOne(`SELECT t.id FROM agent_local_connector_tasks t JOIN agent_local_devices d ON d.device_id=t.device_id
        JOIN agent_local_connector_grants g ON g.device_id=t.device_id AND g.grant_type=t.grant_type
        WHERE t.id=? AND t.user_id=? AND t.device_id=? AND t.claim_token_hash=? AND t.state='claimed'
        AND t.expires_at>NOW() AND t.lease_expires_at>NOW() AND d.status='active' AND d.revoked_at IS NULL AND g.revoked_at IS NULL`,[taskId,userId,deviceId,claimHash]);
}
async function prune() { await execute("DELETE FROM web_local_helper_pairs WHERE state='pending' AND expires_at<NOW()-INTERVAL '1 day'"); }
module.exports = { create,offer,exchange,activate,credential,heartbeat,visible,activeDevice,revoke,preflight,prune };
