const assert = require('node:assert/strict');

const { EventEmitter } = require('node:events');

const fs = require('node:fs');

const http = require('node:http');

const os = require('node:os');

const path = require('node:path');

const test = require('node:test');

const vm = require('node:vm');

const zlib = require('node:zlib');

const Sqlite = require('better-sqlite3');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-security-suite-please-do-not-use';
process.env.PIVOT_DB_WRITE_QUEUE_DISABLED = process.env.PIVOT_DB_WRITE_QUEUE_DISABLED || 'true';

const generatedTestDataDir = !process.env.DATA_DIR;

if (generatedTestDataDir) {
    process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-security-test-'));
}

const generatedTestUploadDir = !process.env.PIVOT_UPLOAD_DIR && !process.env.UPLOAD_DIR;

if (generatedTestUploadDir) {
    process.env.PIVOT_UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-security-uploads-'));
}

const {
    assertSafeOutboundUrl,
    assertSafeMcpOutboundUrl,
    createSafeLookup,
    encodeAttachmentUrl,
    encryptSecret,
    resolveUploadUrlPath,
    isSensitiveOutboundHost,
    toProjectRelativePath,
    isPathInsideUploadRoot
} = require('../server/security');

const { getClientIp } = require('../server/http');

const { getBeijingTimestamp } = require('../server/time');

const { buildContextMeta, createVisibleReasoningStreamFilter, estimateTokens, getContext, stripVisibleReasoningScaffold } = require('../server/llm');

const { normalizeUploadedOriginalName } = require('../server/upload');

const { buildFtsQuery } = require('../server/search');

const { createSseEventParser, createStreamAccumulator, extractStreamPayload, splitStreamTextForDisplay } = require('../server/streaming');

const {
    csrfMiddleware,
    CSRF_COOKIE_NAME,
    getCookie
} = require('../server/auth');

const {
    buildFtsOrQuery,
    buildEmbeddingPayload,
    buildKeywordCandidates,
    buildRagSearchContent,
    chunkText,
    chunkDocument,
    detectDocType,
    applyMMR,
    cosineSimilarity,
    debugRetrieveContext,
    indexDocumentChunks,
    normalizeEmbeddingVector,
    requestEmbedding,
    retrieveContext,
    resolveEmbeddingUrl
} = require('../server/services/rag-index');

const {
    getModelDailyUsage,
    getOrCreateEmbeddingUsageModel,
    getRunnableModelForUser,
    getUserRunnableModels,
    recordModelTokenUsage,
    contentContainsVisionInput,
    messagesContainVisionInput,
    modelSupportsVision,
    modelSupportsReasoning,
    shouldDisableChatThinking
} = require('../server/services/models');

const {
    estimateEmbeddingTokens,
    normalizeTokenUsage
} = require('../server/services/token-accounting');

const {
    ContextLengthExceededError,
    estimateMessagesTokens,
    fitMessagesToContextBudget,
    getModelContextBudget
} = require('../server/services/context-budget');

const {
    MEMORY_CONFIG_KEYS,
    getMemoryConfig,
    normalizeMemoryThreshold,
    toMemorySettingValue
} = require('../server/services/memory-config');

const {
    getLocalHostnames,
    getMonitorKnowledgeChunkCount,
    isDockerInternalServiceHost,
    isLocalModelHost,
    normalizeHostAlias
} = require('../server/routes/admin-stats');

const {
    readZipEntries,
    MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES
} = require('../server/document-text');

const titleHelpers = require('../server/services/chat-title');

const { ConcurrencySemaphore } = require('../server/services/concurrency');

const {
    buildChatCompletionsUrl,
    buildModelHeaders,
    buildResponsesUrl,
    convertChatMessagesToResponsesInput,
    normalizeModelBaseUrl,
    shouldUseResponsesApi
} = require('../server/services/model-adapter');

const {
    countVisibleConversationMessages,
    saveAssistantMessage,
    saveUserMessage,
    touchSession,
    updateLastAssistantStats
} = require('../server/services/chat-messages');

