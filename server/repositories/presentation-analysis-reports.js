'use strict';

const { queryOne, transaction } = require('../db/client');

function readChart(artifactId, ownerId) {
    return queryOne("SELECT id,dataset_id,content,created_at FROM analysis_artifacts WHERE id=? AND user_id=? AND type='chart'", [artifactId, ownerId]);
}

async function serializeCreation(key, create, { signal } = {}) {
    const deadline = Date.now() + 15000;
    do {
        signal?.throwIfAborted();
        const result = await transaction(async trx => {
            const lock = await trx.queryOne('SELECT pg_try_advisory_xact_lock(hashtextextended(?,0)) AS acquired', [key]);
            if (!lock.acquired) return { acquired: false };
            return { acquired: true, value: await create() };
        });
        if (result.acquired) return result.value;
        // 等待同一请求时释放连接，避免大量重试占满池后阻塞实际创建者。
        await new Promise(resolve => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    throw Object.assign(new Error('同一汇报正在创建，请稍后用原请求重试。'), { status: 409, code: 'PRESENTATION_ANALYSIS_BUSY' });
}

module.exports = { readChart, serializeCreation };
