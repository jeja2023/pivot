'use strict';

const { biError } = require('./errors');

const invalid = message => biError('ANALYSIS_SOURCE_METADATA_INVALID', message);
const readVersionManifest = value => typeof value === 'string' ? JSON.parse(value) : value || {};
function label(value, max, name) {
    if (value === undefined || value === null) return '';
    if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f]/.test(value)) throw invalid(`${name}最多${max}字，不能含控制字符。`);
    return value.trim();
}

function normalizeSourceMetadata(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('请填写有效的来源业务信息。');
    const inputBatchId = label(input.inputBatchId, 128, '导入批次'), businessPeriod = label(input.businessPeriod, 80, '业务期间');
    const dataUpdatedAt = label(input.dataUpdatedAt, 40, '数据截止时间');
    const date = dataUpdatedAt.slice(0, 10), calendar = new Date(`${date}T00:00:00Z`);
    if (dataUpdatedAt && (!/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/.test(dataUpdatedAt) || !Number.isFinite(Date.parse(dataUpdatedAt)) || !Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== date || Date.parse(dataUpdatedAt) > Date.now() + 300000)) throw invalid('数据截止时间需为真实日期、带时区且不能晚于当前时间，请核对业务数据时间。');
    const coverage = input.coverage === undefined ? 'full' : input.coverage;
    if (!['full', 'incremental', 'partial', 'unknown'].includes(coverage)) throw invalid('请选择全量、增量、部分或未知覆盖范围。');
    return { inputBatchId, businessPeriod, dataUpdatedAt: dataUpdatedAt ? new Date(dataUpdatedAt).toISOString() : '', coverage };
}

function versionSourceMetadata(dataset, version) {
    const stored = readVersionManifest(version?.manifest_json).sourceMetadata || {};
    // 字段治理和业务标注不代表数据刷新；没有显式业务截止时间时保留物理版本最初登记时间。
    const dataUpdatedAt = stored.dataUpdatedAt || version?.created_at || dataset.created_at;
    return { inputBatchId: stored.inputBatchId || '', businessPeriod: stored.businessPeriod || '',
        dataUpdatedAt: dataUpdatedAt ? new Date(dataUpdatedAt).toISOString() : '',
        coverage: Number(dataset.truncated) === 2 ? 'unknown' : Number(dataset.truncated) === 1 ? 'partial' : stored.coverage || 'full' };
}

module.exports = { normalizeSourceMetadata, versionSourceMetadata };
