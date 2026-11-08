'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('../scripts/test_support/bi_modeling');
const { getPgPool } = require('../server/db/pg-connection');
const { execute } = require('../server/db/client');
const readiness = require('../server/services/data-analysis/bi/readiness');
const runtime = require('../server/services/data-analysis/bi/runtime');

test('周期准入复核持续检查数据库保护，固定执行器免于重复主动取消试验，保护丢失后拒绝准入', async () => fixture(async () => {
    const original = await readiness.ensureReady({ force: true });
    assert.equal(original.ready, true); assert.ok(original.isolationCheckedAt);
    const now = Date.now, run = runtime.runIsolated; let probes = 0;
    Date.now = () => now() + 61000;
    runtime.runIsolated = async input => { probes++; return run(input); };
    try {
        const current = await readiness.ensureReady(); assert.equal(current.ready, true); assert.equal(probes, 0); assert.equal(current.isolationCheckedAt, original.isolationCheckedAt);
        await execute('DROP TRIGGER analysis_query_claim_contract ON analysis_query_jobs');
        await assert.rejects(readiness.ensureReady(), error => error.code === 'ANALYSIS_MODEL_SCHEMA_INCOMPATIBLE');
        assert.equal(probes, 0);
    } finally {
        Date.now = now; runtime.runIsolated = run;
        const client = await getPgPool().connect();
        try { await require('../server/db/migrations/analysis-authorization-fences')[0].upPg(client); }
        finally { client.release(); }
    }
    const repaired = await readiness.ensureReady(); assert.equal(repaired.ready, true); assert.ok(repaired.isolationCheckedAt);
}));
