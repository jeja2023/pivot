'use strict';

const crypto = require('node:crypto');
const { presentationError } = require('./presentation-schema');

const digest = value => crypto.createHash('sha256').update(value).digest('hex');

function analysisSources(content) {
    return (Array.isArray(content?.sources) ? content.sources : []).filter(source => source?.analysisBinding);
}

function preserveAnalysisSources(previous, submitted) {
    const protectedSources = analysisSources(previous);
    const protectedIds = new Set(protectedSources.map(source => source.id));
    const sources = [...protectedSources, ...(submitted.sources || []).filter(source => !protectedIds.has(source.id))];
    return { ...submitted, sources };
}

async function readAnalysisChart(user, artifactId, { ownerId = user.id, readChart, getDataset, assertFields } = {}) {
    if (!/^art_[A-Za-z0-9_]{1,100}$/.test(String(artifactId || ''))) throw presentationError('分析图表标识无效，请重新生成图表。');
    const row = await (readChart || require('../../repositories/presentation-analysis-reports').readChart)(artifactId, ownerId);
    if (!row) throw presentationError('分析图表不存在或无权访问，请重新生成。', 404, 'PRESENTATION_ANALYSIS_UNAVAILABLE');
    let chart;
    try { chart = JSON.parse(row.content); } catch (_) { throw presentationError('分析图表记录已损坏，请重新生成。', 422, 'PRESENTATION_ANALYSIS_CHART_INVALID'); }
    let dataset;
    try { dataset = await (getDataset || require('../data-analysis/shared').getDatasetForUser)(user, row.dataset_id); }
    catch (error) {
        if (![403, 404].includes(error.status)) throw error;
        throw presentationError('分析来源已不可访问，请重新选择有权使用的数据并生成汇报。', error.status, 'PRESENTATION_ANALYSIS_UNAVAILABLE');
    }
    if (!Number.isSafeInteger(chart.source?.sourceVersion) || chart.source.sourceVersion !== Number(dataset.source_version || 1)) {
        throw presentationError('数据或字段规则已变化，请在数据分析中重新生成图表与汇报。', 409, 'PRESENTATION_ANALYSIS_STALE');
    }
    await (assertFields || require('../data-analysis/governance').assertDatasetFieldsAccessible)(user, dataset,
        require('../data-analysis/chart-snapshot').chartFields(chart));
    return { chart, dataset, artifactId: row.id, digest: digest(row.content) };
}

async function assertAnalysisSources(content, user, options = {}) {
    const cache = new Map();
    for (const source of analysisSources(content)) {
        const binding = source.analysisBinding;
        let snapshot = cache.get(binding.artifactId);
        if (!snapshot) {
            snapshot = await readAnalysisChart(user, binding.artifactId, options);
            cache.set(binding.artifactId, snapshot);
        }
        if (binding.datasetId !== snapshot.dataset.id || binding.sourceVersion !== snapshot.chart.source.sourceVersion || source.digest !== snapshot.digest) {
            throw presentationError('汇报与原始图表快照不一致，请重新从分析结果生成。', 409, 'PRESENTATION_ANALYSIS_BINDING_INVALID');
        }
    }
}

async function assertAnalysisArtifact(artifact, user) {
    if (!String(artifact?.type || '').startsWith('presentation') || !String(artifact.content || '').includes('analysisBinding')) return;
    await assertAnalysisSources(JSON.parse(artifact.content), user);
}

module.exports = { analysisSources, assertAnalysisArtifact, assertAnalysisSources, digest, preserveAnalysisSources, readAnalysisChart };