const {
    getKnowledgeSourcePath,
    createKnowledgeCollection,
    createKnowledgeTag,
    createKnowledgeDocumentFromUpload,
    deleteKnowledgeDocument,
    listKnowledgeCollections,
    getKnowledgeDocumentAuditList,
    getKnowledgeDocumentSummaryForUser,
    getKnowledgeDocumentDetail,
    getKnowledgeDocumentTags,
    getRagFeedbackSummary,
    listKnowledgeTags,
    processKnowledgeDocument,
    readKnowledgeDocumentFromPath,
    recordRagFeedback,
    recoverStaleKnowledgeDocumentIndexes,
    scheduleFailedKnowledgeDocumentsForUser,
    setKnowledgeDocumentCollection,
    setKnowledgeDocumentTags
} = require('../server/services/rag-documents');

const {
    getEmbeddingConfig,
    getPublicEmbeddingConfig,
    getRagConfig,
    normalizeEmbeddingMode,
    RAG_CONFIG_KEYS,
    toRagSettingValue
} = require('../server/services/rag-config');

const {
    createApiAccessGuard,
    getApiAccessSetting,
    setApiAccessSetting
} = require('../server/services/api-access-settings');

const {
    confirmRelation,
    deleteRelation,
    extractKnowledgeGraph,
    getEntityGraph,
    getGraphContextForQuery,
    getGraphSummary,
    indexKnowledgeGraphForChunks,
    listEntities,
    listRelations,
    mergeEntities,
    queryKnowledgeGraph,
    suggestDuplicateEntities,
    updateEntity
} = require('../server/services/knowledge-graph');

const {
    getAuditActionFilterValues,
    localizeAuditDetails,
    localizeAuditLogRow,
    normalizeAuditAction
} = require('../server/audit-actions');

const {
    buildEmbeddingModelListUrls,
    extractEmbeddingModelIds
} = require('../server/routes/settings');

const {
    cleanupApiCallLogs,
    cleanupExpiredRefreshTokens,
    cleanupOldLogs,
    backupDatabase,
    cleanupOldBackups,
    getMaintenanceStatus,
    optimizeDatabase
} = require('../server/services/maintenance');

const { cleanupSoftDeletedStorage } = require('../server/services/storage-gc');

const {
    getHttpMetricsSnapshot,
    getRagMetricsSnapshot,
    recordHttpRequest,
    recordRagRetrieval,
    renderPrometheusMetrics
} = require('../server/metrics');

const { aiSemaphore } = require('../server/services/concurrency');

const {
    ADMIN_TIER,
    MANAGER_TIER,
    USER_TIER,
    getPermissionLabel,
    getPermissionTier,
    isAdmin,
    isSuperAdmin,
    withPermissionFlags
} = require('../server/permissions');

const { createAdminUsersRouter } = require('../server/routes/admin-users');

const { createAttachmentsRouter } = require('../server/routes/attachments');

const { createAuthRouter } = require('../server/routes/auth');

const { createModelsRouter } = require('../server/routes/models');

const { createSessionsRouter } = require('../server/routes/sessions');

const { createSettingsRouter } = require('../server/routes/settings');

const { createPromptsRouter } = require('../server/routes/prompts');

const { createAnnouncementsRouter } = require('../server/routes/announcements');

const {
    appendStreamedChartsToAssistantContent,
    applyChatLanguageInstruction,
    applyChatNoThinkSoftSwitch,
    buildAssistantSpeedStats,
    buildFallbackDataQueryInput,
    buildRagContextMessage,
    createChartSseCapture,
    createChatRouter,
    detectStrongDataQueryIntent,
    filterMcpToolsForChatIntent,
    filterMcpToolsForPlanner,
    injectRagContextBeforeLatestUser,
    normalizeRegenerateFlag,
    resolveRagQueryContent,
    summarizeRagContextSources
} = require('../server/routes/chat');

const { createMcpRouter } = require('../server/routes/mcp');

const {
    listCachedMcpTools,
    refreshMcpTools
} = require('../server/services/mcp-client');

const {
    detectReportFileInventoryIntent,
    maybeBuildMcpChatContext
} = require('../server/services/chat-mcp-context');

const longTermMemory = require('../server/services/long-term-memory');

