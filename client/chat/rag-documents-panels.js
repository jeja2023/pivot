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
            window.setKnowledgeModalVisibility?.(modal, false);
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
            window.setKnowledgeModalVisibility?.(modal, false);
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
            <td title="${escapeRagHtml(item.name)}">${escapeRagHtml(item.name)}</td>
            <td>${escapeRagHtml(item.nickname || item.username || `用户 ${item.user_id || '-'}`)}</td>
            <td>${escapeRagHtml(getRagStatusLabel(item.status))}</td>
            <td>${Number(item.indexed_chunks || item.chunk_count || 0)} / ${Number(item.chunk_count || 0)}</td>
            <td title="${escapeRagHtml(item.source_path || '')}">${escapeRagHtml(item.source_path || '-')}</td>
            <td>${formatRagDateToCN(item.deleted_at)}</td>
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
    window.showMainWorkspace?.('chat');
    window.syncChatToolToggles?.();
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
            { icon: RAG_ICONS.status, label: '解析状态', value: getRagStatusLabel(doc.status), class: `status-${doc.status}` },
            { icon: RAG_ICONS.enable, label: '生效状态', value: enabledText, class: enabledText === '已启用' ? 'status-ready' : 'status-error' },
            { icon: RAG_ICONS.progress, label: '索引进度', value: `${Number(doc.progress || 0)}%` },
            { icon: RAG_ICONS.chunks, label: '分块总数', value: Number(data.totalChunks || 0) },
            { icon: RAG_ICONS.time, label: '创建时间', value: formatRagDateToCN(doc.created_at) },
            { icon: RAG_ICONS.time, label: '更新时间', value: formatRagDateToCN(doc.updated_at || doc.processed_at) }
        ];
        PivotSafeHtml.setHtml(meta, items.map(item => `
            <div class="rag-meta-card ${item.class || ''}">
                <div class="rag-meta-label">${item.icon}<span>${escapeRagHtml(item.label)}</span></div>
                <div class="rag-meta-value" title="${escapeRagAttr(item.value)}">${escapeRagHtml(item.value)}</div>
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
                    <p>${escapeRagHtml(chunk.content || '')}</p>
                </article>
            `).join('')
            : '<div class="rag-debug-empty">暂无可预览分块</div>');
    }
    window.setKnowledgeModalVisibility?.(modal, true, { focusSelector: '#rag-detail-close-btn' });
};

