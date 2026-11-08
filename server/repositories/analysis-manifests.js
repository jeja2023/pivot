'use strict';

const crypto = require('node:crypto');
const { transaction, queryOne, query } = require('../db/client');
const objects = require('./analysis-objects');
const { canonicalHash } = require('../services/data-analysis/bi/canonical');
const { biError } = require('../services/data-analysis/bi/errors');
const { contractHash } = require('../services/data-analysis/bi/source-contract');
const { versionSourceMetadata } = require('../services/data-analysis/bi/source-metadata');

async function get(id) { return queryOne('SELECT * FROM analysis_source_manifests WHERE id=?', [id]); }
async function members(id) { return query(`SELECT m.*,o.digest,o.byte_length,o.storage_key,o.purpose,o.state AS object_state,o.user_id AS object_user_id FROM analysis_source_manifest_members m JOIN analysis_data_objects o ON o.id=m.object_id WHERE manifest_id=? ORDER BY node_id`, [id]); }

async function register({ userId, definition, prepared, authorize }) {
    return transaction(async trx => {
        const current = await authorize(trx);
        const memberValues = [];
        for (const node of definition.nodes) {
            const source = current.sources[node.id], item = prepared[node.id];
            const dataset = source.dataset;
            if (!item || dataset.parquet_path !== item.originalPath || String(dataset.source_version) !== item.sourceRevision || canonicalHash(source.columns.map(column => column.key)) !== item.columnsHash || contractHash(definition, node.id, source) !== item.semanticSourceHash || canonicalHash(versionSourceMetadata(dataset, source.version)) !== item.sourceMetadataHash || (source.version?.id || null) !== item.datasetVersionId) throw biError('ANALYSIS_SOURCE_CHANGED', '固定来源期间数据、字段或业务水位已变化，请重新检查。', 409);
            await trx.queryOne("SELECT pg_advisory_xact_lock(hashtext('pivot:analysis:dataset-version'),hashtext(?))", [dataset.id]);
            let version = await trx.queryOne('SELECT * FROM analysis_dataset_versions WHERE dataset_id=? AND parquet_path=? ORDER BY version DESC LIMIT 1', [dataset.id, dataset.parquet_path]);
            if (!version) {
                const next = await trx.queryOne('SELECT COALESCE(MAX(version),0)+1 AS next FROM analysis_dataset_versions WHERE dataset_id=?', [dataset.id]);
                version = await trx.queryOne(`INSERT INTO analysis_dataset_versions(id,dataset_id,user_id,version,operation,parquet_path,source_path,row_count,column_count,manifest_json)
                    VALUES (?,?,?,?,'model_capture',?,?,?,?,?::jsonb) ON CONFLICT(dataset_id,version) DO NOTHING RETURNING *`, [`dsv_${crypto.randomUUID()}`, dataset.id, dataset.user_id, next.next, dataset.parquet_path, dataset.source_path || '', dataset.row_count, dataset.column_count, JSON.stringify({ digest: item.object.digest, recovered: true, sourceMetadata: versionSourceMetadata(dataset, source.version) })]);
                if (!version) throw biError('ANALYSIS_SOURCE_CHANGED', '来源版本登记冲突，请重新检查。', 409);
            }
            memberValues.push({ nodeId: node.id, datasetId: dataset.id, datasetVersionId: version.id, dataVersion: String(version.version), objectId: item.object.id, digest: item.object.digest, byteLength: String(item.object.byte_length),
                schemaHash: item.schemaHash, governanceHash: item.governanceHash, semanticSourceHash: item.semanticSourceHash, sourceRevision: item.sourceRevision, columns: item.columns,
                inputBatchId: item.inputBatchId, watermark: item.watermark, coverage: item.coverage });
        }
        memberValues.sort((left, right) => left.nodeId < right.nodeId ? -1 : 1);
        const coverage = memberValues.some(item => ['incremental', 'partial', 'unknown'].includes(item.coverage)) ? memberValues.some(item => item.coverage === 'unknown') ? 'unknown' : 'partial' : 'full';
        if (coverage !== 'full' && definition.coveragePolicy !== 'partial') throw biError('ANALYSIS_MODEL_COVERAGE_INCOMPLETE', '来源为部分或未知覆盖，请明确声明“部分数据分析”后再检查。', 409);
        if (definition.watermarkPolicy !== 'independent') {
            const watermarks = memberValues.map(item => definition.watermarkPolicy === 'same_batch' ? item.inputBatchId : item.watermark.period);
            if (watermarks.some(value => !value) || new Set(watermarks).size !== 1) throw biError('ANALYSIS_MODEL_WATERMARK_MISMATCH', '来源批次或账期不符合模型要求，请先准备兼容水位。', 409);
        }
        const manifest = { schemaVersion: 1, normalizationVersion: definition.normalizationVersion, coverage, members: memberValues };
        const hash = canonicalHash(manifest), id = `manifest_${crypto.randomUUID()}`;
        await objects.pin(memberValues.map(item => item.objectId), { kind: 'manifest', referenceId: id }, trx);
        const created = await trx.queryOne(`INSERT INTO analysis_source_manifests(id,user_id,manifest_hash,manifest_json,coverage) VALUES (?,?,?,?::jsonb,?) ON CONFLICT(user_id,manifest_hash) DO NOTHING RETURNING *`, [id, userId, hash, JSON.stringify(manifest), coverage]);
        if (!created) {
            await trx.execute("DELETE FROM analysis_object_references WHERE reference_kind='manifest' AND reference_id=?", [id]);
            return trx.queryOne('SELECT * FROM analysis_source_manifests WHERE user_id=? AND manifest_hash=?', [userId, hash]);
        }
        for (const item of memberValues) await trx.execute(`INSERT INTO analysis_source_manifest_members(manifest_id,node_id,dataset_id,dataset_version_id,object_id,schema_hash,governance_hash,source_revision,input_batch_id,watermark_json,coverage) VALUES (?,?,?,?,?,?,?,?,?,?::jsonb,?)`,
            [id, item.nodeId, item.datasetId, item.datasetVersionId, item.objectId, item.schemaHash, item.governanceHash, item.sourceRevision, item.inputBatchId, JSON.stringify(item.watermark), item.coverage]);
        return created;
    });
}

async function retain(id, referenceId, seconds = 120) {
    return transaction(async trx => {
        const manifest = await trx.queryOne('SELECT * FROM analysis_source_manifests WHERE id=?', [id]);
        if (!manifest) throw biError('ANALYSIS_MODEL_MANIFEST_UNAVAILABLE', '数据清单已不可用，请重新检查来源。', 409);
        const rows = await trx.query('SELECT object_id FROM analysis_source_manifest_members WHERE manifest_id=? ORDER BY object_id', [id]);
        await objects.pin(rows.map(row => row.object_id), { kind: 'lease', referenceId, seconds }, trx);
        return manifest;
    });
}

module.exports = { get, members, register, retain };