const {
    buildEmbeddingModelItem,
    buildEmbeddingResponse,
    createOpenAIRouter,
    normalizeEmbeddingInputs
} = require('../server/routes/openai');

const {
    getSystemHealthSnapshot,
    overallStatus
} = require('../server/services/system-health');

const {
    getBuiltInToolDefinitions,
    executeBuiltInTool
} = require('../server/services/agent-tools');

const {
    buildComplianceAuditPackage,
    buildZipArchive
} = require('../server/services/compliance-package');

const {
    calculateUsageCost,
    normalizePriceCurrency
} = require('../server/services/model-costs');

const {
    getRealtimeStats,
    publishUserEvent,
    subscribeUserEvents
} = require('../server/services/realtime-events');

const {
    cancelAgentRun,
    computeNextScheduleRun,
    createAgentSchedule,
    createAgentTemplate,
    createAgentRun,
    createAgentWorkflow,
    listAgentArtifacts,
    listAgentNotifications,
    listAgentSchedules,
    listAgentTemplates,
    normalizeApprovalPolicy,
    normalizeAgentGoal,
    normalizeToolAllowlist,
    normalizeToolPolicy,
    parseJsonObject,
    rerunAgentRun,
    resumeAgentRun,
    runAgent,
    runAgentScheduleNow,
    saveAgentRunArtifact,
    shouldPauseForApproval,
    softDeleteAgentRun
} = require('../server/services/agent-runtime');

const { assertWorkflowLlmNodesConfigured } = require('../server/services/agent-workflows');

const { resolveDagNodeInput } = require('../server/services/agent-dag-utils');

const {
    buildGenericDatabaseTools,
    formatToolList
} = require('../server/services/agent-tool-catalog');

const {
    createWorkflowDraftFromRun,
    getRunDetailForUser,
    getRunProgress,
    getRunForUser,
    listDeletedRunsForAdmin,
    listRuns,
    sortDagNodesByDependencies
} = require('../server/services/agent-runs');

const {
    buildDatabaseTestConnectionConfig,
    normalizeDatabaseConnectionError,
    validateDatabaseConnectionPayload
} = require('../server/services/database-mcp');

const { callModelText } = require('../server/services/agent-model');

const { db, stmts } = require('../server/db');

const { ensureBuiltInAdminAccount } = require('../server/db/seed');

const uploadRoot = process.env.PIVOT_UPLOAD_DIR || process.env.UPLOAD_DIR
    ? path.resolve(process.env.PIVOT_UPLOAD_DIR || process.env.UPLOAD_DIR)
    : path.resolve(__dirname, '..', 'uploads');

function removeTestPath(targetPath, options = {}) {
    if (!targetPath) return;
    fs.rmSync(targetPath, {
        force: true,
        maxRetries: 5,
        retryDelay: 80,
        ...options
    });
}

function runExpressHandlers(handlers, req, res) {
    return new Promise((resolve, reject) => {
        let index = 0;
        const originalJson = res.json?.bind(res);
        const originalSend = res.send?.bind(res);
        const originalEnd = res.end?.bind(res);
        if (originalJson) {
            res.json = (data) => {
                originalJson(data);
                resolve();
                return res;
            };
        }
        if (originalSend) {
            res.send = (data) => {
                originalSend(data);
                resolve();
                return res;
            };
        }
        if (originalEnd) {
            res.end = (data) => {
                originalEnd(data);
                resolve();
                return res;
            };
        }
        const next = (err) => {
            if (err) return reject(err);
            const handler = handlers[index];
            index += 1;
            if (!handler) return resolve();
            try {
                const result = handler(req, res, next);
                if (result && typeof result.then === 'function') result.catch(reject);
            } catch (e) {
                reject(e);
            }
        };
        next();
    });
}

function createFakeSseResponse() {
    const events = new EventEmitter();
    return {
        chunks: [],
        headers: {},
        writableEnded: false,
        destroyed: false,
        setHeader(name, value) {
            this.headers[name.toLowerCase()] = value;
        },
        flushHeaders() {},
        write(chunk) {
            this.chunks.push(String(chunk));
        },
        end() {
            this.writableEnded = true;
            events.emit('close');
        },
        on(event, handler) {
            events.on(event, handler);
            return this;
        }
    };
}

