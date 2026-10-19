(function () {
    const DOMAIN_NAMES = {
        model_routing: '模型路由与降级', tool_discovery: '工具按需发现', tool_concurrency: '工具并发与幂等',
        tool_policy: '工具策略与审批', sandbox_execution: '沙箱与本机执行', long_task_recovery: '长任务故障恢复',
        multi_agent: '多 Agent 协同', dag_orchestration: 'DAG 任务编排', lifecycle_extensions: '生命周期扩展',
        context_governance: '上下文治理与压缩', prompt_structured_output: '提示词与结构化输出', long_term_memory: '长期记忆与知识库',
        skill_ecosystem: '技能生态与工具箱', browser_automation: '浏览器自动化交互', evaluation_release: '评测与发布门禁',
        observability: '全链路可观测性', code_semantics_ide: '代码语义与 IDE 集成', voice_multimodal: '语音与多模态交互'
    };
    const EVIDENCE_TYPE_NAMES = {
        implementation_review: '实现审查', automated: '自动化测试', nonfunctional: '非功能指标', canary: '灰度金丝雀', committee: '委员会签署'
    };
    const COMMITTEE_ROLES = [
        { role: 'platform_security', label: '平台安全代表' }, { role: 'runtime', label: '运行时架构代表' },
        { role: 'qa_sre', label: '测试与SRE代表' }, { role: 'product', label: '产品与业务代表' }
    ];

    const now = () => new Date().toISOString();
    const artifact = (type, generatedAt) => ({ id: `REPLACE_WITH_${type.toUpperCase()}_REPORT_ID`, kind: `${type}_report`, generatedAt, sha256: 'REPLACE_WITH_64_CHAR_ARTIFACT_SHA256' });
    const metrics = requirements => (requirements?.requiredMetrics || []).map(policy => ({ key: policy.key, value: 'REPLACE_WITH_MEASURED_VALUE', threshold: policy.threshold, comparator: policy.comparator, passed: false }));
    
    function buildManifestTemplate(evidenceType, requirements = {}, generatedAt = now()) {
        const base = { schemaVersion: Number(requirements.schemaVersion) || 1, artifact: artifact(evidenceType, generatedAt) };
        if (evidenceType === 'implementation_review') return { ...base, reviewScope: 'REPLACE_WITH_REVIEW_SCOPE_AT_LEAST_12_CHARS', changeRefs: ['REPLACE_WITH_CONTROLLED_CHANGE_REFERENCE'], commit: 'REPLACE_WITH_COMMIT_SHA', reviewedAt: generatedAt };
        if (evidenceType === 'automated') return { ...base, suite: 'REPLACE_WITH_SUITE', runId: 'REPLACE_WITH_RUN_ID', total: 'REPLACE_WITH_TOTAL', passed: 'REPLACE_WITH_PASSED', failed: 'REPLACE_WITH_FAILED', completedAt: generatedAt, resultRef: 'REPLACE_WITH_CONTROLLED_RESULT_REFERENCE' };
        if (evidenceType === 'nonfunctional') return { ...base, window: { start: 'REPLACE_WITH_WINDOW_START', end: 'REPLACE_WITH_WINDOW_END' }, sampleSize: requirements.minimumObservationSamples || 30, metrics: metrics(requirements), dashboardRef: 'REPLACE_WITH_CONTROLLED_DASHBOARD_REFERENCE' };
        if (evidenceType === 'canary') return { ...base, environment: 'canary', window: { start: 'REPLACE_WITH_WINDOW_START', end: 'REPLACE_WITH_WINDOW_END' }, cohort: 'REPLACE_WITH_CONTROLLED_COHORT', sampleSize: requirements.minimumObservationSamples || 30, fullCycle: false, p0Count: 0, p1Count: 0, metrics: metrics(requirements), rollbackDrillRef: 'REPLACE_WITH_ROLLBACK_DRILL_REFERENCE', operator: 'REPLACE_WITH_OPERATOR' };
        return { ...base, meetingAt: generatedAt, minutesRef: 'REPLACE_WITH_COMMITTEE_MINUTES_REFERENCE', recommendation: 'approve_for_score', signatories: (requirements.committeeRoles || []).map(role => ({ role, signer: `REPLACE_WITH_${role.toUpperCase()}_SIGNER`, signedAt: generatedAt })) };
    }

    function safeEscape(str) {
        return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function safeEscapeAttr(str) {
        return safeEscape(str);
    }
    function shortText(str, max = 100) {
        const text = String(str || '');
        return text.length > max ? `${text.slice(0, max)}…` : text;
    }
    function safeSetHtml(element, markup) {
        if (!element) return;
        const safeHtml = typeof PivotSafeHtml !== 'undefined'
            ? PivotSafeHtml
            : (typeof window !== 'undefined' ? window.PivotSafeHtml || window.Pivot?.legacy?.PivotSafeHtml : null);
        if (safeHtml?.setHtml) {
            safeHtml.setHtml(element, markup);
        }
    }

    function setAcceptanceModal(modalId, isOpen) {
        if (typeof document === 'undefined') return;
        const modal = document.getElementById(modalId);
        if (!modal) return;
        modal.classList.toggle('hidden', !isOpen);
        modal.setAttribute('aria-hidden', isOpen ? 'false' : 'true');
    }

    function renderAcceptanceLedgerModal(acceptance = [], filter = 'all', keyword = '') {
        if (typeof document === 'undefined') return;
        const container = document.getElementById('agent-acceptance-ledger-items-container');
        const footerStats = document.getElementById('agent-acceptance-ledger-footer-stats');
        if (!container) return;
        const readyCount = acceptance.filter(i => i.readiness === 'ready_for_committee_score').length;
        if (footerStats) footerStats.textContent = `就绪状态：${readyCount}/${acceptance.length || 18} 领域证据齐备`;

        const filtered = acceptance.filter(item => {
            const isReady = item.readiness === 'ready_for_committee_score';
            if (filter === 'ready' && !isReady) return false;
            if (filter === 'missing' && isReady) return false;
            if (keyword) {
                const kw = keyword.toLowerCase();
                const zh = (DOMAIN_NAMES[item.domainKey] || '').toLowerCase();
                const en = (item.domainKey || '').toLowerCase();
                if (!zh.includes(kw) && !en.includes(kw)) return false;
            }
            return true;
        });

        if (!filtered.length) {
            safeSetHtml(container, '<div style="grid-column: 1 / -1; padding: 24px; text-align: center; color: var(--text-muted); font-size: 0.78rem;">未找到匹配的验收领域</div>');
            return;
        }

        const cardsMarkup = filtered.map(item => {
            const domainZh = DOMAIN_NAMES[item.domainKey] || item.domainKey;
            const isReady = item.readiness === 'ready_for_committee_score';
            const missingList = Array.isArray(item.missingEvidenceTypes) ? item.missingEvidenceTypes : [];
            return `
                <div class="agent-acceptance-ledger-card ${isReady ? 'is-ready' : 'is-missing'}">
                    <div class="agent-acceptance-ledger-card-head">
                        <div>
                            <strong>${safeEscape(domainZh)}</strong>
                            <code>${safeEscape(item.domainKey)}</code>
                        </div>
                        <span class="agent-inbox-type-badge ${isReady ? 'badge-run' : 'badge-approval'}">
                            ${isReady ? '证据已齐备' : `缺 ${missingList.length} 项`}
                        </span>
                    </div>
                    <div class="agent-acceptance-ledger-card-body">
                        ${isReady ? '<span class="agent-acceptance-card-ready-tip">五类工程证据齐备，待四方委员会统一评分。</span>' : `
                            <div class="agent-acceptance-missing-chips">
                                <span class="agent-acceptance-chip-label">待补齐：</span>
                                ${missingList.map(type => `<span class="agent-acceptance-chip">${safeEscape(EVIDENCE_TYPE_NAMES[type] || type)}</span>`).join('')}
                            </div>
                        `}
                    </div>
                </div>
            `;
        }).join('');
        safeSetHtml(container, cardsMarkup);
    }

    function renderAcceptanceCommitteeModal(params = {}) {
        if (typeof document === 'undefined') return;
        const { committeeMembers = [], committeeEligibleAdmins = [], API_BASE = '', apiJson, setNotice, loadControlPlane } = params;
        const container = document.getElementById('agent-acceptance-committee-fields');
        if (!container) return;
        const fieldsMarkup = COMMITTEE_ROLES.map(({ role, label }) => {
            const assigned = committeeMembers.find(item => item.role === role)?.userId;
            const options = committeeEligibleAdmins.map(admin => `<option value="${safeEscapeAttr(admin.id)}"${Number(admin.id) === Number(assigned) ? ' selected' : ''}>${safeEscape(admin.username)}</option>`).join('');
            return `
                <label>
                    <span>${safeEscape(label)}</span>
                    <select class="form-input" data-agent-committee-member="${safeEscapeAttr(role)}">
                        <option value="">选择活跃管理员</option>
                        ${options}
                    </select>
                </label>
            `;
        }).join('');
        safeSetHtml(container, fieldsMarkup);

        container.querySelectorAll('[data-agent-committee-member]').forEach(select => {
            select.addEventListener('change', async () => {
                if (!select.value || typeof apiJson !== 'function') return;
                try {
                    await apiJson(`${API_BASE}/agents/acceptance-evidence/committee-members/${encodeURIComponent(select.dataset.agentCommitteeMember || '')}`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ userId: Number(select.value) })
                    });
                    setNotice?.('委员会角色成员已更新。', 'success');
                    await loadControlPlane?.();
                } catch (error) {
                    setNotice?.(error.message || '配置委员会成员失败。', 'error');
                }
            });
        });
    }

    function renderAcceptanceSection(params = {}) {
        const { acceptance = [], readyDomains = 0, isSuperAdmin = false } = params;
        if (!acceptance.length) return '';
        const missingAcceptance = acceptance.filter(item => item.missingEvidenceTypes?.length).slice(0, 6);
        const acceptanceRows = missingAcceptance.map(item => `
            <li class="agent-acceptance-summary-item">
                <b class="agent-acceptance-domain-badge">${safeEscape(DOMAIN_NAMES[item.domainKey] || item.domainKey)}</b>
                <span class="agent-acceptance-missing-text">缺少：${safeEscape(item.missingEvidenceTypes.map(t => EVIDENCE_TYPE_NAMES[t] || t).join('、'))}</span>
            </li>
        `);
        const acceptanceItemsHtml = acceptanceRows.length ? acceptanceRows.join('') : '<li class="agent-acceptance-summary-item"><span>全部领域证据已齐备，等待委员会评分。</span></li>';
        const totalDomains = acceptance.length || 18;
        const progressPercent = readyDomains > 0 ? Math.round((readyDomains / totalDomains) * 100) : 0;

        return `
            <section class="agent-quality-acceptance">
                <div class="agent-quality-acceptance-head">
                    <div>
                        <strong>五分验收台账</strong>
                        <span>${readyDomains}/${totalDomains} 个领域证据齐备；齐备后仍须委员会评分。</span>
                    </div>
                    <div class="agent-quality-acceptance-actions">
                        <button type="button" class="btn-secondary" id="agent-acceptance-open-ledger-btn">五分验收台账</button>
                        ${isSuperAdmin ? `
                            <button type="button" class="btn-secondary" id="agent-acceptance-open-committee-btn">配置委员会四方成员</button>
                            <button type="button" class="btn-primary" id="agent-acceptance-open-submit-btn">提交五分验收证据</button>
                        ` : ''}
                    </div>
                </div>
                <div class="agent-acceptance-overview-progress">
                    <div class="agent-acceptance-progress-bar">
                        <div class="agent-acceptance-progress-fill" style="width: ${progressPercent}%;"></div>
                    </div>
                    <div class="agent-acceptance-progress-stats">
                        <span>证据齐备度: ${readyDomains}/${totalDomains} 领域 (${progressPercent}%)</span>
                        <span>须满足实现审查、自动化、非功能、灰度与委员会签署五类要求</span>
                    </div>
                </div>
                <ul class="agent-acceptance-summary-list">${acceptanceItemsHtml}</ul>
            </section>
        `;
    }

    function renderAcceptanceReviews(params = {}) {
        const { pendingAcceptanceReviews = [], canReview = false } = params;
        if (!canReview || !pendingAcceptanceReviews.length) return '';
        return `
            <section class="agent-quality-acceptance">
                <div class="agent-quality-acceptance-head">
                    <div>
                        <strong>待独立核验</strong>
                        <span>${pendingAcceptanceReviews.length} 条证据待管理员复核。</span>
                    </div>
                </div>
                <ul class="agent-acceptance-review-list">
                    ${pendingAcceptanceReviews.slice(0, 12).map(item => `
                        <li>
                            <b>${safeEscape(DOMAIN_NAMES[item.domainKey] || item.domainKey)} · ${safeEscape(EVIDENCE_TYPE_NAMES[item.evidenceType] || item.evidenceType)}</b>
                            <span>${safeEscape(shortText(item.evidenceSummary, 100))}${item.evidenceType === 'committee' ? ` · 委员会已签 ${Number(item.committeeAttestations?.length || 0)}/4` : ''}</span>
                            <div class="agent-acceptance-review-actions">
                                ${item.evidenceType === 'committee' ? `<button type="button" class="btn-secondary btn-xs" data-agent-committee-attest="${safeEscapeAttr(item.id)}">委员会签署</button>` : ''}
                                <button type="button" class="btn-secondary btn-xs" data-agent-acceptance-verify="${safeEscapeAttr(item.id)}">核验</button>
                            </div>
                        </li>
                    `).join('')}
                </ul>
            </section>
        `;
    }

    function bindAcceptanceHandlers(params = {}) {
        if (typeof document === 'undefined') return;
        const { qualityPanel, acceptance = [], committeeMembers = [], committeeEligibleAdmins = [], API_BASE = '', apiJson, setNotice, loadControlPlane } = params;

        // 打开五分验收台账弹窗
        document.getElementById('agent-acceptance-open-ledger-btn')?.addEventListener('click', () => {
            let currentFilter = 'all';
            let currentKeyword = '';
            renderAcceptanceLedgerModal(acceptance, currentFilter, currentKeyword);
            setAcceptanceModal('agent-acceptance-ledger-modal', true);

            const searchInput = document.getElementById('agent-acceptance-ledger-search');
            if (searchInput) {
                searchInput.value = '';
                searchInput.oninput = () => {
                    currentKeyword = searchInput.value.trim();
                    renderAcceptanceLedgerModal(acceptance, currentFilter, currentKeyword);
                };
            }

            document.querySelectorAll('[data-acceptance-filter]').forEach(btn => {
                btn.onclick = () => {
                    document.querySelectorAll('[data-acceptance-filter]').forEach(b => b.classList.remove('active'));
                    btn.classList.add('active');
                    currentFilter = btn.dataset.acceptanceFilter || 'all';
                    renderAcceptanceLedgerModal(acceptance, currentFilter, currentKeyword);
                };
            });
        });

        // 打开配置委员会四方成员弹窗
        document.getElementById('agent-acceptance-open-committee-btn')?.addEventListener('click', () => {
            renderAcceptanceCommitteeModal({ committeeMembers, committeeEligibleAdmins, API_BASE, apiJson, setNotice, loadControlPlane });
            setAcceptanceModal('agent-acceptance-committee-modal', true);
        });

        // 打开提交五分验收证据弹窗
        document.getElementById('agent-acceptance-open-submit-btn')?.addEventListener('click', () => {
            setAcceptanceModal('agent-acceptance-submission-modal', true);
        });

        // 通用弹窗关闭按钮
        document.querySelectorAll('[data-agent-acceptance-modal-close]').forEach(btn => {
            btn.onclick = () => {
                const which = btn.dataset.agentAcceptanceModalClose;
                if (which === 'ledger') setAcceptanceModal('agent-acceptance-ledger-modal', false);
                if (which === 'committee') setAcceptanceModal('agent-acceptance-committee-modal', false);
                if (which === 'submission') setAcceptanceModal('agent-acceptance-submission-modal', false);
            };
        });

        ['agent-acceptance-ledger-modal', 'agent-acceptance-committee-modal', 'agent-acceptance-submission-modal'].forEach(id => {
            const modal = document.getElementById(id);
            if (modal && !modal.dataset.backdropBound) {
                modal.dataset.backdropBound = 'true';
                modal.addEventListener('click', e => {
                    if (e.target === modal) setAcceptanceModal(id, false);
                });
            }
        });

        // 填入受控模板按钮
        document.querySelector('[data-agent-acceptance-template]')?.addEventListener('click', () => {
            const domainKey = String(document.getElementById('agent-acceptance-domain')?.value || '');
            const evidenceType = String(document.getElementById('agent-acceptance-type')?.value || '');
            const requirements = acceptance.find(item => item.domainKey === domainKey)?.requirements;
            const manifest = buildManifestTemplate(evidenceType, requirements);
            if (!manifest) return setNotice?.('验收模板模块尚未加载，请刷新后重试。', 'error');
            const field = document.getElementById('agent-acceptance-manifest');
            if (field) field.value = JSON.stringify(manifest, null, 2);
            setNotice?.('已填入受控模板；必须替换所有 REPLACE_WITH_* 占位值并提交真实测量结果。', 'info');
        });

        // 提交五分验收证据
        document.querySelector('[data-agent-acceptance-submit]')?.addEventListener('click', async event => {
            const domainKey = String(document.getElementById('agent-acceptance-domain')?.value || '');
            const evidenceType = String(document.getElementById('agent-acceptance-type')?.value || '');
            const evidenceRef = String(document.getElementById('agent-acceptance-ref')?.value || '').trim();
            const evidenceSummary = String(document.getElementById('agent-acceptance-summary')?.value || '').trim();
            if (evidenceSummary.length < 20) return setNotice?.('验收证据摘要至少需要 20 个字符。', 'error');
            let evidenceManifest;
            try {
                evidenceManifest = JSON.parse(String(document.getElementById('agent-acceptance-manifest')?.value || ''));
            } catch {
                return setNotice?.('结构化验收清单必须是有效 JSON；请按优化方案 3.3.1 填写。', 'error');
            }
            event.currentTarget.disabled = true;
            try {
                await apiJson(`${API_BASE}/agents/acceptance-evidence`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ domainKey, evidenceType, evidenceRef, evidenceSummary, evidenceManifest })
                });
                setNotice?.('验收证据已提交，需由另一位管理员独立核验。', 'success');
                setAcceptanceModal('agent-acceptance-submission-modal', false);
                document.getElementById('agent-acceptance-summary').value = '';
                document.getElementById('agent-acceptance-ref').value = '';
                document.getElementById('agent-acceptance-manifest').value = '';
                await loadControlPlane?.();
            } catch (error) {
                setNotice?.(error.message || '提交验收证据失败。', 'error');
            } finally {
                event.currentTarget.disabled = false;
            }
        });

        if (qualityPanel) {
            qualityPanel.querySelectorAll('[data-agent-acceptance-verify]').forEach(button => button.addEventListener('click', async () => {
                const verificationNote = window.prompt('填写独立核验说明（至少 12 个字符）：', '');
                if (verificationNote === null || verificationNote.trim().length < 12) return setNotice?.('核验说明至少需要 12 个字符。', 'error');
                const status = window.confirm('确认该证据可核验通过？取消则记为拒绝。') ? 'verified' : 'rejected';
                try {
                    await apiJson(`${API_BASE}/agents/acceptance-evidence/${encodeURIComponent(button.dataset.agentAcceptanceVerify || '')}/verification`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ status, verificationNote })
                    });
                    setNotice?.(status === 'verified' ? '验收证据已独立核验。' : '验收证据已拒绝。', status === 'verified' ? 'success' : 'warn');
                    await loadControlPlane?.();
                } catch (error) {
                    setNotice?.(error.message || '核验验收证据失败。', 'error');
                }
            }));

            qualityPanel.querySelectorAll('[data-agent-committee-attest]').forEach(button => button.addEventListener('click', async () => {
                const role = window.prompt('填写本人委员会角色：platform_security、runtime、qa_sre 或 product', '');
                if (!role) return;
                try {
                    await apiJson(`${API_BASE}/agents/acceptance-evidence/${encodeURIComponent(button.dataset.agentCommitteeAttest || '')}/committee-attestations`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ role })
                    });
                    setNotice?.('委员会身份签署已记录；四个角色齐全后方可独立核验。', 'success');
                    await loadControlPlane?.();
                } catch (error) {
                    setNotice?.(error.message || '委员会签署失败。', 'error');
                }
            }));
        }
    }

    window.Pivot?.exposeModule?.('agent.acceptanceEvidence', {
        buildManifestTemplate,
        DOMAIN_NAMES,
        EVIDENCE_TYPE_NAMES,
        COMMITTEE_ROLES,
        renderAcceptanceSection,
        renderAcceptanceReviews,
        renderAcceptanceLedgerModal,
        renderAcceptanceCommitteeModal,
        bindAcceptanceHandlers,
        setAcceptanceModal
    });
})();
