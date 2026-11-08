'use strict';

const { transaction } = require('../db/client');
const objects = require('./analysis-objects');
const { audit } = require('./analysis-production-models');
const { biError } = require('../services/data-analysis/bi/errors');

async function access({ userId, jobId, authorize, leaseId = null, auditAction = null, page = false, deliver = null }) {
    return transaction(trx => accessInTransaction(trx, { userId, jobId, authorize, leaseId, auditAction, page, deliver }));
}

async function accessInTransaction(trx, { userId, jobId, authorize, leaseId = null, auditAction = null, page = false, deliver = null }) {
        const current = await authorize(trx);
        const job = await trx.queryOne("SELECT * FROM analysis_query_jobs WHERE id=? AND user_id=? AND status='succeeded' AND execution_kind IN ('model_query','model_trial','model_export')", [jobId, userId]);
        if (!job?.result_object_id || job.result_metadata_json?.resultExpired) throw biError('ANALYSIS_MODEL_RESULT_UNAVAILABLE', '该运行结果尚未就绪或保留期已结束，请重新计算。', 409);
        const object = await trx.queryOne("SELECT * FROM analysis_data_objects WHERE id=? AND state='ready'", [page ? job.result_page_object_id : job.result_object_id]);
        if (!object) throw biError('ANALYSIS_MODEL_RESULT_UNAVAILABLE', '运行结果已不可用，请重新计算。', 409);
        if (leaseId) await objects.pin([object.id], { kind: 'lease', referenceId: leaseId, seconds: 120 }, trx);
        if (auditAction) await audit(trx, { userId, modelId: job.model_id, version: job.published_version, runId: job.id, action: auditAction, details: { objectId: object.id, authorizationHash: current.authorizationHash } });
        const result = { job, object, current };
        return deliver ? deliver(result) : result;
}

module.exports = { access, accessInTransaction };