test.after(async () => {
    await new Promise(resolve => setImmediate(resolve));
    if (generatedTestUploadDir && process.env.PIVOT_UPLOAD_DIR) {
        removeTestPath(process.env.PIVOT_UPLOAD_DIR, { recursive: true });
    }
    if (generatedTestDataDir && process.env.DATA_DIR) {
        if (db && typeof db.close === 'function') db.close();
        removeTestPath(process.env.DATA_DIR, { recursive: true });
    }
});

function createChatRenderSandbox() {
    const rootDir = path.resolve(__dirname, '..');
    const sandbox = {
        console,
        setTimeout,
        clearTimeout,
        requestAnimationFrame(callback) {
            if (typeof callback === 'function') callback();
            return 1;
        },
        cancelAnimationFrame() {},
        navigator: {
            clipboard: {
                async writeText() {}
            }
        },
        document: {
            createElement() {
                return {
                    style: {},
                    classList: { add() {}, remove() {} },
                    setAttribute() {},
                    appendChild() {},
                    remove() {},
                    querySelector() { return null; },
                    querySelectorAll() { return []; },
                    addEventListener() {},
                    removeEventListener() {},
                    innerHTML: '',
                    textContent: ''
                };
            },
            body: {
                appendChild() {}
            },
            addEventListener() {},
            removeEventListener() {},
            execCommand() {
                return false;
            }
        },
        addEventListener() {},
        removeEventListener() {}
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    sandbox.self = sandbox;
    sandbox.PivotSafeHtml = {
        escapeHtml(value) {
            return String(value ?? '')
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;');
        },
        escapeAttr(value) {
            return this.escapeHtml(value).replace(/"/g, '&quot;');
        },
        sanitizeHtml(html) {
            return html;
        },
        setHtml(element, html) {
            if (element) element.innerHTML = String(html ?? '');
        }
    };
    sandbox.Pivot = {
        modules: Object.create(null),
        registerModule(name, api = {}) {
            const key = String(name || '').trim();
            this.modules[key] = api;
            return api;
        },
        getModule(name) {
            return this.modules[String(name || '').trim()] || null;
        },
        exposeModule(name, api = {}, aliases = []) {
            const current = this.getModule(name) || {};
            const moduleApi = this.registerModule(name, { ...current, ...api });
            (Array.isArray(aliases) ? aliases : []).forEach(alias => {
                const globalName = typeof alias === 'string' ? alias : alias.globalName;
                const exportName = typeof alias === 'string' ? alias : (alias.exportName || alias.globalName);
                if (globalName && exportName && moduleApi[exportName] !== undefined) sandbox[globalName] = moduleApi[exportName];
            });
            return moduleApi;
        },
        moduleApi(name) {
            return this.getModule(name) || {};
        },
        chooseStreamInterval() {
            return 80;
        }
    };

    const context = vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(rootDir, 'client', 'common', 'vendor', 'marked.min.js'), 'utf8'), context, {
        filename: 'client/common/vendor/marked.min.js'
    });
    vm.runInContext(fs.readFileSync(path.join(rootDir, 'client', 'chat', 'render.js'), 'utf8'), context, {
        filename: 'client/chat/render.js'
    });
    vm.runInContext(fs.readFileSync(path.join(rootDir, 'client', 'chat', 'render-charts.js'), 'utf8'), context, {
        filename: 'client/chat/render-charts.js'
    });
    vm.runInContext(fs.readFileSync(path.join(rootDir, 'client', 'chat', 'render-messages.js'), 'utf8'), context, {
        filename: 'client/chat/render-messages.js'
    });
    return sandbox;
}