window.showKnowledgeDocAudit = async () => {
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
        window.setKnowledgeModalVisibility?.(modal, true, { focusSelector: '#rag-audit-close-btn' });
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
    const metric = ([label, value]) => `<span><b>${escapeRagHtml(value)}</b>${escapeRagHtml(label)}</span>`;
    const docItems = [
        ['文档', summary.total || 0],
        ['就绪', summary.ready || 0],
        ['处理中', summary.processing || 0],
        ['失败', summary.error || 0]
    ];
    const indexItems = [
        ['分块', summary.chunks || 0],
        ['源文件', formatRagSize(summary.sourceSize || 0)],
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
        ? `<span class="rag-summary-error" title="${escapeRagHtml(summary.lastError.error_message)}">最近错误：${escapeRagHtml(summary.lastError.name || '文档')}</span>`
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
    const issueItems = [
        ['异常', Number(overview.error || 0)],
        ['停用', Number(overview.disabled || 0)],
        ['空分块', Number(overview.emptyReady || 0)]
    ].filter(([, value]) => value > 0);
    if (!issueItems.length && !visibleProblems.length) {
        PivotSafeHtml.setHtml(el, '');
        return;
    }
    PivotSafeHtml.setHtml(el, `
        <div class="governance-head">
            <strong>质量诊断</strong>
            <span>${visibleProblems.length ? `发现 ${visibleProblems.length} 个需处理文档` : '存在需关注指标'}</span>
        </div>
        ${issueItems.length ? `
            <div class="governance-metrics">
                ${issueItems.map(([label, value]) => `<span><b>${Number(value || 0)}</b>${escapeRagHtml(label)}</span>`).join('')}
            </div>
        ` : ''}
        ${visibleProblems.length ? `
            <div class="governance-list">
                ${visibleProblems.map(doc => `
                <span class="${doc.status === 'error' ? 'is-error' : ''}">
                    ${escapeRagHtml(doc.name || '文档')} · ${escapeRagHtml(getRagStatusLabel(doc.status))} · 分块 ${Number(doc.chunk_count || 0)}
                </span>
                `).join('')}
            </div>
        ` : ''}
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
                    <button type="button" class="rag-debug-history-item" data-rag-debug-sample="${escapeRagAttr(item.query || '')}">
                        <span class="rag-debug-history-query">${escapeRagHtml(item.query || '-')}</span>
                        <span class="rag-debug-history-meta">命中 ${Number(item.matchedCount || 0)} / 候选 ${Number(item.candidateCount || 0)} / 最高 ${top.toFixed(3)} / 队列 ${escapeRagHtml(queueLabel)} / ${Number(item.elapsedMs || 0)} ms</span>
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
        const escaped = escapeRagHtml(text || '');
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
        <div class="rag-debug-verdict is-${escapeRagHtml(debugVerdict.tone)}">
            <div>
                <strong>${escapeRagHtml(debugVerdict.title)}</strong>
                <span>${escapeRagHtml(debugVerdict.detail)}</span>
            </div>
            <button type="button" data-rag-debug-chat="${escapeRagAttr(data.query || '')}">${escapeRagHtml(debugVerdict.action)}</button>
        </div>
        <div class="rag-debug-meta">
            <span>关键词：${escapeRagHtml((data.keywords || []).join(' / ') || '-')}</span>
            <span>候选：${Number(data.candidateCount || 0)}</span>
            <span>阈值：${Number(data.threshold || 0).toFixed(2)}</span>
            ${rankingMode ? `<span>Mode: ${escapeRagHtml(rankingMode)}</span>` : ''}
            ${hybridLabel ? `<span>Hybrid: ${escapeRagHtml(hybridLabel)}</span>` : ''}
            ${queueLabel ? `<span>Queue: ${escapeRagHtml(queueLabel)}</span>` : ''}
            ${elapsed > 0 ? `<span>检索耗时：${elapsed} ms</span>` : ''}
        </div>
        ${groupedList.length > 1 ? `
            <div class="rag-debug-grouped" role="list">
                ${groupedList.map(g => `
                    <div class="rag-debug-grouped-item" role="listitem">
                        <span class="rag-debug-grouped-source">${escapeRagHtml(g.source)}</span>
                        <span class="rag-debug-grouped-stats">命中 ${g.matched}/${g.count}<span class="rag-debug-grouped-divider">·</span>峰值 ${g.top.toFixed(3)}<span class="rag-debug-grouped-divider">·</span>均值 ${(g.totalScore / g.count).toFixed(3)}</span>
                    </div>
                `).join('')}
            </div>
        ` : ''}
        <div class="rag-debug-list">
            ${matches.map((m, index) => {
        const score = Number(m.score || 0);
        const fusedScore = Number(m.fusedScore ?? m.scores?.fused ?? score);
        const denseRank = m.scores?.denseRank || null;
        const ftsRank = m.scores?.ftsRank || null;
        const percent = Math.max(0, Math.min(1, score / maxScore)) * 100;
        const scoreDetails = [
            `rank #${Number(m.rank || index + 1)}`,
            `dense ${score.toFixed(3)}`,
            `fused ${fusedScore.toFixed(3)}`,
            denseRank ? `dense-rank #${denseRank}` : '',
            ftsRank ? `fts #${ftsRank}` : '',
            m.selected ? 'MMR selected' : ''
        ].filter(Boolean).join(' | ');
        return `
                <div class="rag-debug-item ${m.matched ? 'matched' : ''}">
                    <div class="rag-debug-item-head">
                        <strong>#${index + 1} ${escapeRagHtml(m.source || '-')}</strong>
                        <span class="rag-debug-score" title="Dense / fused / FTS / MMR breakdown">${score.toFixed(3)}${m.matched ? ' HIT' : ''}${m.selected ? ' | MMR' : ''}</span>
                    </div>
                    <div class="rag-debug-score-bar" aria-hidden="true">
                        <div class="rag-debug-score-bar-fill" style="width:${percent.toFixed(1)}%"></div>
                    </div>
                    <div class="rag-debug-score-breakdown">${escapeRagHtml(scoreDetails)}</div>
                    <p>${highlightChunk(m.text || '')}</p>
                    <div class="rag-feedback-actions">
                        <button class="btn-secondary rag-feedback-btn" data-helpful="true" data-query="${escapeRagHtml(data.query || '')}" data-chunk-id="${m.chunkId || ''}" data-doc-name="${escapeRagHtml(m.source || '')}" data-score="${score}">有用</button>
                        <button class="btn-secondary rag-feedback-btn" data-helpful="false" data-query="${escapeRagHtml(data.query || '')}" data-chunk-id="${m.chunkId || ''}" data-doc-name="${escapeRagHtml(m.source || '')}" data-score="${score}">无用</button>
                    </div>
                </div>
                `;
    }).join('') || '<div class="rag-debug-empty">没有召回到可用分块</div>'}
        </div>
    `);
};
