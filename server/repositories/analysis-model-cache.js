'use strict';

const { transaction } = require('../db/client');
const objects = require('./analysis-objects');
const { canonicalHash } = require('../services/data-analysis/bi/canonical');
const { modelResultCacheKey } = require('../services/data-analysis/bi/result-cache-key');
const { biError } = require('../services/data-analysis/bi/errors');

async function retainMatch(job, { context, authorize, leaseId }) {
    return transaction(async trx => {
        if (!await require('./analysis-model-jobs').owned(trx, job)) throw biError('ANALYSIS_MODEL_LEASE_LOST', '缓存读取时执行租约已失效。', 409);
        const current = await authorize(trx), key = modelResultCacheKey(job, context, current.vector);
        const row = await trx.queryOne(`SELECT q.* FROM analysis_query_jobs q
            JOIN analysis_data_objects r ON r.id=q.result_object_id AND r.state='ready'
            JOIN analysis_data_objects p ON p.id=q.result_page_object_id AND p.state='ready'
            WHERE q.user_id=? AND q.model_id=? AND q.published_version=? AND q.manifest_id=? AND q.request_hash=?
                AND q.execution_kind='model_query' AND q.status='succeeded' AND q.id<>?
                AND q.authorization_vector_json=?::jsonb AND q.result_metadata_json->'cache'->>'key'=?
                AND NOT COALESCE((q.result_metadata_json->>'resultExpired')::boolean,FALSE)
                AND q.completed_at>NOW()-INTERVAL '7 days'
            ORDER BY q.completed_at DESC,q.id LIMIT 1 FOR SHARE OF q`, [job.user_id, job.model_id, job.published_version, job.manifest_id, job.request_hash, job.id, JSON.stringify(current.vector), key]);
        if (!row) return null;
        await objects.pin([row.result_object_id, row.result_page_object_id], { kind: 'lease', referenceId: leaseId, seconds: 600 }, trx);
        return { row, key };
    });
}

async function confirm(trx, job, candidate, context, current) {
    if (modelResultCacheKey(job, context, current.vector) !== candidate.key) return false;
    const row = await trx.queryOne(`SELECT result_object_id,result_page_object_id,result_metadata_json,authorization_vector_json
        FROM analysis_query_jobs WHERE id=? AND user_id=? AND model_id=? AND published_version=? AND manifest_id=? AND request_hash=?
            AND execution_kind='model_query' AND status='succeeded' AND completed_at>NOW()-INTERVAL '7 days'
            AND NOT COALESCE((result_metadata_json->>'resultExpired')::boolean,FALSE) FOR SHARE`, [candidate.row.id, job.user_id, job.model_id, job.published_version, job.manifest_id, job.request_hash]);
    return Boolean(row && row.result_object_id === candidate.row.result_object_id && row.result_page_object_id === candidate.row.result_page_object_id
        && canonicalHash(row.result_metadata_json) === canonicalHash(candidate.row.result_metadata_json)
        && canonicalHash(row.authorization_vector_json) === canonicalHash(current.vector));
}

module.exports = { retainMatch, confirm };