function createAgentWorkbenchSandbox() {
    const sandbox = createChatRenderSandbox();
    sandbox.escapeHtml = value => sandbox.PivotSafeHtml.escapeHtml(value);
    const rootDir = path.resolve(__dirname, '..');
    [
        'dag-core.js',
        'dag-render.js',
        'dag-interaction.js',
        'dag-toolbar-tools.js',
        'dag-toolbar-db.js',
        'dag-toolbar.js',
        'dag-toolbar-field-overrides.js',
        'dag-toolbar-fields.js',
        'dag-wizard-db.js',
        'dag-wizard-input.js',
        'dag-wizard-fields.js',
        'dag-wizard-stats.js',
        'dag-wizard.js',
        'agents-dag-editor.js',
        'agents.js',
        'agent-run-renderers.js',
        'agent-run-utils.js',
        'agent-run-tool-labels.js',
        'agent-run-step-renderers.js',
        'agent-run-visuals.js',
        'agent-run-loaders.js',
        'agent-run-detail.js',
        'agent-run-realtime.js',
        'agent-run-actions.js',
        'agent-runs-list.js',
        'agent-workflow-library.js',
        'agent-workflow-versions.js',
        'agent-workflow-editor.js',
        'agent-workflow-runners.js',
        'agent-workflows.js',
        'agent-templates.js',
        'agent-schedules.js',
        'agent-artifacts.js'
    ].forEach(fileName => {
        vm.runInContext(fs.readFileSync(path.join(rootDir, 'client', 'chat', fileName), 'utf8'), sandbox, {
            filename: `client/chat/${fileName}`
        });
    });
    return sandbox;
}

function buildSingleEntryZip({ name, data, declaredUncompressedSize = data.length }) {
    const compressed = zlib.deflateRawSync(data);
    const nameBuffer = Buffer.from(name);
    const local = Buffer.alloc(30 + nameBuffer.length + compressed.length);
    let offset = 0;
    local.writeUInt32LE(0x04034b50, offset); offset += 4;
    local.writeUInt16LE(20, offset); offset += 2;
    local.writeUInt16LE(0, offset); offset += 2;
    local.writeUInt16LE(8, offset); offset += 2;
    local.writeUInt16LE(0, offset); offset += 2;
    local.writeUInt16LE(0, offset); offset += 2;
    local.writeUInt32LE(0, offset); offset += 4;
    local.writeUInt32LE(compressed.length, offset); offset += 4;
    local.writeUInt32LE(declaredUncompressedSize, offset); offset += 4;
    local.writeUInt16LE(nameBuffer.length, offset); offset += 2;
    local.writeUInt16LE(0, offset); offset += 2;
    nameBuffer.copy(local, offset); offset += nameBuffer.length;
    compressed.copy(local, offset);

    const central = Buffer.alloc(46 + nameBuffer.length);
    offset = 0;
    central.writeUInt32LE(0x02014b50, offset); offset += 4;
    central.writeUInt16LE(20, offset); offset += 2;
    central.writeUInt16LE(20, offset); offset += 2;
    central.writeUInt16LE(0, offset); offset += 2;
    central.writeUInt16LE(8, offset); offset += 2;
    central.writeUInt16LE(0, offset); offset += 2;
    central.writeUInt16LE(0, offset); offset += 2;
    central.writeUInt32LE(0, offset); offset += 4;
    central.writeUInt32LE(compressed.length, offset); offset += 4;
    central.writeUInt32LE(declaredUncompressedSize, offset); offset += 4;
    central.writeUInt16LE(nameBuffer.length, offset); offset += 2;
    central.writeUInt16LE(0, offset); offset += 2;
    central.writeUInt16LE(0, offset); offset += 2;
    central.writeUInt16LE(0, offset); offset += 2;
    central.writeUInt16LE(0, offset); offset += 2;
    central.writeUInt32LE(0, offset); offset += 4;
    central.writeUInt32LE(0, offset); offset += 4;
    nameBuffer.copy(central, offset);

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(1, 8);
    eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(central.length, 12);
    eocd.writeUInt32LE(local.length, 16);

    return Buffer.concat([local, central, eocd]);
}

const { LruCache, TtlCache } = require('../server/cache');

const {
    withTimeout: withTimeoutHelper,
    TimeoutError: WithTimeoutError,
    KeyedConcurrencyGuard
} = require('../server/services/concurrency');

const { redactSecrets, maskSecretString } = require('../server/security');

const modelRouter = require('../server/services/model-router');

