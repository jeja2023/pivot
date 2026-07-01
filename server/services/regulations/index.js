const analysis = require('./analysis');
const catalog = require('./catalog');
const collaboration = require('./collaboration');
const links = require('./links');
const mutations = require('./mutations');
const parser = require('./parser');
const search = require('./search');
const shared = require('./shared');

module.exports = {
    analyzeRegulationChangeImpact: analysis.analyzeRegulationChangeImpact,
    buildRegulationAiContext: analysis.buildRegulationAiContext,
    buildRegulationQaReport: collaboration.buildRegulationQaReport,
    createRegulationAnnotation: collaboration.createRegulationAnnotation,
    createRegulationDocumentFromUpload: mutations.createRegulationDocumentFromUpload,
    createSavedSearch: search.createSavedSearch,
    countActualRegulationArticles: parser.countActualRegulationArticles,
    deleteRegulationAnnotation: collaboration.deleteRegulationAnnotation,
    deleteRegulationDocument: mutations.deleteRegulationDocument,
    deleteSavedSearch: search.deleteSavedSearch,
    diffRegulationVersions: analysis.diffRegulationVersions,
    embedRegulationArticles: mutations.embedRegulationArticles,
    expandRegulationMatchesByLinks: analysis.expandRegulationMatchesByLinks,
    extractRegulationLinks: links.extractRegulationLinks,
    findSimilarRegulationArticles: search.findSimilarRegulationArticles,
    deriveRegulationTitleFromFilename: shared.deriveRegulationTitleFromFilename,
    deriveRegulationVersionLabelFromFilename: shared.deriveRegulationVersionLabelFromFilename,
    rebuildRegulationCrossLinks: links.rebuildRegulationCrossLinks,
    resolveRegulationCrossLinks: links.resolveRegulationCrossLinks,
    recordRegulationAccess: collaboration.recordRegulationAccess,
    saveRegulationAliases: shared.saveRegulationAliases,
    findRegulationDuplicateByHash: mutations.findRegulationDuplicateByHash,
    getRegulationDocumentById: catalog.getRegulationDocumentById,
    getRegulationCitationGraph: analysis.getRegulationCitationGraph,
    getRegulationDocumentDetail: catalog.getRegulationDocumentDetail,
    getRegulationSupersedeNotices: analysis.getRegulationSupersedeNotices,
    getRegulationVersionById: catalog.getRegulationVersionById,
    listRegulationAccessLogs: collaboration.listRegulationAccessLogs,
    listRegulationAnnotations: collaboration.listRegulationAnnotations,
    listRegulationDocuments: catalog.listRegulationDocuments,
    listRegulationFacets: catalog.listRegulationFacets,
    listRegulationVersions: catalog.listRegulationVersions,
    listSavedSearches: search.listSavedSearches,
    normalizeRegulationId: shared.normalizeRegulationId,
    parseRegulationArticles: parser.parseRegulationArticles,
    resolveRegulationVersionDownloadPath: mutations.resolveRegulationVersionDownloadPath,
    saveRegulationDocumentVersion: mutations.saveRegulationDocumentVersion,
    searchRegulationArticles: search.searchRegulationArticles,
    searchRegulationArticlesHybrid: search.searchRegulationArticlesHybrid,
    setRegulationArticleStatus: mutations.setRegulationArticleStatus,
    updateRegulationAnnotation: collaboration.updateRegulationAnnotation,
    updateRegulationDocument: mutations.updateRegulationDocument
};
