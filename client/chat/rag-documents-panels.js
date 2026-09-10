// RAG 文档面板与诊断
// RAG 文档面板功能从 rag-documents.js 拆分而来。
// RAG 文档面板与诊断，拆自 rag-documents.js。
/* eslint-disable no-undef */
const ensureRagDetailModal = () => {
    let modal = document.getElementById('rag-detail-modal');
    if (modal) return modal;

    modal = document.createElement('div');
    modal.id = 'rag-detail-modal';
    modal.className = 'modal-overlay hidden rag-detail-modal-overlay';
    modal.dataset.knowledgeModal = '1';
    modal.setAttribute('aria-hidden', 'true');
    PivotSafeHtml.setHtml(modal, `
        <div class="modal rag-detail-modal" role="dialog" aria-modal="true" aria-labelledby="rag-detail-title">
            <div class="rag-detail-header">
                <div>
                    <h3 id="rag-detail-title">知识库文档详情</h3>
                    <p id="rag-detail-subtitle" class="model-modal-desc"></p>
                </div>
                <button type="button" id="rag-detail-close-btn" class="btn-danger-outline" data-knowledge-modal-close aria-label="关闭文档详情">关闭</button>
            </div>
            <div id="rag-detail-meta" class="rag-detail-meta"></div>
            <div id="rag-detail-chunks" class="rag-detail-chunks"></div>
        </div>
    `);
    document.body.appendChild(modal);
    modal.addEventListener('click', (event) => {
        if (event.target === modal || event.target.closest('#rag-detail-close-btn')) {
            window.Pivot.legacy.setKnowledgeModalVisibility?.(modal, false);
        }
    });
    return modal;
};

const ensureRagAuditModal = () => {
    let modal = document.getElementById('rag-audit-modal');
    if (modal) return modal;

    modal = document.createElement('div');
    modal.id = 'rag-audit-modal';
    modal.className = 'modal-overlay hidden rag-detail-modal-overlay';
    modal.dataset.knowledgeModal = '1';
    modal.setAttribute('aria-hidden', 'true');
    PivotSafeHtml.setHtml(modal, `
        <div class="modal rag-detail-modal" role="dialog" aria-modal="true" aria-labelledby="rag-audit-title">
            <div class="rag-detail-header">
                <div>
                    <h3 id="rag-audit-title">知识库删除审计</h3>
                    <p class="model-modal-desc">仅 admin 权限层级可见，保留用户删除后的文档元数据、源文件路径与索引状态。</p>
                </div>
                <button type="button" id="rag-audit-close-btn" class="btn-danger-outline" data-knowledge-modal-close aria-label="关闭删除审计">关闭</button>
            </div>
            <div class="table-container rag-audit-table-wrap">
                <table class="data-table compact-table">
                    <thead>
                        <tr>
                            <th style="width: 50px;" class="text-center">序号</th>
                            <th>文档</th>
                            <th>用户</th>
                            <th>状态</th>
                            <th>分块</th>
                            <th>源文件</th>
                            <th>删除时间</th>
                        </tr>
                    </thead>
                    <tbody id="rag-audit-body"></tbody>
                </table>
            </div>
        </div>
    `);
    document.body.appendChild(modal);
    modal.addEventListener('click', (event) => {
        if (event.target === modal || event.target.closest('#rag-audit-close-btn')) {
            window.Pivot.legacy.setKnowledgeModalVisibility?.(modal, false);
        }
    });
    return modal;
};

const renderRagAuditRows = (items = []) => {
    if (!items.length) {
        return '<tr><td colspan="7" class="text-center muted-text">暂无已删除知识库文档</td></tr>';
    }
    return items.map((item, index) => `
        <tr>
            <td class="text-center">${index + 1}</td>
            <td title="${window.Pivot.legacy.escapeRagHtml(item.name)}">${window.Pivot.legacy.escapeRagHtml(item.name)}</td>
            <td>${window.Pivot.legacy.escapeRagHtml(item.nickname || item.username || `用户 ${item.user_id || '-'}`)}</td>
            <td>${window.Pivot.legacy.escapeRagHtml(getRagStatusLabel(item.status))}</td>
            <td>${Number(item.indexed_chunks || item.chunk_count || 0)} / ${Number(item.chunk_count || 0)}</td>
            <td title="${window.Pivot.legacy.escapeRagHtml(item.source_path || '')}">${window.Pivot.legacy.escapeRagHtml(item.source_path || '-')}</td>
            <td>${window.Pivot.legacy.formatRagDateToCN(item.deleted_at)}</td>
        </tr>
    `).join('');
};

