'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { getPgPool } = require('../server/db/pg-connection');
const migration = require('../server/db/migrations/analysis-model-contracts')[0];

async function fixture(run) {
    assert.match(process.env.PG_TEST_SCHEMA || '', /^pivot_test_/);
    const client = await getPgPool().connect();
    await client.query('BEGIN');
    try {
        const prefix = `bi_${crypto.randomBytes(5).toString('hex')}`;
        const owner = (await client.query("INSERT INTO users(username,password_hash) VALUES ($1,'hash') RETURNING id", [prefix])).rows[0];
        const model = `${prefix}_model`, dataset = `${prefix}_data`;
        await client.query("INSERT INTO analysis_datasets(id,user_id,name) VALUES ($1,$2,'测试来源')", [dataset, owner.id]);
        await client.query("INSERT INTO analysis_data_models(id,user_id,name) VALUES ($1,$2,'测试模型')", [model, owner.id]);
        await run({ client, prefix, owner, model, dataset });
    } finally { await client.query('ROLLBACK'); client.release(); }
}

async function rejectSql(client, sql, values, code) {
    await client.query('SAVEPOINT expected_failure');
    try { await assert.rejects(client.query(sql, values), error => error.code === code || (code === '23503' && error.code === '23001')); }
    finally { await client.query('ROLLBACK TO SAVEPOINT expected_failure'); }
}

test('正式模型迁移可重复执行，旧模型类型保持探索且任务来源互斥', async () => fixture(async ({ client, owner, model, dataset, prefix }) => {
    await migration.upPg(client);
    await migration.upPg(client);
    const escaped = await client.query(`SELECT c.conname FROM pg_constraint c JOIN pg_class child ON child.oid=c.conrelid JOIN pg_namespace child_ns ON child_ns.oid=child.relnamespace
        JOIN pg_class parent ON parent.oid=c.confrelid JOIN pg_namespace parent_ns ON parent_ns.oid=parent.relnamespace
        WHERE child_ns.nspname=current_schema() AND child.relname LIKE 'analysis_%' AND parent_ns.nspname<>current_schema()`);
    assert.deepEqual(escaped.rows, [], '分析外键必须指向同一隔离 schema');
    assert.equal((await client.query('SELECT model_kind FROM analysis_data_models WHERE id=$1', [model])).rows[0].model_kind, 'exploration');
    await client.query("INSERT INTO analysis_query_jobs(id,user_id,dataset_id,sql_text) VALUES ($1,$2,$3,'SELECT 1')", [`${prefix}_old`, owner.id, dataset]);
    await rejectSql(client, "INSERT INTO analysis_query_jobs(id,user_id,dataset_id,sql_text,execution_kind,model_id) VALUES ($1,$2,$3,'SELECT 1','model_query',$4)", [`${prefix}_mixed`, owner.id, dataset, model], '23514');
    await rejectSql(client, "INSERT INTO analysis_query_jobs(id,user_id,sql_text,execution_kind) VALUES ($1,$2,'','unknown')", [`${prefix}_unknown`, owner.id], '23514');
}));

test('节点约束拒绝重复事实、重复来源和悬空维度，已发布快照拒绝修改', async () => fixture(async ({ client, owner, model, dataset }) => {
    await client.query("INSERT INTO analysis_data_model_nodes(id,model_id,dataset_id,role,name) VALUES ('fact',$1,$2,'fact','事实表')", [model, dataset]);
    await rejectSql(client, "INSERT INTO analysis_data_model_nodes(id,model_id,dataset_id,role,name) VALUES ('again',$1,$2,'dimension','重复')", [model, dataset], '23505');
    await rejectSql(client, "INSERT INTO analysis_model_dimensions(id,model_id,node_id,field_key,name,config_json) VALUES ('d',$1,'missing','field','维度','{}')", [model], '23503');
    await client.query("INSERT INTO analysis_data_model_versions(model_id,version,definition_json,semantic_hash,policy_json,published_by,request_key,request_hash) VALUES ($1,1,'{}',$2,'{}',$3,'request','hash')", [model, 'a'.repeat(64), owner.id]);
    await rejectSql(client, "UPDATE analysis_data_model_versions SET definition_json='{}' WHERE model_id=$1", [model], 'P0001');
    await rejectSql(client, "INSERT INTO analysis_data_model_versions(model_id,version,definition_json,semantic_hash,policy_json,published_by,request_key,request_hash) VALUES ($1,2,'{}',$2,'{}',$3,'request','hash')", [model, 'a'.repeat(64), owner.id], '23505');
}));

test('来源清单保护数据版本与对象，完成报告不可改写，运行记录不允许混入 SQL', async () => fixture(async ({ client, owner, model, dataset, prefix }) => {
    const version = `${prefix}_version`, manifest = `${prefix}_manifest`, object = `${prefix}_object`, check = `${prefix}_check`;
    await client.query("INSERT INTO analysis_dataset_versions(id,dataset_id,user_id,version,parquet_path) VALUES ($1,$2,$3,1,'controlled')", [version, dataset, owner.id]);
    await client.query("INSERT INTO analysis_data_objects(id,user_id,digest,byte_length,storage_key,state,purpose) VALUES ($1,$2,$3,1,'controlled','ready','source')", [object, owner.id, 'a'.repeat(64)]);
    await client.query("INSERT INTO analysis_source_manifests(id,user_id,manifest_hash,manifest_json,coverage) VALUES ($1,$2,$3,'{}','full')", [manifest, owner.id, 'b'.repeat(64)]);
    await client.query("INSERT INTO analysis_source_manifest_members(manifest_id,node_id,dataset_id,dataset_version_id,object_id,schema_hash,governance_hash,source_revision,coverage) VALUES ($1,'fact',$2,$3,$4,'schema','governance',1,'full')", [manifest, dataset, version, object]);
    await rejectSql(client, 'DELETE FROM analysis_dataset_versions WHERE id=$1', [version], '23503');
    await rejectSql(client, 'DELETE FROM analysis_data_objects WHERE id=$1', [object], '23503');
    await rejectSql(client, 'DELETE FROM analysis_datasets WHERE id=$1', [dataset], '23503');
    await client.query("INSERT INTO analysis_data_model_checks(id,model_id,user_id,draft_revision,definition_json,semantic_hash,rules_hash,manifest_id,request_key,request_hash) VALUES ($1,$2,$3,1,'{}','semantic','rules',$4,'key','hash')", [check, model, owner.id, manifest]);
    await rejectSql(client, "UPDATE analysis_data_model_checks SET status='passed' WHERE id=$1", [check], '23514');
    await client.query("UPDATE analysis_data_model_checks SET status='passed',complete=TRUE,completed_at=NOW() WHERE id=$1", [check]);
    await rejectSql(client, "UPDATE analysis_data_model_checks SET report_json='{}' WHERE id=$1", [check], 'P0001');
    await client.query("INSERT INTO analysis_query_jobs(id,user_id,sql_text,execution_kind,model_id,published_version,manifest_id,request_key,request_hash) VALUES ($1,$2,'','model_query',$3,1,$4,'key','hash')", [`${prefix}_job`, owner.id, model, manifest]);
    await rejectSql(client, "UPDATE analysis_query_jobs SET sql_text='SELECT 1' WHERE id=$1", [`${prefix}_job`], '23514');
}));
