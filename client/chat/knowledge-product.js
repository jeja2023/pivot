/* 产品化知识库工作台：问答、文章版本、局域网来源和索引任务。 */
(() => {
    const tabs = ['search', 'content', 'sources', 'jobs', 'evaluation'];
    let activeTab = 'search';
    const productState = { documents: [], sources: [], jobs: [], evaluationCases: [], evaluationRuns: [], answerMetrics: null };

    const escapeHtml = value => window.Pivot?.legacy?.escapeRagHtml?.(value) || String(value ?? '');
    const escapeAttr = value => window.Pivot?.legacy?.escapeRagAttr?.(value) || String(value ?? '');

    async function fetchKnowledge(url, options = {}) {
        const response = await apiFetch(`${API_BASE}${url}`, {
            ...options,
            headers: { ...authHeaders(), ...(options.headers || {}) }
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.error) throw new Error(data.error || '知识库请求失败');
        return data;
    }

    function renderCitations(citations = []) {
        if (!citations.length) return '<div class="knowledge-product-empty">本次没有可验证引用。</div>';
        return `<div class="knowledge-citation-list">${citations.map(citation => {
            const document = citation.document || {};
            const locator = citation.locator || {};
            const heading = locator.headingPath || locator.sheetName || (locator.page ? `第 ${locator.page} 页` : '定位信息待补充');
            return `<button type="button" class="knowledge-citation-card" data-knowledge-citation="${escapeAttr(citation.citationKey)}">
                <strong>${escapeHtml(document.title || '知识来源')}</strong>
                <span>${escapeHtml(heading)}</span>
                <small>${escapeHtml(String(citation.quotedText || '').slice(0, 180))}</small>
            </button><div class="knowledge-citation-feedback" data-knowledge-citation-feedback="${escapeAttr(citation.citationKey)}">
                <button type="button" class="btn-secondary" data-knowledge-citation-event="helpful">来源有用</button>
                <button type="button" class="btn-secondary" data-knowledge-citation-event="incorrect">引用错误</button>
            </div>`;
        }).join('')}</div>`;
    }

    function renderWikiPages(pages = [], citations = []) {
        if (!pages.length) return '';
        const sourceText = (Array.isArray(citations) ? citations : []).map(citation => {
            const label = `${citation.pageTitle || 'Wiki 综合页'} → ${citation.title || '原始依据'}${citation.headingPath ? ` / ${citation.headingPath}` : ''}`;
            return citation.citationKey
                ? `<button type="button" class="btn-secondary knowledge-citation-card" data-knowledge-citation="${escapeAttr(citation.citationKey)}">${escapeHtml(label)}</button>`
                : `<span>${escapeHtml(label)}</span>`;
        }).join('');
        return `<section class="knowledge-wiki-answer-sources"><strong>Wiki 综合（原始依据优先）</strong><div class="knowledge-wiki-page-list">${pages.map(page => `<span>${escapeHtml(page.title || 'Wiki 综合页')}（${Number(page.sourceCount || page.sourceCoverage?.sourceCount || 0)} 条来源）</span>`).join('')}</div>${sourceText ? `<div class="knowledge-citation-list">${sourceText}</div>` : ''}</section>`;
    }

    function renderSearchResults(items = []) {
        const target = document.getElementById('knowledge-product-results');
        if (!target) return;
        const verifiedItems = (Array.isArray(items) ? items : []).filter(item => item?.selected === true);
        if (!verifiedItems.length) {
            PivotSafeHtml.setHtml(target, '<div class="knowledge-product-empty">本轮未找到达到证据要求的相关资料，已隐藏未通过相关性与可信度校验的候选。</div>');
            return;
        }
        PivotSafeHtml.setHtml(target, `<div class="knowledge-search-result-list">${verifiedItems.slice(0, 12).map(item => `
            <article class="knowledge-search-result ${item.selected ? 'is-selected' : ''}">
                <header><strong>${escapeHtml(item.documentName || item.source || '知识片段')}</strong><span>${Number(item.citationConfidence || 0) > 0 ? `可信度 ${Math.round(Number(item.citationConfidence) * 100)}%` : `相关度 ${Number(item.score || 0).toFixed(3)}`}</span></header>
                <small>${escapeHtml(item.headingPath || `片段 ${Number(item.chunkIndex || 0) + 1}`)}</small>
                <p>${escapeHtml(item.text || '')}</p>
            </article>`).join('')}</div>`);
    }

    function renderAnswer(data = {}) {
        const target = document.getElementById('knowledge-product-answer');
        if (!target) return;
        const warnings = Array.isArray(data.warnings) ? data.warnings : [];
        const grounding = data.grounding && typeof data.grounding === 'object' ? data.grounding : null;
        const groundingLabel = grounding?.accepted
            ? '依据已核验'
            : grounding?.status === 'insufficient_evidence'
                ? '证据不足'
                : grounding ? '依据待补充' : '待核验';
        PivotSafeHtml.setHtml(target, `
            <article class="knowledge-answer-card">
                <header><strong>知识库回答</strong><span>${data.modelName ? `${escapeHtml(data.modelName)} · ` : ''}${escapeHtml(knowledgeRetrievalModeLabel(data.retrievalMode))} · ${escapeHtml(groundingLabel)}</span></header>
                <div class="knowledge-answer-copy">${escapeHtml(data.answer || '')}</div>
                ${warnings.length ? `<div class="knowledge-answer-warnings">${warnings.map(escapeHtml).join('；')}</div>` : ''}
                <div class="knowledge-answer-sources"><strong>可验证来源</strong>${renderCitations(data.citations || [])}</div>
                ${renderWikiPages(data.wikiPages || [], data.wikiCitations || [])}
            </article>`);
    }

    function knowledgeRetrievalModeLabel(value = '') {
        const labels = {
            hybrid_dual_rrf_mmr: '混合检索',
            keyword_fallback: '关键词降级检索',
            confidence_rejected: '候选未通过相关性与可信度校验',
            no_candidates: '未找到候选资料',
            empty_query: '未输入有效问题'
        };
        const modes = String(value || '').split(/\s*\+\s*/).map(mode => String(mode || '').trim()).filter(Boolean);
        if (!modes.length) return '检索状态待确认';
        return [...new Set(modes.map(mode => labels[mode] || '自适应检索'))].join('、');
    }

    async function runKnowledgeSearch({ ask = false } = {}) {
        const query = document.getElementById('knowledge-product-query')?.value?.trim();
        if (!query) return showToast('请输入知识库问题', 'error');
        const modelSelect = document.getElementById('knowledge-product-model');
        const modelId = ask ? String(modelSelect?.value || '').trim() : '';
        if (ask && (!modelId || modelSelect?.disabled)) return showToast('请先选择可用的回答模型', 'error');
        const answer = document.getElementById('knowledge-product-answer');
        const results = document.getElementById('knowledge-product-results');
        if (answer) PivotSafeHtml.setHtml(answer, '<div class="knowledge-product-loading">正在检索可验证知识…</div>');
        if (results) PivotSafeHtml.setHtml(results, '');
        const filters = {
            ...(document.getElementById('knowledge-filter-verified')?.value ? { verifiedStatus: document.getElementById('knowledge-filter-verified').value } : {}),
            ...(document.getElementById('knowledge-filter-source-kind')?.value ? { sourceKind: document.getElementById('knowledge-filter-source-kind').value } : {}),
            ...(document.getElementById('knowledge-filter-updated-after')?.value ? { updatedAfter: document.getElementById('knowledge-filter-updated-after').value } : {})
        };
        const scope = window.Pivot.legacy.getRagScopeSelection?.('chat') || {};
        try {
            const data = await fetchKnowledge(ask ? '/knowledge/ask' : '/knowledge/search', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query, scope, filters, ...(ask ? { model: modelId } : {}) })
            });
            if (ask) {
                renderAnswer(data);
                renderSearchResults(data.results || []);
            } else {
                if (answer) PivotSafeHtml.setHtml(answer, `<div class="knowledge-search-summary">已检索 ${Number(data.candidateCount || 0)} 个候选，当前模式：${escapeHtml(knowledgeRetrievalModeLabel(data.retrievalMode))}</div>${renderCitations(data.citations || [])}${renderWikiPages(data.wikiPages || [], data.wikiCitations || [])}`);
                renderSearchResults(data.results || []);
            }
        } catch (error) {
            if (answer) PivotSafeHtml.setHtml(answer, `<div class="knowledge-product-error">${escapeHtml(error.message || '知识检索失败')}</div>`);
        }
    }

    function documentStatusLabel(status) {
        return ({ draft: '草稿', review: '审核中', published: '已发布', expired: '已过期', archived: '已归档' })[status] || status || '-';
    }

    function verifiedStatusLabel(status) {
        return ({ verified: '已验证', unverified: '待验证', expired: '已过期' })[status] || status || '待验证';
    }

    function lifecycleStatusClass(status) {
        return ({ draft: 'is-draft', review: 'is-review', published: 'is-published', expired: 'is-expired', archived: 'is-archived' })[status] || 'is-draft';
    }

    function verifiedStatusClass(status) {
        return ({ verified: 'is-verified', unverified: 'is-unverified', expired: 'is-expired' })[status] || 'is-unverified';
    }

    function renderDocuments() {
        const target = document.getElementById('knowledge-product-documents');
        if (!target) return;
        if (!productState.documents.length) {
            PivotSafeHtml.setHtml(target, '<div class="knowledge-product-empty">暂无产品化知识内容。上传资料完成索引后会自动形成文档版本。</div>');
            return;
        }
        PivotSafeHtml.setHtml(target, `
            <div class="table-container workspace-table-wrap">
                <table class="data-table">
                    <thead>
                        <tr>
                            <th class="text-center knowledge-column-index">序号</th>
                            <th class="knowledge-column-document-title">文档名称</th>
                            <th class="text-center knowledge-column-status">状态</th>
                            <th class="text-center knowledge-column-verification">验证状态</th>
                            <th class="text-center knowledge-column-review-date">复核时间</th>
                            <th class="text-center knowledge-column-actions">操作</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${productState.documents.map((item, index) => `
                            <tr>
                                <td class="text-center">${index + 1}</td>
                                <td aria-label="文档名称：${escapeAttr(item.title || '未命名文档')}"><strong>${escapeHtml(item.title || '未命名文档')}</strong></td>
                                <td class="text-center"><span class="status-badge ${lifecycleStatusClass(item.lifecycle_status)}">${escapeHtml(documentStatusLabel(item.lifecycle_status))}</span></td>
                                <td class="text-center"><span class="status-badge ${verifiedStatusClass(item.verified_status)}">${escapeHtml(verifiedStatusLabel(item.verified_status))}</span></td>
                                <td class="text-center">${item.review_due_at ? escapeHtml(item.review_due_at) : '<span class="text-muted">—</span>'}</td>
                                <td class="text-center">
                                    <div class="knowledge-product-table-actions">
                                        <button type="button" class="btn-secondary" data-knowledge-document="${item.id}">版本</button>
                                        <button type="button" class="btn-secondary" data-knowledge-new-version="${item.id}">新草稿</button>
                                        <button type="button" class="btn-secondary" data-knowledge-governance="${item.id}">治理</button>
                                        ${item.verified_status !== 'verified' || item.lifecycle_status === 'expired' ? `<button type="button" class="btn-secondary" data-knowledge-verify="${item.id}">验证</button>` : ''}
                                        <button type="button" class="btn-secondary" data-knowledge-comments="${item.id}">评论</button>
                                        ${item.lifecycle_status !== 'archived' ? `<button type="button" class="btn-danger-outline" data-knowledge-archive="${item.id}">归档</button>` : ''}
                                    </div>
                                </td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
        `);
    }

    async function loadDocuments() {
        const data = await fetchKnowledge('/knowledge/documents?limit=100');
        productState.documents = data.data || [];
        renderDocuments();
    }

    function sourceKindLabel(kind) {
        return ({
            local_dir: '局域网目录',
            lan_http: '内网 HTTP',
            database: '只读数据库',
            internal_api: '内部 API',
            webdav: 'WebDAV 目录',
            upload: '本地上传',
            manual: '知识文章'
        })[kind] || kind || '-';
    }

    function sourceStatusLabel(source) {
        const kind = sourceKindLabel(source.kind);
        const statusMap = { active: '运行中', paused: '已暂停', error: '异常' };
        const status = statusMap[source.status] || source.status || '-';
        const syncMode = source.syncMode === 'scheduled' ? '定时' : '手动';
        const base = `${kind} · ${syncMode} · ${status}`;
        return source.lastSyncAt ? `${base} · 最近同步 ${window.Pivot.legacy.formatRagDateToCN?.(source.lastSyncAt) || source.lastSyncAt}` : base;
    }

    function renderSources() {
        const target = document.getElementById('knowledge-product-sources');
        if (!target) return;
        if (!productState.sources.length) {
            PivotSafeHtml.setHtml(target, '<div class="knowledge-product-empty">暂无局域网数据源。可点击右上角“新建数据源”添加白名单目录、内网 HTTP/API 或只读数据库。</div>');
            return;
        }
        PivotSafeHtml.setHtml(target, productState.sources.map(item => `
            <article class="knowledge-product-row">
                <div><strong>${escapeHtml(item.name || '未命名来源')}</strong><span>${escapeHtml(sourceStatusLabel(item))}${item.lastError ? ` · ${escapeHtml(item.lastError)}` : ''}</span></div>
                <div class="knowledge-product-row-actions">
                    <button type="button" class="btn-primary" data-knowledge-sync-source="${item.id}" ${item.status !== 'active' ? 'disabled' : ''}>立即同步</button>
                    <button type="button" class="btn-secondary" data-knowledge-source-runs="${item.id}">记录</button>
                    ${isSuperAdminUser() ? `<button type="button" class="btn-secondary" data-knowledge-source-review-deletion="${item.id}">审核删除</button>` : ''}
                    <button type="button" class="btn-secondary" data-knowledge-toggle-source="${item.id}" data-source-status="${escapeAttr(item.status)}">${item.status === 'active' ? '暂停' : '恢复'}</button>
                </div>
            </article>`).join(''));
    }

    async function loadSources() {
        const data = await fetchKnowledge('/knowledge/sources?kind=lan');
        productState.sources = (data.data || []).filter(s => s.kind !== 'upload' && s.kind !== 'manual');
        renderSources();
    }

    function jobStatusLabel(status) {
        return ({ completed: '已完成', running: '处理中', queued: '排队中', retry_wait: '等待重试', failed: '失败', cancelled: '已取消' })[status] || status || '-';
    }

    function jobStatusClass(status) {
        return ({ completed: 'is-completed', running: 'is-running', queued: 'is-queued', retry_wait: 'is-retry', failed: 'is-failed', cancelled: 'is-cancelled' })[status] || 'is-queued';
    }

    function renderJobs() {
        const target = document.getElementById('knowledge-product-jobs');
        if (!target) return;
        if (!productState.jobs.length) {
            PivotSafeHtml.setHtml(target, '<div class="knowledge-product-empty">暂无索引任务记录。</div>');
            return;
        }
        PivotSafeHtml.setHtml(target, `
            <div class="table-container workspace-table-wrap">
                <table class="data-table">
                    <thead>
                        <tr>
                            <th class="text-center knowledge-column-index">序号</th>
                            <th class="text-center knowledge-column-job-document">文档</th>
                            <th class="text-center knowledge-column-status">状态</th>
                            <th class="text-center knowledge-column-job-stage">阶段</th>
                            <th class="text-center knowledge-column-job-attempts">尝试次数</th>
                            <th class="knowledge-column-job-error">错误信息</th>
                            <th class="text-center knowledge-column-updated-at">更新时间</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${productState.jobs.map((item, index) => `
                            <tr>
                                <td class="text-center">${index + 1}</td>
                                <td class="text-center" aria-label="关联文档：${Number(item.doc_id || 0)}"><strong>文档 #${Number(item.doc_id || 0)}</strong></td>
                                <td class="text-center"><span class="status-badge ${jobStatusClass(item.status)}">${escapeHtml(jobStatusLabel(item.status))}</span></td>
                                <td class="text-center" aria-label="处理阶段：${escapeAttr(item.stage || '-')}"><code class="knowledge-stage-code">${escapeHtml(item.stage || '-')}</code></td>
                                <td class="text-center">${Number(item.attempts || 0)} / ${Number(item.max_attempts || 0)}</td>
                                <td>${item.error_message ? `<span class="knowledge-job-error" aria-label="错误信息：${escapeAttr(item.error_message)}">${escapeHtml(item.error_message)}</span>` : '<span class="text-muted">—</span>'}</td>
                                <td class="text-center">${escapeHtml(item.updated_at || '—')}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
        `);
    }

    async function loadJobs() {
        const data = await fetchKnowledge('/knowledge/ingestion-jobs?limit=100');
        productState.jobs = data.data || [];
        renderJobs();
    }

    function percentage(value) {
        return Number.isFinite(Number(value)) ? `${Math.round(Number(value) * 100)}%` : '—';
    }

    const EVALUATION_STATUS_LABELS = Object.freeze({
        queued: '等待执行',
        running: '评测中',
        retry_wait: '等待重试',
        completed: '已完成',
        failed: '执行失败',
        cancelled: '已取消'
    });

    const EVALUATION_METRIC_LABELS = Object.freeze({
        recallAt1: { label: '前 1 条召回率', format: 'percentage' },
        recallAt3: { label: '前 3 条召回率', format: 'percentage' },
        recallAt5: { label: '前 5 条召回率', format: 'percentage' },
        precisionAt1: { label: '前 1 条准确率', format: 'percentage' },
        precisionAt3: { label: '前 3 条准确率', format: 'percentage' },
        precisionAt5: { label: '前 5 条准确率', format: 'percentage' },
        mrr: { label: '平均倒数排名', format: 'score' },
        ndcgAt5: { label: '前 5 条排序质量', format: 'score' },
        citationPrecision: { label: '引用准确率', format: 'percentage' },
        citationRecall: { label: '引用召回率', format: 'percentage' },
        citationF1: { label: '引用综合得分', format: 'score' },
        answerPointCoverage: { label: '答案要点覆盖率', format: 'percentage' },
        abstentionAccuracy: { label: '拒答准确率', format: 'percentage' },
        groundingAcceptanceRate: { label: '依据核验通过率', format: 'percentage' }
    });

    function evaluationStatusLabel(status) {
        return EVALUATION_STATUS_LABELS[String(status || '').toLowerCase()] || '状态未知';
    }

    function evaluationMetricValue(metricKey, value) {
        const meta = EVALUATION_METRIC_LABELS[metricKey] || { format: 'score' };
        if (!Number.isFinite(Number(value))) return '—';
        return meta.format === 'percentage' ? percentage(value) : Number(value).toFixed(3);
    }

    function evaluationMetricText(metricKey, value) {
        const meta = EVALUATION_METRIC_LABELS[metricKey] || { label: '评测指标' };
        return `${meta.label} ${evaluationMetricValue(metricKey, value)}`;
    }

    function evaluationMetricDeltaText(metricKey, value) {
        const meta = EVALUATION_METRIC_LABELS[metricKey] || { label: '评测指标', format: 'score' };
        if (!Number.isFinite(Number(value))) return '';
        const number = Number(value);
        const sign = number > 0 ? '+' : '';
        const delta = meta.format === 'percentage'
            ? `${sign}${(number * 100).toFixed(1)} 个百分点`
            : `${sign}${number.toFixed(3)}`;
        return `${meta.label}：${delta}`;
    }

    function renderEvaluation() {
        const summary = document.getElementById('knowledge-product-evaluation-summary');
        const casesTarget = document.getElementById('knowledge-product-evaluation-cases');
        const runsTarget = document.getElementById('knowledge-product-evaluation-runs');
        const latest = productState.evaluationRuns[0];
        if (summary) {
            const metrics = latest?.summary || {};
            const evaluationSummary = latest ? `
                <div class="knowledge-search-summary"><strong>${escapeHtml(latest.name || '最近评测')}</strong> · ${escapeHtml(evaluationStatusLabel(latest.status))}
                · ${escapeHtml(evaluationMetricText('recallAt3', metrics.recallAt3))} · ${escapeHtml(evaluationMetricText('mrr', metrics.mrr))}
                · ${escapeHtml(evaluationMetricText('ndcgAt5', metrics.ndcgAt5))}
                · ${escapeHtml(evaluationMetricText('abstentionAccuracy', metrics.abstentionAccuracy))} · ${escapeHtml(evaluationMetricText('groundingAcceptanceRate', metrics.groundingAcceptanceRate))}</div>` : '<div class="knowledge-product-empty">尚未运行评测。先建立一组有标准答案的业务问题。</div>';
            const live = productState.answerMetrics;
            const liveSummary = live
                ? `<div class="knowledge-product-summary-metrics">近 ${Number(live.days || 30)} 天线上问答：${Number(live.total || 0)} 次 · 依据核验 ${percentage(live.acceptanceRate)} · 平均候选 ${Number(live.averageCandidates || 0).toFixed(1)} · 平均依据 ${Number(live.averageSources || 0).toFixed(1)}</div>`
                : '';
            PivotSafeHtml.setHtml(summary, `${evaluationSummary}${liveSummary}`);
        }
        if (casesTarget) {
            PivotSafeHtml.setHtml(casesTarget, productState.evaluationCases.length ? productState.evaluationCases.map(item => `
                <article class="knowledge-product-row"><div><strong>${escapeHtml(item.name || '未命名问题')}</strong><span>${escapeHtml(item.query || '')} · 预期文档 ${Number(item.expectedDocumentIds?.length || 0)} · 预期片段 ${Number(item.expectedChunkIds?.length || 0)}</span></div><div class="knowledge-product-row-actions"><button type="button" class="btn-danger-outline" data-knowledge-delete-eval-case="${item.id}">删除</button></div></article>`).join('') : '<div class="knowledge-product-empty">暂无黄金问题集。</div>');
        }
        if (runsTarget) {
            PivotSafeHtml.setHtml(runsTarget, productState.evaluationRuns.length ? productState.evaluationRuns.map(item => `
                <article class="knowledge-product-row"><div><strong>${escapeHtml(item.name || '知识库评测')}</strong><span>${escapeHtml(evaluationStatusLabel(item.status))} · ${escapeHtml(evaluationMetricText('recallAt3', item.summary?.recallAt3))} · ${escapeHtml(evaluationMetricText('mrr', item.summary?.mrr))} · ${escapeHtml(evaluationMetricText('citationF1', item.summary?.citationF1))} · ${escapeHtml(item.completedAt || item.createdAt || '')}${item.errorMessage ? ` · ${escapeHtml(item.errorMessage)}` : ''}</span></div><div class="knowledge-product-row-actions"><button type="button" class="btn-secondary" data-knowledge-eval-run="${item.id}">详情</button>${productState.evaluationRuns.length > 1 ? `<button type="button" class="btn-secondary" data-knowledge-eval-compare="${item.id}">与上一轮比较</button>` : ''}</div></article>`).join('') : '');
        }
    }

    async function loadEvaluation() {
        const [cases, runs, answerMetrics] = await Promise.all([
            fetchKnowledge('/knowledge/evaluations/cases?limit=200'),
            fetchKnowledge('/knowledge/evaluations/runs?limit=50'),
            fetchKnowledge('/knowledge/answers/metrics?days=30').catch(() => ({ metrics: null }))
        ]);
        productState.evaluationCases = cases.data || [];
        productState.evaluationRuns = runs.data || [];
        productState.answerMetrics = answerMetrics.metrics || null;
        renderEvaluation();
    }

    async function refreshActiveTab() {
        if (activeTab === 'search') {
            const modelId = await window.Pivot.legacy.PivotAppModels?.refresh?.('knowledge', 'knowledge-product-model');
            const askButton = document.getElementById('knowledge-product-ask');
            if (askButton) askButton.disabled = !modelId;
            return;
        }
        if (activeTab === 'content') return loadDocuments();
        if (activeTab === 'sources') return loadSources();
        if (activeTab === 'jobs') return loadJobs();
        if (activeTab === 'evaluation') return loadEvaluation();
    }

    function getProductModal() {
        return document.getElementById('knowledge-product-modal');
    }

    function isProductModalOpen() {
        const modal = getProductModal();
        return Boolean(modal && !modal.classList.contains('hidden'));
    }

    function switchTab(name, { focusPanel = false } = {}) {
        if (!tabs.includes(name)) return;
        activeTab = name;
        const modal = getProductModal();
        if (modal) {
            modal.dataset.activeTab = name;
            modal.querySelector('.knowledge-product-modal')?.setAttribute('data-active-tab', name);
        }
        document.querySelectorAll('[data-knowledge-product-tab]').forEach(button => {
            const active = button.dataset.knowledgeProductTab === name;
            button.classList.toggle('is-active', active);
            button.setAttribute('aria-selected', active ? 'true' : 'false');
        });
        document.querySelectorAll('[data-knowledge-product-panel]').forEach(panel => {
            panel.classList.toggle('hidden', panel.dataset.knowledgeProductPanel !== name);
        });
        if (focusPanel) document.querySelector(`[data-knowledge-product-panel="${name}"]`)?.focus?.();
        refreshActiveTab().catch(error => showToast(error.message || '加载知识库数据失败', 'error'));
    }

    function openKnowledgeProduct(tab = 'search') {
        const modal = getProductModal();
        if (!modal) return;
        switchTab(tabs.includes(tab) ? tab : 'search');
        window.Pivot.legacy.setKnowledgeModalVisibility?.(modal, true, {
            focusSelector: activeTab === 'search' ? '#knowledge-product-query' : `[data-knowledge-product-tab="${activeTab}"]`
        });
    }

    function closeKnowledgeProduct() {
        window.Pivot.legacy.setKnowledgeModalVisibility?.(getProductModal(), false);
    }

    async function showCitation(key) {
        try {
            const data = await fetchKnowledge(`/knowledge/citations/${encodeURIComponent(key)}`);
            const citation = data.citation || {};
            const page = Number(citation.locator?.page || 0);
            const pageText = page > 0 ? `第 ${page}${Number(citation.locator?.pageEnd) > page ? `–${Number(citation.locator.pageEnd)}` : ''} 页` : '未记录页码';
            const copy = `${citation.document?.title || '来源'}\n${citation.locator?.headingPath || ''} ${pageText}\n\n${citation.quotedText || ''}`;
            const sourceUrl = String(citation.sourceUrl || '');
            const versionId = Number(citation.document?.versionId || 0);
            if (/^\/api\/knowledge\/documents\/\d+\/source$/.test(sourceUrl) && page > 0 && Number.isSafeInteger(versionId) && versionId > 0) {
                const open = await window.Pivot.legacy.showConfirm?.('知识来源', `${copy}\n\n确定后查看原文高亮预览；无法定位时可打开原文页码。`);
                if (open) {
                    const response = await apiFetch(`${API_BASE}/knowledge/citations/${encodeURIComponent(key)}/highlight`, { headers: authHeaders() });
                    if (response.ok) {
                        const url = URL.createObjectURL(await response.blob());
                        window.open(url, '_blank', 'noopener,noreferrer');
                        window.setTimeout(() => URL.revokeObjectURL(url), 60000);
                    } else {
                        showToast('无法精确高亮，已打开原文页码。', 'info');
                        window.open(`${sourceUrl}?inline=1&versionId=${versionId}#page=${page}`, '_blank', 'noopener,noreferrer');
                    }
                }
            } else await window.Pivot.legacy.showAlert?.('知识来源', copy);
        } catch (error) {
            showToast(error.message || '引用预览失败', 'error');
        }
    }

    async function sendCitationEvent(button) {
        const key = button.closest('[data-knowledge-citation-feedback]')?.dataset.knowledgeCitationFeedback;
        const eventType = button.dataset.knowledgeCitationEvent;
        if (!key || !eventType) return;
        await fetchKnowledge(`/knowledge/citations/${encodeURIComponent(key)}/events`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ eventType })
        });
        button.parentElement?.querySelectorAll('button').forEach(item => { item.disabled = true; });
        button.textContent = '已记录';
        showToast('引用反馈已记录。');
    }

    async function createArticle() {
        const title = await window.Pivot.legacy.showInputPrompt?.({ title: '新建知识文章', label: '文章标题', placeholder: '例如：采购审批操作指南' });
        if (!title) return;
        const content = await window.Pivot.legacy.showInputPrompt?.({ title: '新建知识文章', label: '文章正文', placeholder: '输入可沉淀为正式知识的内容', multiline: true });
        if (!content) return;
        const data = await fetchKnowledge('/knowledge/articles', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, content })
        });
        showToast('知识文章草稿已创建；可在版本中提交审核并发布。');
        await loadDocuments();
        return data;
    }

    async function createArticleVersion(documentId) {
        const title = await window.Pivot.legacy.showInputPrompt?.({ title: '创建草稿版本', label: '版本标题', placeholder: '输入新版标题' });
        if (!title) return;
        const content = await window.Pivot.legacy.showInputPrompt?.({ title: '创建草稿版本', label: '版本正文', placeholder: '输入新版正文', multiline: true });
        if (!content) return;
        await fetchKnowledge(`/knowledge/documents/${encodeURIComponent(documentId)}/versions`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, content })
        });
        showToast('草稿版本已创建。');
        await loadDocuments();
    }

    async function createDraftFromChat() {
        const sessionId = await window.Pivot.legacy.showInputPrompt?.({ title: '从会话沉淀知识', label: '会话 ID', placeholder: '输入当前或历史会话 ID' });
        if (!sessionId) return;
        const title = await window.Pivot.legacy.showInputPrompt?.({ title: '从会话沉淀知识', label: '草稿标题（可选）', placeholder: '留空使用会话标题', required: false });
        await fetchKnowledge('/knowledge/drafts/from-chat', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId, ...(title ? { title } : {}) })
        });
        showToast('会话已沉淀为待审核知识草稿。');
        await loadDocuments();
    }

    async function createDraftFromAgent() {
        const runId = await window.Pivot.legacy.showInputPrompt?.({ title: '从 Agent 沉淀知识', label: 'Agent 运行 ID', placeholder: '输入已完成的 Agent 运行 ID' });
        if (!runId) return;
        const title = await window.Pivot.legacy.showInputPrompt?.({ title: '从 Agent 沉淀知识', label: '草稿标题（可选）', placeholder: '留空使用运行标题', required: false });
        await fetchKnowledge('/knowledge/drafts/from-agent', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId, ...(title ? { title } : {}) })
        });
        showToast('Agent 运行已沉淀为待审核知识草稿。');
        await loadDocuments();
    }

    async function showDocumentVersions(documentId) {
        const data = await fetchKnowledge(`/knowledge/documents/${encodeURIComponent(documentId)}/versions`);
        const modal = ensureVersionModal();
        const title = modal.querySelector('#knowledge-version-modal-title');
        const body = modal.querySelector('#knowledge-version-modal-body');
        if (title) title.textContent = data.document?.title || '文档版本';
        if (body) PivotSafeHtml.setHtml(body, (data.versions || []).map((version, index, all) => `
            <article class="knowledge-product-row">
                <div><strong>v${Number(version.version_no || 0)} · ${escapeHtml(documentStatusLabel(version.status))}</strong><span>${escapeHtml(version.change_summary || '无变更说明')} · ${escapeHtml(version.updated_at || '')}</span></div>
                <div class="knowledge-product-row-actions">
                    ${version.status === 'draft' ? `<button type="button" class="btn-secondary" data-knowledge-version-action="submit" data-knowledge-version-id="${version.id}" data-knowledge-document-id="${documentId}">提交审核</button>` : ''}
                    ${version.status === 'review' ? `<button type="button" class="btn-secondary" data-knowledge-version-action="approve" data-knowledge-version-id="${version.id}" data-knowledge-document-id="${documentId}">通过审核</button><button type="button" class="btn-danger-outline" data-knowledge-version-action="reject" data-knowledge-version-id="${version.id}" data-knowledge-document-id="${documentId}">退回草稿</button>` : ''}
                    ${['draft', 'review'].includes(version.status) ? `<button type="button" class="btn-primary" data-knowledge-version-action="publish" data-knowledge-version-id="${version.id}" data-knowledge-document-id="${documentId}">发布</button>` : ''}
                    ${all[index + 1] ? `<button type="button" class="btn-secondary" data-knowledge-version-diff data-knowledge-document-id="${documentId}" data-knowledge-from-version-id="${all[index + 1].id}" data-knowledge-to-version-id="${version.id}">差异</button>` : ''}
                </div>
            </article>`).join('') || '<div class="knowledge-product-empty">暂无版本</div>');
        window.Pivot.legacy.setKnowledgeModalVisibility?.(modal, true, { focusSelector: '#knowledge-version-modal-close' });
    }

    function ensureVersionModal() {
        let modal = document.getElementById('knowledge-product-version-modal');
        if (modal) return modal;
        modal = document.createElement('div');
        modal.id = 'knowledge-product-version-modal';
        modal.className = 'modal-overlay hidden rag-detail-modal-overlay knowledge-product-version-modal-overlay';
        modal.style.zIndex = '6200';
        modal.dataset.knowledgeModal = '1';
        modal.setAttribute('aria-hidden', 'true');
        PivotSafeHtml.setHtml(modal, `
            <div class="modal rag-detail-modal knowledge-version-modal" role="dialog" aria-modal="true" aria-labelledby="knowledge-version-modal-title">
                <div class="rag-detail-header"><div><h3 id="knowledge-version-modal-title">文档版本</h3><p class="model-modal-desc">草稿需审核或由所有者直接发布；发布会原子切换正式检索版本。</p></div><button type="button" id="knowledge-version-modal-close" class="btn-danger-outline" data-knowledge-modal-close>关闭</button></div>
                <div id="knowledge-version-modal-body" class="knowledge-product-list"></div>
            </div>`);
        document.body.appendChild(modal);
        modal.addEventListener('click', event => {
            if (event.target === modal || event.target.closest('#knowledge-version-modal-close')) window.Pivot.legacy.setKnowledgeModalVisibility?.(modal, false);
        });
        return modal;
    }

    const SOURCE_CONFIG_TEMPLATES = {
        webdav: {
            template: JSON.stringify({ url: 'https://example.invalid/documents/', credentialRef: 'WEBDAV_TOKEN', maxFiles: 100, recursive: false, maxDepth: 3, syncDeletes: false }, null, 2),
            tip: '可启用受限子目录遍历和删除同步保护；不继承源端 ACL。凭据引用须为 Bearer 令牌。'
        },
        local_dir: {
            template: JSON.stringify({ rootPath: "D:/knowledge", recursive: true }, null, 2),
            tip: '目录需在环境变量白名单 KNOWLEDGE_LOCAL_SOURCE_ROOTS 内。'
        },
        lan_http: {
            template: JSON.stringify({ url: "http://192.168.1.100/policies/", crawl: { pathPrefix: "/policies/", selector: "main", waitForSelector: "main article", maxPages: 10 } }, null, 2),
            tip: '动态网页可配置 crawl；凭据仅引用凭据库，不粘贴密钥。普通 JSON 清单删除 crawl 即可。网页抓取不自动删除已有知识。'
        },
        database: {
            template: JSON.stringify({ connectionId: "db-conn-1", queryTemplateId: 1 }, null, 2),
            tip: '需引用已配置的安全只读数据库连接与查询模板。'
        },
        internal_api: {
            template: JSON.stringify({ endpoint: "http://internal-service/api/docs", method: "GET" }, null, 2),
            tip: '需为公司内网认证通过的文档接口。'
        }
    };

    function openSourceModal() {
        const modal = document.getElementById('knowledge-source-modal');
        if (!modal) return;
        const kindSelect = document.getElementById('knowledge-source-kind');
        const nameInput = document.getElementById('knowledge-source-name');
        const configTextarea = document.getElementById('knowledge-source-config');
        const tipEl = document.getElementById('knowledge-source-config-tip');
        if (nameInput) nameInput.value = '';
        if (kindSelect) kindSelect.value = 'local_dir';
        if (configTextarea) configTextarea.value = SOURCE_CONFIG_TEMPLATES.local_dir.template;
        if (tipEl) tipEl.textContent = SOURCE_CONFIG_TEMPLATES.local_dir.tip;
        window.Pivot.legacy.setKnowledgeModalVisibility?.(modal, true, { focusSelector: '#knowledge-source-name' });
    }

    function closeSourceModal() {
        const modal = document.getElementById('knowledge-source-modal');
        if (modal) window.Pivot.legacy.setKnowledgeModalVisibility?.(modal, false);
    }

    async function handleSourceSubmit(event) {
        event?.preventDefault?.();
        const kind = document.getElementById('knowledge-source-kind')?.value || 'local_dir';
        const name = document.getElementById('knowledge-source-name')?.value?.trim();
        if (!name) return showToast('请输入数据源名称', 'error');
        const configText = document.getElementById('knowledge-source-config')?.value?.trim();
        let config = {};
        if (configText) {
            try {
                config = JSON.parse(configText);
            } catch (_) {
                return showToast('配置参数必须是有效 JSON', 'error');
            }
        }
        try {
            await fetchKnowledge('/knowledge/sources', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, kind, config, syncMode: 'manual' })
            });
            showToast('局域网数据源已创建。');
            closeSourceModal();
            await loadSources();
        } catch (error) {
            showToast(error.message || '创建数据源失败', 'error');
        }
    }

    async function syncSource(id) {
        showToast('正在同步局域网数据源…', 'info');
        try {
            const data = await fetchKnowledge(`/knowledge/sources/${encodeURIComponent(id)}/sync`, { method: 'POST' });
            const result = data.result || {};
            const partial = result.scanComplete === false || result.deletionBlocked || result.failures?.length;
            showToast(`${partial ? '同步部分完成，请检查扫描范围、失败项或删除保护' : '同步完成'}：新增 ${Number(result.created || 0)}，更新 ${Number(result.changed || 0)}，入队 ${Number(result.queued || 0)}。`, partial ? 'info' : 'success');
            await Promise.all([loadSources(), loadJobs()]);
        } catch (error) {
            showToast(error.message || '同步失败', 'error');
        }
    }

    async function toggleSource(id, status) {
        try {
            const action = status === 'active' ? 'pause' : 'resume';
            const toastMsg = status === 'active' ? '数据源已暂停同步。' : '数据源已恢复。';
            await fetchKnowledge(`/knowledge/sources/${encodeURIComponent(id)}/${action}`, { method: 'POST' });
            showToast(toastMsg);
            await loadSources();
        } catch (error) {
            showToast(error.message || '更新来源状态失败', 'error');
        }
    }

    async function showSourceRuns(sourceId) {
        try {
            const data = await fetchKnowledge(`/knowledge/sources/${encodeURIComponent(sourceId)}/runs?limit=20`);
            const runs = data.data || [];
            if (!runs.length) {
                await window.Pivot.legacy.showAlert?.('数据源同步记录', '暂无同步记录。可点击“立即同步”发起首次抓取。');
                return;
            }
            const copy = runs.map(item => `${item.status === 'completed' ? '成功' : item.status === 'failed' ? '失败' : item.status === 'partial' ? '部分完成' : item.status} · ${item.triggerType === 'manual' ? '手动触发' : item.triggerType} · 新增 ${Number(item.summary?.created || 0)} / 更新 ${Number(item.summary?.changed || 0)} / 入队 ${Number(item.summary?.queued || 0)}${item.summary?.deletionBlocked ? ' · 删除同步已受保护' : ''}${item.summary?.failures?.length ? ` · 失败 ${item.summary.failures.length} 项` : ''} · ${item.completedAt || item.startedAt || ''}${item.errorMessage ? ` · ${item.errorMessage}` : ''}`).join('\n\n');
            await window.Pivot.legacy.showAlert?.('数据源同步记录', copy);
        } catch (error) {
            showToast(error.message || '加载同步记录失败', 'error');
        }
    }

    async function reviewSourceDeletion(sourceId) {
        const data = await fetchKnowledge(`/knowledge/sources/${encodeURIComponent(sourceId)}/runs?limit=1`);
        const run = data.data?.[0];
        const preview = run?.summary?.deletionPreview;
        if (!preview || !run.summary?.scanComplete || !run.summary?.deletionBlocked) return showToast('最近一次同步没有可审批的完整删除预览。', 'info');
        if (preview.truncated) return showToast('删除预览超过 50 项，请先缩小范围后重新同步。', 'error');
        const names = (preview.documents || []).map(item => `• ${item.type === 'wiki' ? 'Wiki 页面' : '文档'}：${item.title}`).join('\n');
        const confirmed = await window.Pivot.legacy.showConfirm?.('审批数据源删除', `完整扫描发现 ${preview.count} 份资料在源端缺失：\n${names}\n\n确认审批并立即重新扫描？仅在范围完全一致时归档，审批 30 分钟内有效且只能使用一次。`);
        if (!confirmed) return;
        const dataApproval = await fetchKnowledge(`/knowledge/sources/${encodeURIComponent(sourceId)}/deletion-approvals`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId: run.id })
        });
        const dataSync = await fetchKnowledge(`/knowledge/sources/${encodeURIComponent(sourceId)}/sync`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ approvalId: dataApproval.approval.id })
        });
        if (dataSync.result?.approvalRejected || dataSync.result?.deletionBlocked) showToast('删除范围已变化或扫描不完整，未执行审批删除；请重新核对。', 'error');
        else showToast(`已重新同步，归档 ${Number(dataSync.result?.archived || 0)} 份资料。`, 'success');
        await Promise.all([loadSources(), loadJobs()]);
    }

    async function showVersionDiff(button) {
        const data = await fetchKnowledge(`/knowledge/documents/${encodeURIComponent(button.dataset.knowledgeDocumentId)}/diff?fromVersionId=${encodeURIComponent(button.dataset.knowledgeFromVersionId)}&toVersionId=${encodeURIComponent(button.dataset.knowledgeToVersionId)}`);
        const diff = data.diff || {};
        const copy = (diff.changes || []).map(item => `${item.type === 'added' ? '+' : '-'} ${item.line}: ${item.text}`).join('\n') || '两个版本内容相同';
        await window.Pivot.legacy.showAlert?.(`版本差异（${Number(diff.changed || 0)} 处）`, `${copy}${diff.truncated ? '\n…仅展示前 400 处差异' : ''}`);
    }

    async function configureGovernance(documentId) {
        const contentOwnerUserId = await window.Pivot.legacy.showInputPrompt?.({ title: '文档治理', label: '责任人用户 ID（留空保持当前）', message: '仅支持文档所有者或系统管理员。', placeholder: '例如：12', required: false });
        const verifierUserId = await window.Pivot.legacy.showInputPrompt?.({ title: '文档治理', label: '验证人用户 ID（留空保持当前）', message: '仅支持文档所有者或系统管理员。', placeholder: '例如：15', required: false });
        const freshnessPolicy = await window.Pivot.legacy.showInputPrompt?.({ title: '文档治理', label: '复核策略', placeholder: 'manual / 30d / 90d / 180d / 365d', value: '90d' });
        if (!freshnessPolicy) return;
        const verifiedStatus = await window.Pivot.legacy.showInputPrompt?.({ title: '文档治理', label: '验证状态', placeholder: 'verified / unverified / expired', value: 'unverified' });
        if (!verifiedStatus) return;
        await fetchKnowledge(`/knowledge/documents/${encodeURIComponent(documentId)}/governance`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ...(contentOwnerUserId ? { contentOwnerUserId: Number(contentOwnerUserId) } : {}),
                ...(verifierUserId ? { verifierUserId: Number(verifierUserId) } : {}),
                freshnessPolicy,
                verifiedStatus
            })
        });
        showToast('文档治理信息已更新。');
        await loadDocuments();
    }

    async function verifyDocument(documentId) {
        await fetchKnowledge(`/knowledge/documents/${encodeURIComponent(documentId)}/verify`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'verified' })
        });
        showToast('文档已验证并恢复为正式知识。');
        await loadDocuments();
    }

    async function manageComments(documentId) {
        const data = await fetchKnowledge(`/knowledge/documents/${encodeURIComponent(documentId)}/comments`);
        const existing = (data.data || []).map(item => `${item.status === 'resolved' ? '已解决' : '待处理'} · ${item.kind === 'correction' ? '纠错' : '评论'} · ${item.user_name || '用户'}\n${item.content}`).join('\n\n') || '暂无评论';
        const next = await window.Pivot.legacy.showInputPrompt?.({ title: '文档评论与纠错', message: `${existing}\n\n输入新评论；以“纠错:”开头会标记为纠错。`, label: '新增评论', placeholder: '例如：纠错：第 2 步应增加风险评估', multiline: true, required: false });
        if (!next) return;
        const correction = /^纠错[:：]/.test(next);
        await fetchKnowledge(`/knowledge/documents/${encodeURIComponent(documentId)}/comments`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ kind: correction ? 'correction' : 'comment', content: next.replace(/^纠错[:：]\s*/, '') })
        });
        showToast('评论已提交。');
    }

    async function performVersionAction(button) {
        const versionId = button.dataset.knowledgeVersionId;
        const documentId = button.dataset.knowledgeDocumentId;
        const action = button.dataset.knowledgeVersionAction;
        if (!versionId || !action) return;
        if (action === 'submit') {
            const reviewerUserId = await window.Pivot.legacy.showInputPrompt?.({ title: '提交审核', label: '审核人用户 ID', message: '严格所有者隔离下，仅可选择文档所有者或系统管理员。', placeholder: '输入所有者或系统管理员账号 ID' });
            if (!reviewerUserId) return;
            await fetchKnowledge(`/knowledge/versions/${encodeURIComponent(versionId)}/submit-review`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reviewerUserId: Number(reviewerUserId) })
            });
        } else if (action === 'publish') {
            await fetchKnowledge(`/knowledge/versions/${encodeURIComponent(versionId)}/publish`, { method: 'POST' });
        } else {
            await fetchKnowledge(`/knowledge/versions/${encodeURIComponent(versionId)}/review`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ approved: action === 'approve' })
            });
        }
        showToast(action === 'publish' ? '版本已发布。' : '版本状态已更新。');
        await Promise.all([showDocumentVersions(documentId), loadDocuments()]);
    }

    async function createEvaluationCase() {
        const name = await window.Pivot.legacy.showInputPrompt?.({ title: '新建黄金问题', label: '用例名称', placeholder: '例如：采购审批材料' });
        if (!name) return;
        const query = await window.Pivot.legacy.showInputPrompt?.({ title: '新建黄金问题', label: '业务问题', placeholder: '例如：采购审批需要哪些材料？' });
        if (!query) return;
        const chunks = await window.Pivot.legacy.showInputPrompt?.({ title: '新建黄金问题', label: '预期片段编号（可选，逗号分隔）', placeholder: '例如：101,102' });
        const expectedChunkIds = String(chunks || '').split(/[,，\s]+/).map(Number).filter(Number.isSafeInteger);
        await fetchKnowledge('/knowledge/evaluations/cases', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, query, expectedChunkIds })
        });
        showToast('黄金问题已创建。');
        await loadEvaluation();
    }

    async function runEvaluation() {
        const modelId = await window.Pivot.legacy.showInputPrompt?.({ title: '运行知识库评测', label: '回答评测模型编号（可选）', placeholder: '留空时只评测检索与引用', required: false });
        const data = await fetchKnowledge('/knowledge/evaluations/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '知识库检索评测', ...(modelId ? { modelId } : {}) }) });
        showToast(`评测已入队：#${data.run?.id || '-'}`);
        await loadEvaluation();
    }

    async function showEvaluationRun(id) {
        const data = await fetchKnowledge(`/knowledge/evaluations/runs/${encodeURIComponent(id)}`);
        const run = data.run || {};
        const copy = (run.results || []).map(item => `${item.name} · ${evaluationStatusLabel(item.status)} · ${evaluationMetricText('recallAt3', item.metrics?.recallAt3)} · ${evaluationMetricText('mrr', item.metrics?.mrr)}${item.errorMessage ? ` · ${item.errorMessage}` : ''}`).join('\n') || '暂无明细';
        await window.Pivot.legacy.showAlert?.(run.name || '评测详情', copy);
    }

    async function compareEvaluationRun(candidateRunId) {
        const candidateIndex = productState.evaluationRuns.findIndex(item => Number(item.id) === Number(candidateRunId));
        const base = productState.evaluationRuns[candidateIndex + 1]
            || productState.evaluationRuns.find(item => Number(item.id) !== Number(candidateRunId));
        if (!base) return;
        const data = await fetchKnowledge(`/knowledge/evaluations/compare?baseRunId=${encodeURIComponent(base.id)}&candidateRunId=${encodeURIComponent(candidateRunId)}`);
        const compare = data.comparison || {};
        const delta = Object.entries(compare.delta || {}).filter(([, value]) => value !== null).map(([key, value]) => evaluationMetricDeltaText(key, value)).filter(Boolean).join('\n') || '没有可比较指标';
        const regressions = (compare.regressions || []).map(item => `${item.name}：前 3 条召回率 ${percentage(item.before)} → ${percentage(item.after)}`).join('\n');
        await window.Pivot.legacy.showAlert?.('评测比较', `${delta}${regressions ? `\n\n回归用例：\n${regressions}` : ''}`);
    }

    async function showKnowledgeGaps() {
        const data = await fetchKnowledge('/knowledge/gaps?limit=30');
        const report = data.report || {};
        const missed = (report.missedCases || []).map(item => `未命中：${item.name}\n${item.query}`).join('\n\n');
        const feedback = (report.negativeFeedback || []).map(item => `负反馈：${item.doc_name || '-'} · ${item.query} (${item.count})`).join('\n');
        await window.Pivot.legacy.showAlert?.('知识缺口', `${missed || '暂无评测未命中问题'}${feedback ? `\n\n${feedback}` : ''}`);
    }

    document.addEventListener('click', event => {
        if (event.target === getProductModal()) return closeKnowledgeProduct();
        const open = event.target.closest('[data-knowledge-product-open]');
        if (open) return openKnowledgeProduct(open.dataset.knowledgeProductTab || 'search');
        if (event.target.closest('[data-knowledge-product-close]')) return closeKnowledgeProduct();
        const tab = event.target.closest('[data-knowledge-product-tab]');
        if (tab) return switchTab(tab.dataset.knowledgeProductTab);
        if (event.target.closest('#knowledge-product-search')) return void runKnowledgeSearch({ ask: false });
        if (event.target.closest('#knowledge-product-ask')) return void runKnowledgeSearch({ ask: true });
        const citation = event.target.closest('[data-knowledge-citation]');
        if (citation) return void showCitation(citation.dataset.knowledgeCitation);
        const citationEvent = event.target.closest('[data-knowledge-citation-event]');
        if (citationEvent) return void sendCitationEvent(citationEvent).catch(error => showToast(error.message || '引用反馈失败', 'error'));
        if (event.target.closest('#knowledge-product-new-article')) return void createArticle().catch(error => showToast(error.message || '创建文章失败', 'error'));
        if (event.target.closest('#knowledge-product-draft-from-chat')) return void createDraftFromChat().catch(error => showToast(error.message || '沉淀会话草稿失败', 'error'));
        if (event.target.closest('#knowledge-product-draft-from-agent')) return void createDraftFromAgent().catch(error => showToast(error.message || '沉淀 Agent 草稿失败', 'error'));
        const newVersion = event.target.closest('[data-knowledge-new-version]');
        if (newVersion) return void createArticleVersion(newVersion.dataset.knowledgeNewVersion).catch(error => showToast(error.message || '创建草稿失败', 'error'));
        const versions = event.target.closest('[data-knowledge-document]');
        if (versions) return void showDocumentVersions(versions.dataset.knowledgeDocument).catch(error => showToast(error.message || '加载版本失败', 'error'));
        const archive = event.target.closest('[data-knowledge-archive]');
        if (archive) return void fetchKnowledge(`/knowledge/documents/${encodeURIComponent(archive.dataset.knowledgeArchive)}/archive`, { method: 'POST' }).then(loadDocuments).catch(error => showToast(error.message || '归档失败', 'error'));
        if (event.target.closest('#knowledge-product-new-source')) return void openSourceModal();
        if (event.target.closest('#knowledge-source-modal-close') || event.target.closest('#knowledge-source-modal-cancel') || event.target === document.getElementById('knowledge-source-modal')) return void closeSourceModal();
        const sync = event.target.closest('[data-knowledge-sync-source]');
        if (sync) return void syncSource(sync.dataset.knowledgeSyncSource).catch(error => showToast(error.message || '同步失败', 'error'));
        const toggle = event.target.closest('[data-knowledge-toggle-source]');
        if (toggle) return void toggleSource(toggle.dataset.knowledgeToggleSource, toggle.dataset.sourceStatus).catch(error => showToast(error.message || '更新来源失败', 'error'));
        const sourceRuns = event.target.closest('[data-knowledge-source-runs]');
        if (sourceRuns) return void showSourceRuns(sourceRuns.dataset.knowledgeSourceRuns).catch(error => showToast(error.message || '加载同步记录失败', 'error'));
        const sourceDeletionReview = event.target.closest('[data-knowledge-source-review-deletion]');
        if (sourceDeletionReview) return void reviewSourceDeletion(sourceDeletionReview.dataset.knowledgeSourceReviewDeletion).catch(error => showToast(error.message || '审核数据源删除失败', 'error'));
        const governance = event.target.closest('[data-knowledge-governance]');
        if (governance) return void configureGovernance(governance.dataset.knowledgeGovernance).catch(error => showToast(error.message || '更新治理信息失败', 'error'));
        const verify = event.target.closest('[data-knowledge-verify]');
        if (verify) return void verifyDocument(verify.dataset.knowledgeVerify).catch(error => showToast(error.message || '验证文档失败', 'error'));
        const comments = event.target.closest('[data-knowledge-comments]');
        if (comments) return void manageComments(comments.dataset.knowledgeComments).catch(error => showToast(error.message || '加载评论失败', 'error'));
        const diff = event.target.closest('[data-knowledge-version-diff]');
        if (diff) return void showVersionDiff(diff).catch(error => showToast(error.message || '加载版本差异失败', 'error'));
        if (event.target.closest('#knowledge-product-refresh-jobs')) return void loadJobs().catch(error => showToast(error.message || '加载任务失败', 'error'));
        if (event.target.closest('#knowledge-product-new-eval-case')) return void createEvaluationCase().catch(error => showToast(error.message || '创建评测用例失败', 'error'));
        if (event.target.closest('#knowledge-product-run-evaluation')) return void runEvaluation().catch(error => showToast(error.message || '启动评测失败', 'error'));
        const deleteCase = event.target.closest('[data-knowledge-delete-eval-case]');
        if (deleteCase) return void fetchKnowledge(`/knowledge/evaluations/cases/${encodeURIComponent(deleteCase.dataset.knowledgeDeleteEvalCase)}`, { method: 'DELETE' }).then(loadEvaluation).catch(error => showToast(error.message || '删除评测用例失败', 'error'));
        const evaluationRun = event.target.closest('[data-knowledge-eval-run]');
        if (evaluationRun) return void showEvaluationRun(evaluationRun.dataset.knowledgeEvalRun).catch(error => showToast(error.message || '加载评测详情失败', 'error'));
        const evaluationCompare = event.target.closest('[data-knowledge-eval-compare]');
        if (evaluationCompare) return void compareEvaluationRun(evaluationCompare.dataset.knowledgeEvalCompare).catch(error => showToast(error.message || '比较评测失败', 'error'));
        if (event.target.closest('#knowledge-product-eval-gaps')) return void showKnowledgeGaps().catch(error => showToast(error.message || '加载知识缺口失败', 'error'));
        const versionAction = event.target.closest('[data-knowledge-version-action]');
        if (versionAction) return void performVersionAction(versionAction).catch(error => showToast(error.message || '更新版本状态失败', 'error'));
    });

    document.addEventListener('change', event => {
        if (event.target?.id === 'knowledge-source-kind') {
            const kind = event.target.value;
            const configTextarea = document.getElementById('knowledge-source-config');
            const tipEl = document.getElementById('knowledge-source-config-tip');
            const templateInfo = SOURCE_CONFIG_TEMPLATES[kind] || SOURCE_CONFIG_TEMPLATES.local_dir;
            if (configTextarea) configTextarea.value = templateInfo.template;
            if (tipEl) tipEl.textContent = templateInfo.tip;
        }
    });

    document.addEventListener('submit', event => {
        if (event.target?.id === 'knowledge-source-form') {
            return void handleSourceSubmit(event);
        }
    });

    document.addEventListener('keydown', event => {
        if (!isProductModalOpen() || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        const current = event.target.closest('[data-knowledge-product-tab]');
        if (!current) return;
        const index = tabs.indexOf(current.dataset.knowledgeProductTab);
        if (index < 0) return;
        event.preventDefault();
        const nextIndex = event.key === 'Home' ? 0
            : event.key === 'End' ? tabs.length - 1
                : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
        const next = tabs[nextIndex];
        switchTab(next);
        document.querySelector(`[data-knowledge-product-tab="${next}"]`)?.focus?.();
    });

    document.addEventListener('pivot:workspace-mounted', event => {
        if (event.detail?.name === 'knowledge' && isProductModalOpen()) switchTab(activeTab);
    });
    document.addEventListener('pivot:knowledge-opened', () => {
        if (isProductModalOpen()) switchTab(activeTab);
    });

    window.Pivot?.exposeModule?.('knowledge.product', {
        closeKnowledgeProduct,
        loadDocuments,
        loadEvaluation,
        loadJobs,
        loadSources,
        openKnowledgeProduct,
        switchTab
    });
})();