function enableChatToolFromWorkspace(tool, message) {
    const storageMap = {
        rag: 'pivot_chat_rag_enabled',
        mcp: 'pivot_chat_mcp_enabled'
    };
    if (!storageMap[tool]) return;
    try {
        localStorage.setItem(storageMap[tool], 'true');
    } catch (e) {
        // 本地存储不可用时，仍然尝试同步当前页面按钮状态。
    }
    window.Pivot.moduleApi('workspaces.navigation').showMainWorkspace?.('chat');
    window.Pivot.legacy.syncChatToolToggles?.();
    document.getElementById('user-input')?.focus();
    if (message) showToast(message, 'success');
}

const showRagDetailModal = (data) => {
    const modal = ensureRagDetailModal();
    const doc = data.doc || {};
    const chunks = Array.isArray(data.chunks) ? data.chunks : [];
    const title = document.getElementById('rag-detail-title');
    const subtitle = document.getElementById('rag-detail-subtitle');
    const meta = document.getElementById('rag-detail-meta');
    const chunkList = document.getElementById('rag-detail-chunks');

    if (title) title.textContent = doc.name || '知识库文档详情';
    if (subtitle) subtitle.textContent = `共 ${Number(data.totalChunks || 0)} 个分块，当前展示 ${chunks.length} 个`;
    if (meta) {
        const enabledText = Number(doc.is_enabled ?? 1) === 1 ? '已启用' : '已停用';
        const items = [
            { icon: window.Pivot.legacy.RAG_ICONS.status, label: '解析状态', value: getRagStatusLabel(doc.status), class: `status-${doc.status}` },
            { icon: window.Pivot.legacy.RAG_ICONS.enable, label: '生效状态', value: enabledText, class: enabledText === '已启用' ? 'status-ready' : 'status-error' },
            { icon: window.Pivot.legacy.RAG_ICONS.progress, label: '索引进度', value: `${Number(doc.progress || 0)}%` },
            { icon: window.Pivot.legacy.RAG_ICONS.chunks, label: '分块总数', value: Number(data.totalChunks || 0) },
            { icon: window.Pivot.legacy.RAG_ICONS.time, label: '创建时间', value: window.Pivot.legacy.formatRagDateToCN(doc.created_at) },
            { icon: window.Pivot.legacy.RAG_ICONS.time, label: '更新时间', value: window.Pivot.legacy.formatRagDateToCN(doc.updated_at || doc.processed_at) }
        ];
        PivotSafeHtml.setHtml(meta, items.map(item => `
            <div class="rag-meta-card ${item.class || ''}">
                <div class="rag-meta-label">${item.icon}<span>${window.Pivot.legacy.escapeRagHtml(item.label)}</span></div>
                <div class="rag-meta-value" title="${window.Pivot.legacy.escapeRagAttr(item.value)}">${window.Pivot.legacy.escapeRagHtml(item.value)}</div>
            </div>
        `).join(''));
    }
    if (chunkList) {
        PivotSafeHtml.setHtml(chunkList, chunks.length
            ? chunks.map((chunk, index) => `
                <article class="rag-detail-chunk">
                    <header>
                        <strong>#${index + 1}</strong>
                        <span>${Number(chunk.length || String(chunk.content || '').length)} 字</span>
                    </header>
                    <p>${window.Pivot.legacy.escapeRagHtml(chunk.content || '')}</p>
                </article>
            `).join('')
            : '<div class="rag-debug-empty">暂无可预览分块</div>');
    }
    window.Pivot.legacy.setKnowledgeModalVisibility?.(modal, true, { focusSelector: '#rag-detail-close-btn' });
};

window.Pivot.legacy.showKnowledgeDocAudit = async () => {
    if (!isSuperAdminUser()) {
        showToast('仅 admin 权限层级可查看知识库删除审计', 'error');
        return;
    }
    try {
        const res = await apiFetch(`${API_BASE}/rag/admin/docs/audit?limit=100`, { headers: authHeaders() });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.error) throw new Error(data.error || '删除审计加载失败');
        const modal = ensureRagAuditModal();
        const body = modal.querySelector('#rag-audit-body');
        if (body) PivotSafeHtml.setHtml(body, renderRagAuditRows(data.data || []));
        window.Pivot.legacy.setKnowledgeModalVisibility?.(modal, true, { focusSelector: '#rag-audit-close-btn' });
    } catch (e) {
        showToast(e.message || '删除审计加载失败', 'error');
    }
};

