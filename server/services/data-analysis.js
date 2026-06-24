const shared = require('./data-analysis/shared');
const datasets = require('./data-analysis/datasets');
const chartSummary = require('./data-analysis/chart-summary');
const compare = require('./data-analysis/compare');
const queryPivot = require('./data-analysis/query-pivot');
const exportsService = require('./data-analysis/export');
const databaseImport = require('./data-analysis/database-import');

module.exports = {
    MAX_PREVIEW_ROWS: shared.MAX_PREVIEW_ROWS,
    analysisRoot: shared.analysisRoot,
    ensureAnalysisDirs: shared.ensureAnalysisDirs,
    serializeDataset: shared.serializeDataset,
    ...datasets,
    ...chartSummary,
    ...compare,
    ...queryPivot,
    ...exportsService,
    ...databaseImport
};
