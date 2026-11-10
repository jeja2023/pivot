'use strict';

const { query, queryOne, transaction } = require('../db/client');
const { TOOL, invalid } = require('../services/policy-review/contract');
const json = value => typeof value === 'string' ? JSON.parse(value) : value || {};
const present = row => row ? { ...row, input_request: json(row.input_request), result_json: json(row.result_json) } : null;

async function read(user, id, client = { queryOne }) {
    return present(await client.queryOne('SELECT * FROM tool_tasks WHERE id=? AND user_id=? AND tool_name=?', [id, user.id, TOOL]));
}

async function page(user, { limit, offset }) {
    const [rows, count] = await Promise.all([
        query('SELECT id,status,error_message,created_at,updated_at,input_request,result_json FROM tool_tasks WHERE user_id=? AND tool_name=? ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?', [user.id, TOOL, limit, offset]),
        queryOne('SELECT COUNT(*) AS total FROM tool_tasks WHERE user_id=? AND tool_name=?', [user.id, TOOL])
    ]);
    return { rows: rows.map(present), total: Number(count.total) };
}

async function create(user, id, request) {
    await queryOne(`INSERT INTO tool_tasks(id,user_id,tool_name,status,input_request,result_json,expires_at,created_at,updated_at)
        VALUES (?,?,?,'working',?::jsonb,?::jsonb,NOW()+INTERVAL '2 hours',NOW(),NOW()) ON CONFLICT(id) DO NOTHING RETURNING id`,
    [id, user.id, TOOL, JSON.stringify(request), JSON.stringify({ version: 1, findings: [], completedBatches: 0, modelCalls: 0, usage: { totalTokens: 0, knownCalls: 0 } })]);
    const row = await read(user, id);
    if (!row || row.result_json.withdrawn || row.input_request.requestDigest !== request.requestDigest) throw invalid('原创建请求已撤回或用于不同资料，请重新创建审查。', 409, 'POLICY_REVIEW_REQUEST_CONFLICT');
    return row;
}

function claim(user, id, lease) {
    return queryOne(`UPDATE tool_tasks SET result_json=result_json||jsonb_build_object('_lease',?::text,'_leaseUntil',extract(epoch from NOW())+180),updated_at=NOW()
        WHERE id=? AND user_id=? AND tool_name=? AND status='working' AND expires_at>NOW()
        AND COALESCE((result_json->>'_leaseUntil')::numeric,0)<extract(epoch from NOW()) RETURNING id`, [lease, id, user.id, TOOL]);
}

function renew(user, id, lease) {
    return queryOne(`UPDATE tool_tasks SET result_json=result_json||jsonb_build_object('_leaseUntil',extract(epoch from NOW())+180)
        WHERE id=? AND user_id=? AND tool_name=? AND status='working' AND expires_at>NOW() AND result_json->>'_lease'=? RETURNING id`, [id, user.id, TOOL, lease]);
}

function progress(user, id, lease, result, status = 'working', error = '') {
    return queryOne(`UPDATE tool_tasks SET result_json=?::jsonb,status=?,error_message=?,updated_at=NOW()
        WHERE id=? AND user_id=? AND tool_name=? AND status='working' AND expires_at>NOW() AND result_json->>'_lease'=?
        AND (result_json->>'_leaseUntil')::numeric>extract(epoch from NOW()) RETURNING id`,
    [JSON.stringify({ ...result, _lease: status === 'working' ? lease : '', _leaseUntil: status === 'working' ? Date.now() / 1000 + 180 : 0 }), status, error, id, user.id, TOOL, lease]);
}

function cancel(user, id) {
    return queryOne("UPDATE tool_tasks SET status='cancelled',cancel_requested_at=NOW(),updated_at=NOW() WHERE id=? AND user_id=? AND tool_name=? AND status='working' RETURNING id", [id, user.id, TOOL]);
}

function resume(user, id) {
    return queryOne(`UPDATE tool_tasks SET status='working',error_message='',cancel_requested_at=NULL,expires_at=NOW()+INTERVAL '2 hours',updated_at=NOW(),
        result_json=result_json||jsonb_build_object('_lease','', '_leaseUntil',0,'version',COALESCE((result_json->>'version')::int,1)+1)
        WHERE id=? AND user_id=? AND tool_name=? AND status IN ('failed','cancelled','expired') RETURNING id`, [id, user.id, TOOL]);
}

function expire(user, id) {
    return queryOne("UPDATE tool_tasks SET status='expired',updated_at=NOW() WHERE id=? AND user_id=? AND tool_name=? AND status='working' AND expires_at<=NOW() RETURNING id", [id, user.id, TOOL]);
}

function withdraw(user, id) {
    return queryOne("UPDATE tool_tasks SET status='cancelled',cancel_requested_at=NOW(),result_json=result_json||jsonb_build_object('withdrawn',true),updated_at=NOW() WHERE id=? AND user_id=? AND tool_name=? RETURNING id", [id, user.id, TOOL]);
}

async function edit(user, id, version, update) {
    return transaction(async trx => {
        const row = await trx.queryOne('SELECT * FROM tool_tasks WHERE id=? AND user_id=? AND tool_name=? FOR UPDATE', [id, user.id, TOOL]);
        if (!row) return null;
        const current = present(row);
        if (current.result_json.withdrawn || !['completed', 'failed', 'cancelled', 'expired'].includes(current.status) || current.result_json.version !== version) throw invalid('审查报告已更新、撤回或仍在运行，请重新加载后修改。', 409, 'POLICY_REVIEW_VERSION_CONFLICT');
        const result = await update(current, trx);
        await trx.queryOne('UPDATE tool_tasks SET result_json=?::jsonb,updated_at=NOW() WHERE id=? AND user_id=? AND tool_name=? RETURNING id', [JSON.stringify(result), id, user.id, TOOL]);
        return { ...current, result_json: result };
    });
}

async function actor(userId) { return queryOne('SELECT id,username,unit,role,status,deleted_at FROM users WHERE id=?', [userId]); }
async function parent(user, id) { return queryOne('SELECT status,deleted_at,max_token_budget,total_tokens,budget_config,started_at,timeout_ms FROM agent_runs WHERE id=? AND user_id=?', [id, user.id]); }
async function clauses(documentId, versionId) {
    return query(`SELECT a.id,a.document_id,a.version_id,a.article_label,a.article_title,a.heading_path,a.content,
        (SELECT MIN(page_number) FROM regulation_article_locations l WHERE l.article_id=a.id AND l.confidence>=0.8) AS page_number
        FROM regulation_articles a WHERE a.document_id=? AND a.version_id=? ORDER BY a.sort_order,a.id LIMIT 161`, [documentId, versionId]);
}

async function attachArtifact(client, artifactId, runId, userId) {
    if (runId) await client.queryOne('UPDATE agent_artifacts SET run_id=? WHERE id=? AND user_id=? RETURNING id', [runId, artifactId, userId]);
}

module.exports = { read, page, create, claim, renew, progress, cancel, resume, expire, withdraw, edit, actor, parent, clauses, attachArtifact };