const streamingTools = require('../server/services/streaming-tools');

module.exports = {
    ADMIN_TIER,
    CSRF_COOKIE_NAME,
    ConcurrencySemaphore,
    ContextLengthExceededError,
    EventEmitter,
    KeyedConcurrencyGuard,
    LruCache,
    MANAGER_TIER,
    MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES,
    MEMORY_CONFIG_KEYS,
    RAG_CONFIG_KEYS,
    Sqlite,
    TtlCache,
    USER_TIER,
    WithTimeoutError,
    aiSemaphore,
    appendStreamedChartsToAssistantContent,
    applyChatLanguageInstruction,
    applyChatNoThinkSoftSwitch,
    assert,
    assertSafeMcpOutboundUrl,
    assertSafeOutboundUrl,
    assertWorkflowLlmNodesConfigured,
    backupDatabase,
    buildChatCompletionsUrl,
    buildComplianceAuditPackage,
    buildContextMeta,
    buildDatabaseTestConnectionConfig,
    buildEmbeddingModelItem,
    buildEmbeddingModelListUrls,
    buildEmbeddingPayload,
    buildEmbeddingResponse,
    buildAssistantSpeedStats,
    buildFallbackDataQueryInput,
    buildFtsOrQuery,
    buildFtsQuery,
    buildGenericDatabaseTools,
    buildKeywordCandidates,
    buildModelHeaders,
    buildRagContextMessage,
    buildRagSearchContent,
    buildResponsesUrl,
    buildSingleEntryZip,
    buildZipArchive,
    calculateUsageCost,
    callModelText,
    cancelAgentRun,
    chunkText,
    chunkDocument,
    detectDocType,
    applyMMR,
    cleanupApiCallLogs,
    cleanupExpiredRefreshTokens,
    cleanupOldBackups,
    cleanupOldLogs,
    cleanupSoftDeletedStorage,
    computeNextScheduleRun,
    confirmRelation,
    contentContainsVisionInput,
    convertChatMessagesToResponsesInput,
    cosineSimilarity,
    countVisibleConversationMessages,
    createAdminUsersRouter,
    createAgentRun,
    createAgentWorkflow,
    createAgentSchedule,
    createAgentTemplate,
    createAgentWorkbenchSandbox,
    createAnnouncementsRouter,
    createAttachmentsRouter,
    createAuthRouter,
    createChartSseCapture,
    createChatRenderSandbox,
    createChatRouter,
    createFakeSseResponse,
    createKnowledgeCollection,
    createKnowledgeTag,
    createKnowledgeDocumentFromUpload,
    createMcpRouter,
    createModelsRouter,
    createOpenAIRouter,
    createPromptsRouter,
    createSafeLookup,
    createSessionsRouter,
    createSettingsRouter,
    createSseEventParser,
    createStreamAccumulator,
    createVisibleReasoningStreamFilter,
    csrfMiddleware,
    db,
    debugRetrieveContext,
    deleteKnowledgeDocument,
    deleteRelation,
    detectReportFileInventoryIntent,
    detectStrongDataQueryIntent,
    encodeAttachmentUrl,
    encryptSecret,
    ensureBuiltInAdminAccount,
    estimateEmbeddingTokens,
    estimateMessagesTokens,
    estimateTokens,
    stripVisibleReasoningScaffold,
    executeBuiltInTool,
    extractEmbeddingModelIds,
    extractKnowledgeGraph,
    extractStreamPayload,
    filterMcpToolsForChatIntent,
    filterMcpToolsForPlanner,
    fitMessagesToContextBudget,
    formatToolList,
    fs,
    generatedTestDataDir,
    generatedTestUploadDir,
    getAuditActionFilterValues,
    getBeijingTimestamp,
    getBuiltInToolDefinitions,
    getClientIp,
    getContext,
    getCookie,
    getEmbeddingConfig,
    getEntityGraph,
    getGraphContextForQuery,
    getGraphSummary,
    getHttpMetricsSnapshot,
    getKnowledgeDocumentAuditList,
    getKnowledgeDocumentDetail,
    getKnowledgeDocumentTags,
    getKnowledgeDocumentSummaryForUser,
    getKnowledgeSourcePath,
    getLocalHostnames,
    getMaintenanceStatus,
    getMemoryConfig,
    getModelContextBudget,
    getModelDailyUsage,
    getMonitorKnowledgeChunkCount,
    getOrCreateEmbeddingUsageModel,
    getPermissionLabel,
    getPermissionTier,
    getPublicEmbeddingConfig,
    getRagConfig,
    createApiAccessGuard,
    getApiAccessSetting,
    setApiAccessSetting,
    getRagFeedbackSummary,
    getRagMetricsSnapshot,
    getRealtimeStats,
    createWorkflowDraftFromRun,
    getRunDetailForUser,
    getRunForUser,
    getRunProgress,
    getRunnableModelForUser,
    getSystemHealthSnapshot,
    getUserRunnableModels,
    http,
    indexDocumentChunks,
    indexKnowledgeGraphForChunks,
    injectRagContextBeforeLatestUser,
    isAdmin,
    isDockerInternalServiceHost,
    isLocalModelHost,
    isPathInsideUploadRoot,
    isSensitiveOutboundHost,
    isSuperAdmin,
    listAgentArtifacts,
    listAgentNotifications,
    listAgentSchedules,
    listAgentTemplates,
    listCachedMcpTools,
    listKnowledgeCollections,
    listKnowledgeTags,
    listDeletedRunsForAdmin,
    listEntities,
    listRelations,
    longTermMemory,
    listRuns,
    localizeAuditDetails,
    localizeAuditLogRow,
    maskSecretString,
    maybeBuildMcpChatContext,
    mergeEntities,
    messagesContainVisionInput,
    modelRouter,
    modelSupportsReasoning,
    modelSupportsVision,
    shouldDisableChatThinking,
    normalizeAgentGoal,
    normalizeApprovalPolicy,
    normalizeAuditAction,
    normalizeDatabaseConnectionError,
    normalizeEmbeddingInputs,
    normalizeEmbeddingMode,
    normalizeEmbeddingVector,
    normalizeHostAlias,
    normalizeMemoryThreshold,
    normalizeModelBaseUrl,
    normalizePriceCurrency,
    normalizeRegenerateFlag,
    normalizeTokenUsage,
    normalizeToolAllowlist,
    normalizeToolPolicy,
    normalizeUploadedOriginalName,
    optimizeDatabase,
    os,
    overallStatus,
    parseJsonObject,
    path,
    processKnowledgeDocument,
    publishUserEvent,
    queryKnowledgeGraph,
    readKnowledgeDocumentFromPath,
    readZipEntries,
    recordHttpRequest,
    recordModelTokenUsage,
    recordRagFeedback,
    recordRagRetrieval,
    recoverStaleKnowledgeDocumentIndexes,
    redactSecrets,
    refreshMcpTools,
    removeTestPath,
    renderPrometheusMetrics,
    requestEmbedding,
    rerunAgentRun,
    resolveDagNodeInput,
    resolveEmbeddingUrl,
    resolveRagQueryContent,
    resolveUploadUrlPath,
    resumeAgentRun,
    retrieveContext,
    runAgent,
    runAgentScheduleNow,
    runExpressHandlers,
    saveAgentRunArtifact,
    saveAssistantMessage,
    saveUserMessage,
    scheduleFailedKnowledgeDocumentsForUser,
    setKnowledgeDocumentCollection,
    setKnowledgeDocumentTags,
    shouldPauseForApproval,
    shouldUseResponsesApi,
    softDeleteAgentRun,
    sortDagNodesByDependencies,
    splitStreamTextForDisplay,
    stmts,
    summarizeRagContextSources,
    suggestDuplicateEntities,
    streamingTools,
    subscribeUserEvents,
    test,
    titleHelpers,
    toMemorySettingValue,
    toProjectRelativePath,
    toRagSettingValue,
    touchSession,
    updateEntity,
    updateLastAssistantStats,
    uploadRoot,
    validateDatabaseConnectionPayload,
    vm,
    withPermissionFlags,
    withTimeoutHelper,
    zlib
};
