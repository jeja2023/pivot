'use strict';

const { canonicalHash } = require('./canonical');

// 缓存身份独立于幂等键；所有语义、来源和当前授权都必须相同。
function modelResultCacheKey(job, context, vector) {
    return canonicalHash({ protocol: 1, userId: String(job.user_id), modelId: job.model_id, publishedVersion: String(job.published_version),
        semanticHash: context.semanticHash, manifestId: job.manifest_id, manifestHash: context.manifestHash, query: job.query_ast_json,
        timezone: context.timezone, authorization: vector });
}

module.exports = { modelResultCacheKey };
