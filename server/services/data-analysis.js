const shared = require('./data-analysis/shared');
const datasets = require('./data-analysis/datasets');
const chartSummary = require('./data-analysis/chart-summary');
const compare = require('./data-analysis/compare');
const queryPivot = require('./data-analysis/query-pivot');
const exportsService = require('./data-analysis/export');
const databaseImport = require('./data-analysis/database-import');
const semanticAnalysis = require('./data-analysis/semantic-analysis');

module.exports = {
    MAX_PREVIEW_ROWS: shared.MAX_PREVIEW_ROWS,
    analysisRoot: shared.analysisRoot,
    ensureAnalysisDirs: shared.ensureAnalysisDirs,
    serializeDataset: shared.serializeDataset,
    getDatasetForUser: shared.getDatasetForUser,
    recordArtifact: shared.recordArtifact,
    redactAnalysisRows: shared.redactAnalysisRows,
    ...datasets,
    ...chartSummary,
    ...compare,
    ...queryPivot,
    ...exportsService,
    ...databaseImport,
    ...semanticAnalysis
};