const renderRagSummary = (summary, quality = null, graphSummary = null) => {
    const el = document.getElementById('rag-summary');
    if (!el) return;
    if (!summary || summary.error) {
        PivotSafeHtml.setHtml(el, '');
        return;
    }
    const signals = quality && !quality.error ? (quality.signals || {}) : {};
    const hasQuality = quality && !quality.error;
    const hasGraphSummary = graphSummary && !graphSummary.error;
    const graphEntities = hasGraphSummary ? graphSummary.entities : signals.graphEntities;
    const graphRelations = hasGraphSummary ? graphSummary.relations : signals.graphRelations;
    const metric = ([label, value]) => `<span><b>${window.Pivot.legacy.escapeRagHtml(value)}</b>${window.Pivot.legacy.escapeRagHtml(label)}</span>`;
    const docItems = [
        ['文档', summary.total || 0],
        ['就绪', summary.ready || 0],
        ['处理中', summary.processing || 0],
        ['失败', summary.error || 0]
    ];
    const indexItems = [
        ['分块', summary.chunks || 0],
        ['源文件', window.Pivot.legacy.formatRagSize(summary.sourceSize || 0)],
        ['队列', `${summary.queue?.running || 0}/${summary.queue?.pending || 0}`]
    ];
    const diagnosticItems = [
        ...(hasQuality ? [
            ['评分', Number(signals.score || 0)],
            ['反馈', signals.helpfulRate === null || signals.helpfulRate === undefined ? '暂无' : `${Number(signals.helpfulRate || 0)}%`]
        ] : []),
        ...(graphEntities === undefined || graphEntities === null ? [] : [['实体', Number(graphEntities || 0)]]),
        ...(graphRelations === undefined || graphRelations === null ? [] : [['关系', Number(graphRelations || 0)]])
    ].filter(([, value]) => value !== undefined && value !== null);
    const lastError = summary.lastError?.error_message
        ? `<span class="rag-summary-error" title="${window.Pivot.legacy.escapeRagHtml(summary.lastError.error_message)}">最近错误：${window.Pivot.legacy.escapeRagHtml(summary.lastError.name || '文档')}</span>`
        : '';
    PivotSafeHtml.setHtml(el, `
        <div class="rag-summary-items">
            <div class="knowledge-summary-primary">
                <div class="knowledge-summary-group" aria-label="资料状态">
                    <span class="knowledge-summary-group-label">资料</span>${docItems.map(metric).join('')}
                </div>
                <div class="knowledge-summary-group" aria-label="索引状态">
                    <span class="knowledge-summary-group-label">索引</span>${indexItems.map(metric).join('')}
                </div>
                ${diagnosticItems.length ? `
                    <div class="knowledge-summary-group" aria-label="诊断统计">
                        <span class="knowledge-summary-group-label">诊断</span>${diagnosticItems.map(metric).join('')}
                    </div>
                ` : ''}
            </div>
        </div>
        ${lastError}
    `);

    const retryBtn = document.getElementById('rag-retry-failed-btn');
    if (retryBtn) retryBtn.disabled = !(summary.retryableErrors > 0);
    const scoreInput = document.getElementById('rag-debug-score-threshold');
    const topKInput = document.getElementById('rag-debug-top-k');
    const candidateInput = document.getElementById('rag-debug-candidate-limit');
    if (scoreInput && !scoreInput.value) scoreInput.value = summary.config?.scoreThreshold ?? 0.4;
    if (topKInput && !topKInput.value) topKInput.value = summary.config?.topK ?? 3;
    if (candidateInput && !candidateInput.value) candidateInput.value = summary.config?.candidateLimit ?? 300;
};

const renderRagQualityReport = (report) => {
    const el = document.getElementById('rag-quality-report');
    if (!el) return;
    if (!report || report.error) {
        PivotSafeHtml.setHtml(el, '');
        return;
    }
    const overview = report.overview || {};
    const problemDocs = Array.isArray(report.problemDocs) ? report.problemDocs : [];
    const visibleProblems = problemDocs.filter(doc => doc.status === 'error' || Number(doc.chunk_count || 0) === 0).slice(0, 3);
    const duplicateGroups = Array.isArray(report.duplicates?.groups) ? report.duplicates.groups.slice(0, 3) : [];
    const unhashedReady = Number(report.duplicates?.unhashedReady || 0);
    const issueItems = [
        ['异常', Number(overview.error || 0)],
        ['停用', Number(overview.disabled || 0)],
        ['空分块', Number(overview.emptyReady || 0)],
        ['重复组', Number(report.duplicates?.groups?.length || 0)]
    ].filter(([, value]) => value > 0);
    if (!issueItems.length && !visibleProblems.length && unhashedReady <= 0) {
        PivotSafeHtml.setHtml(el, '');
        return;
    }
    PivotSafeHtml.setHtml(el, `
        <div class="governance-head">
            <strong>质量诊断</strong>
            <span>${duplicateGroups.length ? `发现 ${duplicateGroups.length} 组重复文档` : visibleProblems.length ? `发现 ${visibleProblems.length} 个需处理文档` : '存在需关注指标'}</span>
        </div>
        ${issueItems.length ? `
            <div class="governance-metrics">
                ${issueItems.map(([label, value]) => `<span><b>${Number(value || 0)}</b>${window.Pivot.legacy.escapeRagHtml(label)}</span>`).join('')}
            </div>
        ` : ''}
        ${visibleProblems.length ? `
            <div class="governance-list">
                ${visibleProblems.map(doc => `
                <span class="${doc.status === 'error' ? 'is-error' : ''}">
                    ${window.Pivot.legacy.escapeRagHtml(doc.name || '文档')} · ${window.Pivot.legacy.escapeRagHtml(getRagStatusLabel(doc.status))} · 分块 ${Number(doc.chunk_count || 0)}
                </span>
                `).join('')}
            </div>
        ` : ''}
        ${duplicateGroups.length ? `
            <div class="governance-list is-duplicate">
                ${duplicateGroups.map(group => `
                <span>
                    ${window.Pivot.legacy.escapeRagHtml(group.documents?.map(document => document.name || '文档').join('、') || '重复文档')} · 完全相同
                </span>
                `).join('')}
            </div>
        ` : ''}
        ${unhashedReady > 0 ? `<div class="governance-note">${unhashedReady} 个历史文档尚未生成重复检测指纹，批量重建后可纳入检测。</div>` : ''}
    `);
};

