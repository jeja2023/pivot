// RAG 文档面板与诊断 RAG document panels and diagnostics
// RAG 文档面板功能从 rag-documents.js 拆分而来。
// RAG document panels and diagnostics, split from rag-documents.js.
/* eslint-disable no-undef */
const ensureRagDetailModal = () => {
    let modal = document.getElementById('rag-detail-modal');
    if (modal) return modal;

    modal = document.createElement('div');
    modal.id = 'rag-detail-modal';
    modal.className = 'modal-overlay hidden rag-detail-modal-overlay';
    modal.innerHTML = `
        <div class="modal rag-detail-modal">
            <div class="rag-detail-header">
                <div>
                    <h3 id="rag-detail-title">知识库文档详情</h3>
                    <p id="rag-detail-subtitle" class="model-modal-desc"></p>
                </div>
                <button type="button" id="rag-detail-close-btn" class="btn-danger-outline">关闭</button>
            </div>
            <div id="rag-detail-meta" class="rag-detail-meta"></div>
            <div id="rag-detail-chunks" class="rag-detail-chunks"></div>
        </div>
    `;
    document.body.appendChild(modal);
    modal.addEventListener('click', (event) => {
        if (event.target === modal || event.target.closest('#rag-detail-close-btn')) {
            modal.classList.add('hidden');
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
    modal.innerHTML = `
        <div class="modal rag-detail-modal">
            <div class="rag-detail-header">
                <div>
                    <h3>知识库删除审计</h3>
                    <p class="model-modal-desc">仅 admin 权限层级可见，保留用户删除后的文档元数据、源文件路径与索引状态。</p>
                </div>
                <button type="button" id="rag-audit-close-btn" class="btn-danger-outline">关闭</button>
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
    `;
    document.body.appendChild(modal);
    modal.addEventListener('click', (event) => {
        if (event.target === modal || event.target.closest('#rag-audit-close-btn')) {
            modal.classList.add('hidden');
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

function runRagNextStepAction(action) {
    if (action === 'upload') {
        document.getElementById('rag-upload-btn')?.click();
        return;
    }
    if (action === 'refresh') {
        window.loadKnowledgeDocs?.();
        showToast('已刷新知识库状态', 'success');
        return;
    }
    if (action === 'retry') {
        document.getElementById('rag-retry-failed-btn')?.click();
        return;
    }
    if (action === 'debug') {
        document.getElementById('rag-debug-modal-open-btn')?.click();
        document.getElementById('rag-debug-query')?.focus();
        return;
    }
    if (action === 'chat-rag') {
        enableChatToolFromWorkspace('rag', '已打开聊天里的知识库开关');
    }
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
        meta.innerHTML = items.map(item => `
            <div class="rag-meta-card ${item.class || ''}">
                <div class="rag-meta-label">${item.icon}<span>${escapeRagHtml(item.label)}</span></div>
                <div class="rag-meta-value" title="${escapeRagAttr(item.value)}">${escapeRagHtml(item.value)}</div>
            </div>
        `).join('');
    }
    if (chunkList) {
        chunkList.innerHTML = chunks.length
            ? chunks.map((chunk, index) => `
                <article class="rag-detail-chunk">
                    <header>
                        <strong>#${index + 1}</strong>
                        <span>${Number(chunk.length || String(chunk.content || '').length)} 字</span>
                    </header>
                    <p>${escapeRagHtml(chunk.content || '')}</p>
                </article>
            `).join('')
            : '<div class="rag-debug-empty">暂无可预览分块</div>';
    }
    modal.classList.remove('hidden');
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
        if (body) body.innerHTML = renderRagAuditRows(data.data || []);
        modal.classList.remove('hidden');
    } catch (e) {
        showToast(e.message || '删除审计加载失败', 'error');
    }
};

const renderRagSummary = (summary) => {
    const el = document.getElementById('rag-summary');
    if (!el || !summary) return;
    const total = Number(summary.total || 0);
    const ready = Number(summary.ready || 0);
    const processing = Number(summary.processing || 0);
    const errors = Number(summary.error || 0);
    const retryable = Number(summary.retryableErrors || 0);
    const disabled = Number(summary.disabled || 0);
    const nextStep = (() => {
        if (total === 0) {
            return {
                title: '先上传一份文档',
                detail: '支持 PDF、Word、Excel、CSV、Markdown、网页文本等文件。上传后系统会自动索引文档内容。',
                action: '上传文档',
                actionKey: 'upload'
            };
        }
        if (processing > 0) {
            return {
                title: '正在索引文档',
                detail: '文档还在索引中，完成后会自动变成“就绪”。页面会自动刷新。',
                action: '刷新状态',
                actionKey: 'refresh'
            };
        }
        if (retryable > 0 || errors > 0) {
            return {
                title: '有文档需要处理',
                detail: '失败文档不会参与回答。可以先重试失败项，再查看详情里的错误原因。',
                action: retryable > 0 ? '重试失败文档' : '刷新后查看详情',
                actionKey: retryable > 0 ? 'retry' : 'refresh'
            };
        }
        if (ready === 0) {
            return {
                title: '还没有可用文档',
                detail: '文档可能被停用或尚未索引完成。启用并重新索引后才能被聊天引用。',
                action: '刷新并检查',
                actionKey: 'refresh'
            };
        }
        return {
            title: '可以开始提问',
            detail: '可以先通过召回测试确认命中效果，也可以直接回到聊天并启用知识库。',
            action: disabled > 0 ? '启用聊天知识库' : '召回测试',
            actionKey: disabled > 0 ? 'chat-rag' : 'debug',
            secondaryAction: disabled > 0 ? '召回测试' : '启用聊天知识库',
            secondaryActionKey: disabled > 0 ? 'debug' : 'chat-rag'
        };
    })();
    const items = [
        ['文档', summary.total || 0],
        ['就绪', summary.ready || 0],
        ['处理中', summary.processing || 0],
        ['失败', summary.error || 0],
        ['分块', summary.chunks || 0],
        ['源文件', formatRagSize(summary.sourceSize || 0)],
        ['队列', `${summary.queue?.running || 0}/${summary.queue?.pending || 0}`]
    ];
    const lastError = summary.lastError?.error_message
        ? `<span class="rag-summary-error" title="${escapeRagHtml(summary.lastError.error_message)}">最近错误：${escapeRagHtml(summary.lastError.name || '文档')}</span>`
        : '';
    el.innerHTML = `
        <div class="rag-next-step-card">
            <div>
                <strong>${escapeRagHtml(nextStep.title)}</strong>
                <span>${escapeRagHtml(nextStep.detail)}</span>
            </div>
            <div class="rag-next-step-actions">
                <button class="rag-next-step-action" type="button" data-rag-next-step="${escapeRagHtml(nextStep.actionKey)}">${escapeRagHtml(nextStep.action)}</button>
                ${nextStep.secondaryAction ? `<button class="rag-next-step-action is-secondary" type="button" data-rag-next-step="${escapeRagHtml(nextStep.secondaryActionKey)}">${escapeRagHtml(nextStep.secondaryAction)}</button>` : ''}
            </div>
        </div>
        <div class="rag-summary-items">
            ${items.map(([label, value]) => `<span><b>${escapeRagHtml(value)}</b>${escapeRagHtml(label)}</span>`).join('')}
        </div>
        ${lastError}
    `;
    el.querySelectorAll('[data-rag-next-step]').forEach(button => button.addEventListener('click', (event) => {
        runRagNextStepAction(event.currentTarget.dataset.ragNextStep || '');
    }));

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
    if (!el || !report) return;
    const overview = report.overview || {};
    const signals = report.signals || {};
    const problemDocs = Array.isArray(report.problemDocs) ? report.problemDocs : [];
    const recommendations = Array.isArray(report.recommendations) ? report.recommendations : [];
    const userTips = [
        '文档变更后点击“批量重建”或“重新索引”，确保回答引用的是最新内容。',
        '召回测试结果太少时，换成用户真实会问的问题再测一次。',
        '聊天时需要先点亮输入框旁的知识库按钮，才会引用这些文档。'
    ];
    el.innerHTML = `
        <div class="governance-head">
            <strong>质量诊断</strong>
            <span>评分 ${Number(signals.score || 0)} · 可用 ${Number(signals.readinessRate || 0)}% · 反馈 ${signals.helpfulRate === null || signals.helpfulRate === undefined ? '暂无' : `${Number(signals.helpfulRate || 0)}%`}</span>
        </div>
        <div class="governance-metrics">
            <span><b>${Number(overview.error || 0)}</b>异常</span>
            <span><b>${Number(overview.disabled || 0)}</b>停用</span>
            <span><b>${Number(overview.emptyReady || 0)}</b>空分块</span>
            <span><b>${Number(signals.graphEntities || 0)}</b>图谱实体</span>
        </div>
        <div class="governance-list">
            ${recommendations.slice(0, 3).map(item => `<span>${escapeRagHtml(item)}</span>`).join('')}
            ${userTips.map(item => `<span>${escapeRagHtml(item)}</span>`).join('')}
            ${problemDocs.slice(0, 4).map(doc => `
                <span class="${doc.status === 'error' ? 'is-error' : ''}">
                    ${escapeRagHtml(doc.name || '文档')} · ${escapeRagHtml(getRagStatusLabel(doc.status))} · 分块 ${Number(doc.chunk_count || 0)}
                </span>
            `).join('')}
        </div>
    `;
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

    el.innerHTML = `
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
                const percent = Math.max(0, Math.min(1, score / maxScore)) * 100;
                return `
                <div class="rag-debug-item ${m.matched ? 'matched' : ''}">
                    <div class="rag-debug-item-head">
                        <strong>#${index + 1} ${escapeRagHtml(m.source || '-')}</strong>
                        <span class="rag-debug-score" title="原始相似度">${score.toFixed(3)}${m.matched ? ' 命中' : ''}</span>
                    </div>
                    <div class="rag-debug-score-bar" aria-hidden="true">
                        <div class="rag-debug-score-bar-fill" style="width:${percent.toFixed(1)}%"></div>
                    </div>
                    <p>${highlightChunk(m.text || '')}</p>
                    <div class="rag-feedback-actions">
                        <button class="btn-secondary rag-feedback-btn" data-helpful="true" data-query="${escapeRagHtml(data.query || '')}" data-chunk-id="${m.chunkId || ''}" data-doc-name="${escapeRagHtml(m.source || '')}" data-score="${score}">有用</button>
                        <button class="btn-secondary rag-feedback-btn" data-helpful="false" data-query="${escapeRagHtml(data.query || '')}" data-chunk-id="${m.chunkId || ''}" data-doc-name="${escapeRagHtml(m.source || '')}" data-score="${score}">无用</button>
                    </div>
                </div>
                `;
            }).join('') || '<div class="rag-debug-empty">没有召回到可用分块</div>'}
        </div>
    `;
};
