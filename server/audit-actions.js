const AUDIT_ACTION_LABELS = {
    RAG_DOCUMENT_UPLOAD: '知识库文档上传',
    RAG_DOCUMENT_ENABLED: '知识库文档启停',
    RAG_DOCUMENT_DELETE: '知识库文档删除',
    RAG_DOCUMENT_BATCH_DELETE: '知识库文档批量删除',
    RAG_DOCUMENT_BATCH_REINDEX: '知识库文档批量重建索引',
    RAG_DOCUMENT_REINDEX: '知识库文档重新索引',
    RAG_DOCUMENT_RETRY_FAILED: '知识库失败文档重试',
    RAG_EMBEDDING_TEST: '向量模型连接测试',
    RAG_FEEDBACK: '知识库召回反馈',
    SYSTEM_ERROR: '系统错误',
    UPDATE_MEMORY_THRESHOLD: '修改长期记忆相似度阈值',
    UPDATE_RUNTIME_SETTINGS: '修改系统运行配置',
    'retry long-term memory jobs': '重试长期记忆提取任务',
    'cleanup long-term memory jobs': '清理长期记忆任务',
    'update long-term memory setting': '更新长期记忆设置',
    'OpenAI Tools 调用': 'OpenAI 工具调用',
    'OpenAI Embeddings 接口调用': 'OpenAI 向量接口调用',
    'OpenAI 流式调用完成': 'OpenAI 流式接口调用完成'
};

function normalizeAuditAction(action) {
    const raw = String(action || '').trim();
    return AUDIT_ACTION_LABELS[raw] || raw;
}

function localizeAuditLogRow(row) {
    if (!row) return row;
    return {
        ...row,
        action: normalizeAuditAction(row.action),
        details: localizeAuditDetails(row.action, row.details)
    };
}

function parseDetails(details) {
    if (!details || typeof details !== 'string') return null;
    try {
        const parsed = JSON.parse(details);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch (e) {
        return null;
    }
}

function compactPairs(pairs) {
    return pairs
        .filter(([, value]) => value !== undefined && value !== null && value !== '')
        .map(([label, value]) => `${label}: ${value}`)
        .join('，');
}

function localizeAuditDetails(action, details) {
    const normalizedAction = normalizeAuditAction(action);
    const data = parseDetails(details);
    if (!data) return details || '';

    if (normalizedAction === '知识库文档上传') {
        return compactPairs([['文档ID', data.docId], ['文件名', data.name]]);
    }
    if (normalizedAction === '知识库文档启停') {
        return compactPairs([['文档ID', data.docId], ['状态', data.enabled === false ? '停用' : '启用']]);
    }
    if (normalizedAction === '知识库文档删除') {
        return compactPairs([['文档ID', data.docId], ['结果', data.deleted ? '已删除' : '未找到或无变化']]);
    }
    if (normalizedAction === '知识库文档重新索引') {
        return compactPairs([['文档ID', data.docId]]);
    }
    if (normalizedAction === '知识库文档批量删除') {
        return compactPairs([['请求数量', data.requested], ['删除数量', data.deleted]]);
    }
    if (normalizedAction === '知识库文档批量重建索引') {
        return compactPairs([['请求数量', data.requested], ['已加入队列', data.scheduled], ['跳过数量', data.skipped]]);
    }
    if (normalizedAction === '知识库失败文档重试') {
        return compactPairs([['可重试数量', data.total], ['已加入队列', data.scheduled], ['已在处理', data.alreadyProcessing]]);
    }
    if (normalizedAction === '向量模型连接测试') {
        return compactPairs([['模式', data.mode], ['接口地址', data.apiUrl], ['结果', data.success ? '成功' : '失败']]);
    }
    if (normalizedAction === '知识库召回反馈') {
        return compactPairs([['反馈ID', data.id], ['分块ID', data.chunkId], ['是否有帮助', data.helpful ? '是' : '否']]);
    }
    if (normalizedAction === '知识库集合创建') {
        return compactPairs([['集合ID', data.collectionId], ['名称', data.name]]);
    }
    if (normalizedAction === '知识库集合共享设置更新') {
        return compactPairs([['集合ID', data.collectionId], ['共享范围', data.scope], ['单位', (data.allowedUnits || []).join('、')], ['用户', (data.allowedUserIds || []).join('、')]]);
    }
    if (normalizedAction === '知识库文档集合更新') {
        return compactPairs([['文档ID', data.docId], ['所属集合ID', data.collectionId || '无']]);
    }
    if (normalizedAction === '知识库文档标签更新') {
        return compactPairs([['文档ID', data.docId], ['标签', (data.tags || []).join('、')]]);
    }
    if (normalizedAction === '知识库标签创建') {
        return compactPairs([['标签名称', data.tag]]);
    }
    if (normalizedAction === '知识图谱文档重建') {
        return compactPairs([['文档ID', data.docId || data.id], ['实体数', data.entityCount], ['关系数', data.relationCount]]);
    }
    if (normalizedAction === '知识图谱实体更新') {
        return compactPairs([['实体ID', data.entityId], ['名称', data.name]]);
    }
    if (normalizedAction === '知识图谱实体合并') {
        return compactPairs([['源实体ID', data.sourceEntityId], ['目标实体ID', data.targetEntityId]]);
    }
    if (normalizedAction === '知识图谱关系更新') {
        return compactPairs([['关系ID', data.relationId]]);
    }
    if (normalizedAction === '知识图谱关系确认') {
        return compactPairs([['关系ID', data.relationId]]);
    }
    if (normalizedAction === '知识图谱关系删除') {
        return compactPairs([['关系ID', data.relationId]]);
    }

    return details || '';
}

function getAuditActionFilterValues(action) {
    const raw = String(action || '').trim();
    if (!raw) return [];
    const normalized = normalizeAuditAction(raw);
    const values = new Set([raw, normalized]);
    for (const [legacyAction, label] of Object.entries(AUDIT_ACTION_LABELS)) {
        if (legacyAction === raw || legacyAction === normalized || label === raw || label === normalized) {
            values.add(legacyAction);
            values.add(label);
        }
    }
    return Array.from(values).filter(Boolean);
}

module.exports = {
    AUDIT_ACTION_LABELS,
    getAuditActionFilterValues,
    localizeAuditDetails,
    normalizeAuditAction,
    localizeAuditLogRow
};