const renderRagDebugHistory = (items = []) => {
    const el = document.getElementById('rag-debug-history');
    if (!el) return;
    const rows = Array.isArray(items) ? items.slice(0, 8) : [];
    if (rows.length === 0) {
        PivotSafeHtml.setHtml(el, '<div class="rag-debug-history-empty">暂无调试历史</div>');
        return;
    }
    PivotSafeHtml.setHtml(el, `
        <div class="rag-debug-history-head">
            <strong>最近调试</strong>
            <span>点击问题可带回输入框</span>
        </div>
        <div class="rag-debug-history-list">
            ${rows.map(item => {
        const top = (Array.isArray(item.scores) ? item.scores : [])
            .reduce((acc, score) => Math.max(acc, Number(score.score || 0)), 0);
        const queue = item.queue || {};
        const queueLabel = queue.maxConcurrent !== undefined
            ? `${Number(queue.running || 0)}/${Number(queue.pending || 0)}`
            : '-';
        return `
                    <button type="button" class="rag-debug-history-item" data-rag-debug-sample="${window.Pivot.legacy.escapeRagAttr(item.query || '')}">
                        <span class="rag-debug-history-query">${window.Pivot.legacy.escapeRagHtml(item.query || '-')}</span>
                        <span class="rag-debug-history-meta">命中 ${Number(item.matchedCount || 0)} / 候选 ${Number(item.candidateCount || 0)} / 最高 ${top.toFixed(3)} / 队列 ${window.Pivot.legacy.escapeRagHtml(queueLabel)} / ${Number(item.elapsedMs || 0)} ms</span>
                    </button>
                `;
    }).join('')}
        </div>
    `);
};
const renderRagDebugResults = (data) => {
    const el = document.getElementById('rag-debug-results');
    if (!el) return;
    const matches = Array.isArray(data.matches) ? data.matches : [];
    el.classList.remove('hidden');

    // 关键词高亮：把字符串里出现的 keywords 包成 <mark>，并保持先转义再替换的顺序
    const keywords = (Array.isArray(data.keywords) ? data.keywords : [])
        .map(k => String(k || '').trim())
        .filter(k => k.length > 0)
        .sort((a, b) => b.length - a.length)
        .slice(0, 16);
    const highlightChunk = (text) => {
        const escaped = window.Pivot.legacy.escapeRagHtml(text || '');
        if (keywords.length === 0) return escaped;
        try {
            const pattern = keywords
                .map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
                .filter(Boolean)
                .join('|');
            if (!pattern) return escaped;
            return escaped.replace(new RegExp(`(${pattern})`, 'gi'), '<mark class="rag-debug-hit">$1</mark>');
        } catch (e) {
            return escaped;
        }
    };

    // 按 source 聚合：方便查看哪个文件命中最多、平均分多少
    const grouped = new Map();
    matches.forEach(m => {
        const key = String(m.source || '-');
        const entry = grouped.get(key) || { source: key, count: 0, matched: 0, totalScore: 0, top: 0 };
        entry.count += 1;
        if (m.matched) entry.matched += 1;
        const score = Number(m.score || 0);
        entry.totalScore += score;
        if (score > entry.top) entry.top = score;
        grouped.set(key, entry);
    });
    const groupedList = Array.from(grouped.values()).sort((a, b) => b.top - a.top).slice(0, 8);

    const maxScore = matches.reduce((acc, m) => Math.max(acc, Number(m.score || 0)), 0) || 1;
    const elapsed = Number(data.elapsedMs || data.elapsed || 0);
    const matchedCount = matches.filter(m => m.matched).length;
    const feedbackAdjustedCount = matches.filter(m => m.feedback && Number(m.feedback.total || 0) > 0).length;
    const topScore = matches.reduce((acc, m) => Math.max(acc, Number(m.score || 0)), 0);
    const queue = data.queue || {};
    const hybrid = data.hybrid || {};
    const ranking = data.ranking || {};
    const rankingMode = ranking.mode ? String(ranking.mode).replace(/_/g, ' ') : '';
    const queueLabel = queue.maxConcurrent !== undefined
        ? `${Number(queue.running || 0)}/${Number(queue.pending || 0)} pending, max ${Number(queue.maxConcurrent || 0)}`
        : '';
    const hybridLabel = hybrid.rrfK !== undefined
        ? `dense ${Number(hybrid.wDense || 0).toFixed(2)} / fts ${Number(hybrid.wFts || 0).toFixed(2)} / mmr ${Number(hybrid.mmrLambda || 0).toFixed(2)}`
        : '';
    const debugVerdict = (() => {
        if (matchedCount > 0 && topScore >= Number(data.threshold || 0)) {
            return {
                tone: 'ready',
                title: '可以带着这个问题去聊天',
                detail: `已召回 ${matchedCount} 条可引用分块，聊天时启用知识库即可使用。`,
                action: '用这个问题去聊天'
            };
        }
        if (matches.length > 0) {
            return {
                tone: 'warning',
                title: '召回到相近分块，但证据还不够稳',
                detail: '可以换成更具体的问题，或降低阈值后再测试一次。',
                action: '带着问题去聊天'
            };
        }
        return {
            tone: 'empty',
            title: '这次没有召回到可用分块',
            detail: '请换个问法、上传相关文档，或确认文档已经就绪并启用。',
            action: '回到聊天'
        };
    })();

    PivotSafeHtml.setHtml(el, `
        <div class="rag-debug-verdict is-${window.Pivot.legacy.escapeRagHtml(debugVerdict.tone)}">
            <div>
                <strong>${window.Pivot.legacy.escapeRagHtml(debugVerdict.title)}</strong>
                <span>${window.Pivot.legacy.escapeRagHtml(debugVerdict.detail)}</span>
            </div>
            <button type="button" data-rag-debug-chat="${window.Pivot.legacy.escapeRagAttr(data.query || '')}">${window.Pivot.legacy.escapeRagHtml(debugVerdict.action)}</button>
        </div>
        <div class="rag-debug-meta">
            <span>关键词：${window.Pivot.legacy.escapeRagHtml((data.keywords || []).join(' / ') || '-')}</span>
            <span>候选：${Number(data.candidateCount || 0)}</span>
            <span>阈值：${Number(data.threshold || 0).toFixed(2)}</span>
            ${feedbackAdjustedCount ? `<span>反馈校正：${feedbackAdjustedCount} 条</span>` : ''}
            ${rankingMode ? `<span>Mode: ${window.Pivot.legacy.escapeRagHtml(rankingMode)}</span>` : ''}
            ${hybridLabel ? `<span>Hybrid: ${window.Pivot.legacy.escapeRagHtml(hybridLabel)}</span>` : ''}
            ${queueLabel ? `<span>Queue: ${window.Pivot.legacy.escapeRagHtml(queueLabel)}</span>` : ''}
            ${elapsed > 0 ? `<span>检索耗时：${elapsed} ms</span>` : ''}
        </div>
        ${groupedList.length > 1 ? `
            <div class="rag-debug-grouped" role="list">
                ${groupedList.map(g => `
                    <div class="rag-debug-grouped-item" role="listitem">
                        <span class="rag-debug-grouped-source">${window.Pivot.legacy.escapeRagHtml(g.source)}</span>
                        <span class="rag-debug-grouped-stats">命中 ${g.matched}/${g.count}<span class="rag-debug-grouped-divider">·</span>峰值 ${g.top.toFixed(3)}<span class="rag-debug-grouped-divider">·</span>均值 ${(g.totalScore / g.count).toFixed(3)}</span>
                    </div>
                `).join('')}
            </div>
        ` : ''}
        <div class="rag-debug-list">
            ${matches.map((m, index) => {
        const score = Number(m.score || 0);
        const fusedScore = Number(m.fusedScore ?? m.scores?.fused ?? score);
        const rankScore = Number(m.rankScore ?? m.scores?.rank ?? fusedScore);
        const citationConfidence = Number(m.citationConfidence || 0);
        const denseRank = m.scores?.denseRank || null;
        const ftsRank = m.scores?.ftsRank || null;
        const percent = Math.max(0, Math.min(1, score / maxScore)) * 100;
        const scoreDetails = [
            `rank #${Number(m.rank || index + 1)}`,
            `dense ${score.toFixed(3)}`,
            `fused ${fusedScore.toFixed(3)}`,
            `排序 ${rankScore.toFixed(3)}`,
            `引用可信度 ${Math.round(citationConfidence * 100)}%`,
            denseRank ? `dense-rank #${denseRank}` : '',
            ftsRank ? `fts #${ftsRank}` : '',
            m.selected ? 'MMR selected' : ''
        ].filter(Boolean).join(' | ');
        return `
                <div class="rag-debug-item ${m.matched ? 'matched' : ''}">
                    <div class="rag-debug-item-head">
                        <strong>#${index + 1} ${window.Pivot.legacy.escapeRagHtml(m.source || '-')}</strong>
                        <span class="rag-debug-score" title="Dense / fused / feedback rank / citation confidence">${score.toFixed(3)}${m.matched ? ' HIT' : ''}${m.selected ? ' | MMR' : ''} · ${Math.round(citationConfidence * 100)}%</span>
                    </div>
                    <div class="rag-debug-score-bar" aria-hidden="true">
                        <div class="rag-debug-score-bar-fill" style="width:${percent.toFixed(1)}%"></div>
                    </div>
                    <div class="rag-debug-score-breakdown">${window.Pivot.legacy.escapeRagHtml(scoreDetails)}</div>
                    <p>${highlightChunk(m.text || '')}</p>
                    <div class="rag-feedback-actions">
                        <button class="btn-secondary rag-feedback-btn" data-helpful="true" data-query="${window.Pivot.legacy.escapeRagAttr(data.query || '')}" data-chunk-id="${m.chunkId || ''}" data-doc-name="${window.Pivot.legacy.escapeRagAttr(m.documentName || m.source || '')}" data-score="${score}">有用</button>
                        <button class="btn-secondary rag-feedback-btn" data-helpful="false" data-query="${window.Pivot.legacy.escapeRagAttr(data.query || '')}" data-chunk-id="${m.chunkId || ''}" data-doc-name="${window.Pivot.legacy.escapeRagAttr(m.documentName || m.source || '')}" data-score="${score}">无用</button>
                    </div>
                </div>
                `;
    }).join('') || '<div class="rag-debug-empty">没有召回到可用分块</div>'}
        </div>
    `);
};

async function openKnowledgeCollectionShareModal() {
    const normalizeId = window.Pivot.modules?.['rag.documents']?.normalizeRagCollectionId || window.Pivot.legacy.normalizeRagCollectionId || (value => {
        const id = Number.parseInt(value, 10);
        return Number.isSafeInteger(id) && id > 0 ? String(id) : '';
    });
    const collectionId = normalizeId(document.getElementById('rag-collection-filter')?.value);
    if (!collectionId) return showToast('请先在专题库筛选中选择一个自己的专题库', 'error');
    const collections = window.Pivot.modules?.['rag.documents']?.getRagCollections?.() || window.Pivot.legacy.getRagCollections?.() || (typeof ragCollections !== 'undefined' ? ragCollections : []);
    const collection = collections.find(item => String(item.id) === collectionId);
    if (!collection?.can_edit) return showToast('共享专题库需要所有者权限', 'error');

    const res = await apiFetch(`${API_BASE}/rag/collections/share-options?collectionId=${encodeURIComponent(collectionId)}`, { headers: authHeaders() });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return showToast(data.error || '无法读取专题库共享设置', 'error');

    let modal = document.getElementById('knowledge-share-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'knowledge-share-modal';
        modal.className = 'modal-overlay hidden knowledge-share-modal-overlay agent-workflow-share-modal-overlay';
        modal.dataset.knowledgeModal = '1';
        modal.setAttribute('aria-hidden', 'true');
        document.body.appendChild(modal);
    } else {
        modal.className = 'modal-overlay hidden knowledge-share-modal-overlay agent-workflow-share-modal-overlay';
        modal.dataset.knowledgeModal = '1';
        modal.setAttribute('aria-hidden', 'true');
    }

    const current = data.data?.collection || collection;
    const units = Array.isArray(data.data?.units) ? data.data.units.filter(Boolean) : [];
    const users = Array.isArray(data.data?.users) ? data.data.users.filter(item => Number(item?.id) > 0) : [];
    const allowed = new Set(String(current.allowed_units || '').split(',').map(item => item.trim()).filter(Boolean));
    const allowedUserIds = new Set((Array.isArray(current.allowed_user_ids)
        ? current.allowed_user_ids
        : String(current.allowed_user_ids || '').split(',')).map(Number).filter(Number.isSafeInteger));
    const isShared = current.scope === 'shared';
    const canShareAll = data.data?.canShareAll === true;
    const isAll = isShared && canShareAll && allowed.size === 0 && allowedUserIds.size === 0;
    const currentUnit = String(data.data?.currentUnit || '').trim();

    PivotSafeHtml.setHtml(modal, `
        <div class="modal agent-workflow-share-modal knowledge-share-modal" role="dialog" aria-modal="true" aria-labelledby="knowledge-share-title">
            <div class="agent-workflow-share-head">
                <div>
                    <h3 id="knowledge-share-title">分享专题库</h3>
                    <p id="knowledge-share-subtitle">设置哪些单位或个人可以只读检索与问答该专题库。</p>
                </div>
                <button type="button" class="btn-danger-outline" data-knowledge-share-close data-knowledge-modal-close>关闭</button>
            </div>
            <div class="agent-workflow-share-body">
                <div class="agent-workflow-share-summary">
                    <strong>${window.Pivot.legacy.escapeRagHtml(current.name || '专题库')}</strong>
                    <span>共享后，接收方只能检索、查看详情和知识图谱，无法上传、编辑、重建或删除文档。</span>
                </div>
                <fieldset class="agent-workflow-share-scope-fieldset">
                    <legend>可见范围</legend>
                    <label class="agent-workflow-share-choice">
                        <input type="radio" name="knowledge-share-scope" value="personal" ${!isShared ? 'checked' : ''}>
                        <span>
                            <strong>仅自己</strong>
                            <small>未启用共享时，该专题库仅对自己可见和检索。</small>
                        </span>
                    </label>
                    <label class="agent-workflow-share-choice">
                        <input type="radio" name="knowledge-share-scope" value="shared" ${isShared ? 'checked' : ''}>
                        <span>
                            <strong>共享给单位或个人</strong>
                            <small>选定成员可以以只读方式检索、查看详情和知识图谱。</small>
                        </span>
                    </label>
                </fieldset>
                <section id="knowledge-share-units-section" class="agent-workflow-share-units-section ${isShared ? '' : 'hidden'}">
                    <label id="knowledge-share-all-label" class="agent-workflow-share-all ${canShareAll ? '' : 'hidden'}">
                        <input id="knowledge-share-all" type="checkbox" ${isAll ? 'checked' : ''} ${canShareAll ? '' : 'disabled'}>
                        <span>共享给全体成员</span>
                    </label>
                    <div class="agent-workflow-share-units-head">
                        <div>
                            <strong>共享对象</strong>
                            <span>按单位展开并选择整个单位或其中的用户。</span>
                        </div>
                        <div class="agent-workflow-share-target-actions">
                            <button type="button" class="btn-secondary" data-knowledge-share-select="tree">全选</button>
                            <button type="button" class="btn-secondary" data-knowledge-share-clear="tree">全不选</button>
                        </div>
                    </div>
                    <div id="knowledge-share-target-tree" class="agent-workflow-share-tree" role="tree" aria-label="单位和用户">
                        ${window.Pivot.legacy.PivotShareTargetTree?.render({
        units,
        users,
        allowedUnits: [...allowed],
        allowedUserIds: [...allowedUserIds],
        currentUnit,
        isShared,
        isAll,
        unitInputName: 'knowledge-share-unit',
        userInputName: 'knowledge-share-user',
        escapeText: window.Pivot.legacy.escapeRagHtml,
        escapeAttr: window.Pivot.legacy.escapeRagAttr
    }) || '<div class="agent-workflow-share-empty">暂无可共享的单位或用户。</div>'}
                    </div>
                </section>
                <div id="knowledge-share-error" class="agent-workflow-share-error" role="alert" hidden></div>
            </div>
            <div class="agent-workflow-share-footer">
                <button type="button" class="btn-secondary" data-knowledge-share-close>取消</button>
                <button type="button" class="btn-primary" data-knowledge-share-save>保存共享设置</button>
            </div>
        </div>
    `);

    const closeButtons = modal.querySelectorAll('[data-knowledge-share-close]');
    closeButtons.forEach(btn => btn.addEventListener('click', () => window.Pivot.legacy.setKnowledgeModalVisibility?.(modal, false)));
    if (modal.dataset.boundKnowledgeShareOverlay !== '1') {
        modal.dataset.boundKnowledgeShareOverlay = '1';
        modal.addEventListener('click', e => {
            if (e.target === modal) window.Pivot.legacy.setKnowledgeModalVisibility?.(modal, false);
        });
    }

    const setKnowledgeError = (msg = '') => {
        const errEl = modal.querySelector('#knowledge-share-error');
        if (!errEl) return;
        errEl.textContent = msg;
        errEl.hidden = !msg;
    };

    const scopeRadios = modal.querySelectorAll('input[name="knowledge-share-scope"]');
    scopeRadios.forEach(radio => {
        radio.addEventListener('change', () => {
            const scopeVal = modal.querySelector('input[name="knowledge-share-scope"]:checked')?.value;
            const sec = modal.querySelector('#knowledge-share-units-section');
            if (sec) sec.classList.toggle('hidden', scopeVal !== 'shared');
            setKnowledgeTargetsEnabled();
            setKnowledgeError('');
        });
    });

    const allChk = modal.querySelector('#knowledge-share-all');
    const setKnowledgeTargetsEnabled = () => {
        const enabled = modal.querySelector('input[name="knowledge-share-scope"]:checked')?.value === 'shared';
        const allChecked = allChk?.checked === true && allChk?.disabled !== true;
        const disabled = !enabled || allChecked;
        modal.querySelectorAll('input[name="knowledge-share-unit"], input[name="knowledge-share-user"], [data-knowledge-share-select], [data-knowledge-share-clear]')
            .forEach(control => control.disabled = disabled);
    };
    allChk?.addEventListener('change', () => {
        setKnowledgeTargetsEnabled();
        setKnowledgeError('');
    });
    modal.querySelectorAll('[data-knowledge-share-select], [data-knowledge-share-clear]').forEach(button => {
        button.addEventListener('click', () => {
            const group = button.dataset.knowledgeShareSelect || button.dataset.knowledgeShareClear;
            const checked = Boolean(button.dataset.knowledgeShareSelect);
            const tree = modal.querySelector('#knowledge-share-target-tree');
            if (group === 'tree') window.Pivot.legacy.PivotShareTargetTree?.setChecked(tree, checked);
            setKnowledgeError('');
        });
    });
    window.Pivot.legacy.PivotShareTargetTree?.bind(modal.querySelector('#knowledge-share-target-tree'), {
        unitSelector: 'input[name="knowledge-share-unit"]',
        userSelector: 'input[name="knowledge-share-user"]',
        onChange: () => setKnowledgeError('')
    });
    setKnowledgeTargetsEnabled();

    const saveBtn = modal.querySelector('[data-knowledge-share-save]');
    if (saveBtn) {
        saveBtn.addEventListener('click', async () => {
            const scopeVal = modal.querySelector('input[name="knowledge-share-scope"]:checked')?.value || 'personal';
            const enabled = scopeVal === 'shared';
            const allCheckbox = modal.querySelector('#knowledge-share-all');
            const allChecked = allCheckbox?.checked === true && allCheckbox?.disabled !== true;
            const allowedUnits = enabled && !allChecked
                ? [...modal.querySelectorAll('input[name="knowledge-share-unit"]:checked')].map(input => input.value).filter(Boolean)
                : [];
            const allowedUserIds = enabled && !allChecked
                ? [...modal.querySelectorAll('input[name="knowledge-share-user"]:checked')]
                    .filter(input => !allowedUnits.includes(input.dataset.shareTreeUserUnit || ''))
                    .map(input => Number(input.value))
                    .filter(Number.isSafeInteger)
                : [];

            if (enabled && !allChecked && !allowedUnits.length && !allowedUserIds.length) {
                setKnowledgeError('共享时至少选择一个单位或一个个人，也可以由管理员共享给全体成员。');
                return;
            }

            setKnowledgeError('');
            saveBtn.disabled = true;

            try {
                const saveRes = await apiFetch(`${API_BASE}/rag/collections/${encodeURIComponent(collectionId)}/sharing`, {
                    method: 'PATCH',
                    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
                    body: JSON.stringify({ scope: enabled ? 'shared' : 'personal', allowedUnits, allowedUserIds })
                });
                const saveData = await saveRes.json().catch(() => ({}));
                if (!saveRes.ok) throw new Error(saveData.error || '共享设置保存失败');

                window.Pivot.legacy.setKnowledgeModalVisibility?.(modal, false);
                showToast('专题库共享设置已更新', 'success');
                await window.Pivot.legacy.loadKnowledgeCollections?.();
                window.Pivot.legacy.loadKnowledgeDocs(1);
            } catch (err) {
                setKnowledgeError(err.message || '共享设置保存失败');
            } finally {
                saveBtn.disabled = false;
            }
        });
    }

    window.Pivot.legacy.setKnowledgeModalVisibility?.(modal, true, { focusSelector: '[name="knowledge-share-scope"]' });
}

window.Pivot?.exposeModule?.('rag.panels', {
    openKnowledgeCollectionShareModal
});

