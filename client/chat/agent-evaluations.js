// 智能体评测集、批次与规则评分界面。
/* eslint-disable no-undef */
let agentEvalSuitesCache = [];
let activeAgentEvalSuiteId = '';
let activeAgentEvalRunId = '';
let agentEvalRunTimer = null;
let agentEvalEditorCases = [];
let agentEvalWorkflowsCache = [];
let agentEvalEditorRunConfig = {};

function agentEvalSummary(value) {
    return value && typeof value === 'object' ? value : {};
}

function agentEvalStatusLabel(status) {
    return ({ running: '运行中', completed: '已完成', passed: '通过', failed: '未通过', error: '异常', queued: '排队中', approval_required: '待审批', cancelled: '已停止' })[status] || status || '未运行';
}

function agentEvalStopPolling() {
    if (agentEvalRunTimer) clearTimeout(agentEvalRunTimer);
    agentEvalRunTimer = null;
}

function renderAgentEvalOverview() {
    const target = document.getElementById('agent-eval-overview');
    if (!target) return;
    const latest = agentEvalSuitesCache
        .filter(item => item.latest_summary)
        .sort((a, b) => String(b.latest_run_at || '').localeCompare(String(a.latest_run_at || '')))[0];
    const summary = agentEvalSummary(latest?.latest_summary);
    const caseCount = agentEvalSuitesCache.reduce((sum, item) => sum + Number(item.case_count || 0), 0);
    const running = agentEvalSuitesCache.filter(item => item.latest_status === 'running').length;
    PivotSafeHtml.setHtml(target, `
        <div><span>评测集</span><strong>${agentEvalSuitesCache.length}</strong></div>
        <div><span>用例</span><strong>${caseCount}</strong></div>
        <div><span>最近均分</span><strong>${latest ? `${Number(summary.averageScore || 0)} 分` : '-'}</strong></div>
        <div><span>最近通过率</span><strong>${latest ? `${Number(summary.passRate || 0)}%` : '-'}</strong></div>
        <div><span>运行中</span><strong>${running}</strong></div>
    `);
    const status = document.getElementById('agent-eval-center-status');
    if (status) status.textContent = latest
        ? `最近评测 ${formatDateToCN(latest.latest_run_at)} · ${agentEvalStatusLabel(latest.latest_status)}`
        : '尚未运行评测';
}

function renderAgentEvalSuiteList() {
    const list = document.getElementById('agent-eval-suite-list');
    if (!list) return;
    const isEmpty = !agentEvalSuitesCache.length;
    list.closest('.agent-eval-layout')?.classList.toggle('is-empty', isEmpty);
    document.querySelector('#agent-config-modal[data-agent-config-section="evaluations"] .agent-config-modal')?.classList.toggle('is-empty', isEmpty);
    PivotSafeHtml.setHtml(list, agentEvalSuitesCache.length ? agentEvalSuitesCache.map(item => {
        const summary = agentEvalSummary(item.latest_summary);
        return `
            <button type="button" class="agent-eval-suite-item ${String(item.id) === String(activeAgentEvalSuiteId) ? 'is-active' : ''}" data-agent-eval-suite="${agentEscapeAttr(item.id)}">
                <span class="agent-eval-suite-main">
                    <strong>${agentEscape(item.name)}</strong>
                    <small>${item.target_type === 'workflow' ? `工作流 · ${agentEscape(item.workflow_name || '未选择')}` : `自主任务 · ${agentEscape(item.model_name || '未选择模型')}`}</small>
                </span>
                <span class="agent-eval-suite-stats">
                    <em>${Number(item.case_count || 0)} 例</em>
                    ${item.latest_status ? `<small class="agent-eval-status ${agentEscapeAttr(item.latest_status)}">${agentEscape(agentEvalStatusLabel(item.latest_status))} · ${Number(summary.averageScore || 0)} 分</small>` : '<small>未运行</small>'}
                </span>
            </button>
        `;
    }).join('') : `
        <div class="agent-eval-empty">
            <span class="agent-eval-empty-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
            </span>
            <strong>暂无评测集</strong>
            <span>创建第一个评测集，开始记录质量基线。</span>
        </div>
    `);
    list.querySelectorAll('[data-agent-eval-suite]').forEach(button => {
        button.addEventListener('click', () => loadAgentEvalSuite(button.dataset.agentEvalSuite));
    });
}

async function loadAgentEvaluationSuites(options = {}) {
    const list = document.getElementById('agent-eval-suite-list');
    if (!list) return;
    if (!options.silent && !agentEvalSuitesCache.length) {
        PivotSafeHtml.setHtml(list, '<div class="empty-state agent-empty-state compact">正在加载评测集...</div>');
    }
    const response = await apiFetch(`${API_BASE}/agents/evaluations/suites`);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || '评测集加载失败');
    agentEvalSuitesCache = data.data || [];
    if (activeAgentEvalSuiteId && !agentEvalSuitesCache.some(item => String(item.id) === String(activeAgentEvalSuiteId))) {
        activeAgentEvalSuiteId = '';
    }
    const shouldSelectFirst = !activeAgentEvalSuiteId && agentEvalSuitesCache.length > 0;
    if (shouldSelectFirst) activeAgentEvalSuiteId = String(agentEvalSuitesCache[0].id);
    renderAgentEvalOverview();
    renderAgentEvalSuiteList();
    if ((shouldSelectFirst || options.keepDetail) && activeAgentEvalSuiteId) {
        await loadAgentEvalSuite(activeAgentEvalSuiteId, { silent: true });
    }
}

function agentEvalRuleMarkup(rule = {}) {
    return `<span class="agent-eval-rule ${rule.passed ? 'passed' : 'failed'}" title="${agentEscapeAttr(rule.actual || '')}">${rule.passed ? '通过' : '未通过'} · ${agentEscape(rule.label || rule.key)}</span>`;
}

function renderAgentEvalRunDetail(payload = {}) {
    const target = document.getElementById('agent-eval-run-detail');
    if (!target) return;
    const batch = payload.run || {};
    const summary = agentEvalSummary(batch.summary);
    const delta = payload.delta;
    const results = payload.results || [];
    PivotSafeHtml.setHtml(target, `
        <div class="agent-eval-batch-summary">
            <div><span>平均分</span><strong>${Number(summary.averageScore || 0)}</strong>${delta ? `<small class="${Number(delta.score) >= 0 ? 'up' : 'down'}">${Number(delta.score) >= 0 ? '+' : ''}${Number(delta.score)} 对比上次</small>` : '<small>首次基线</small>'}</div>
            <div><span>通过率</span><strong>${Number(summary.passRate || 0)}%</strong>${delta ? `<small class="${Number(delta.passRate) >= 0 ? 'up' : 'down'}">${Number(delta.passRate) >= 0 ? '+' : ''}${Number(delta.passRate)}%</small>` : '<small>首次基线</small>'}</div>
            <div><span>进度</span><strong>${Number(summary.completed || 0)}/${Number(summary.total || 0)}</strong><small>${agentEscape(agentEvalStatusLabel(batch.status))}</small></div>
            <div><span>总 Token</span><strong>${Number(summary.totalTokens || 0).toLocaleString()}</strong><small>${Number(summary.durationMs || 0).toLocaleString()} 毫秒</small></div>
        </div>
        <div class="agent-eval-results">
            ${results.map(result => {
                const graded = result.grader_results || {};
                return `
                    <details class="agent-eval-result ${result.passed ? 'passed' : result.status === 'error' ? 'error' : 'failed'}">
                        <summary>
                            <span><strong>${agentEscape(result.case_name)}</strong><small>${agentEscape(agentEvalStatusLabel(result.agent_run_status === 'approval_required' ? 'approval_required' : result.status))}</small></span>
                            <span><em>${Number(result.score || 0)} 分</em><small>${Number(result.duration_ms || 0)} ms · ${Number(result.total_tokens || 0)} tokens</small></span>
                        </summary>
                        <div class="agent-eval-result-body">
                            ${result.error_message ? `<div class="agent-eval-error">${agentEscape(result.error_message)}</div>` : ''}
                            <div class="agent-eval-rules">${(graded.rules || []).map(agentEvalRuleMarkup).join('') || '<span>等待评分</span>'}</div>
                            ${result.actual_output ? `<details class="agent-eval-output"><summary>查看实际输出</summary>${renderAgentFinalAnswer(result.actual_output)}</details>` : ''}
                            ${result.agent_run_id ? `<button type="button" class="btn-secondary" data-agent-eval-open-run="${agentEscapeAttr(result.agent_run_id)}">查看任务追踪</button>` : ''}
                        </div>
                    </details>
                `;
            }).join('') || '<div class="empty-state compact">评测任务正在创建</div>'}
        </div>
    `);
    target.querySelectorAll('[data-agent-eval-open-run]').forEach(button => {
        button.addEventListener('click', () => window.openAgentRun(button.dataset.agentEvalOpenRun));
    });
}

async function loadAgentEvalRun(evalRunId, options = {}) {
    agentEvalStopPolling();
    activeAgentEvalRunId = evalRunId;
    const target = document.getElementById('agent-eval-run-detail');
    if (target && !options.silent) PivotSafeHtml.setHtml(target, '<div class="empty-state compact">正在回收评测结果...</div>');
    const response = await apiFetch(`${API_BASE}/agents/evaluations/runs/${encodeURIComponent(evalRunId)}`);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return showToast(data.error || '评测结果加载失败', 'error');
    renderAgentEvalRunDetail(data);
    if (data.run?.status === 'running' && activeAgentEvalRunId === evalRunId) {
        agentEvalRunTimer = setTimeout(() => {
            if (activeAgentConfigSection === 'evaluations' && activeAgentEvalRunId === evalRunId) {
                loadAgentEvalRun(evalRunId, { silent: true }).catch(() => {});
            }
        }, 3000);
    } else {
        await loadAgentEvaluationSuites({ silent: true });
    }
}

function renderAgentEvalSuiteDetail(payload = {}) {
    const target = document.getElementById('agent-eval-suite-detail');
    if (!target) return;
    const suite = payload.suite || {};
    const cases = payload.cases || [];
    const runs = payload.runs || [];
    const latest = runs[0];
    PivotSafeHtml.setHtml(target, `
        <div class="agent-eval-detail-head">
            <div>
                <strong>${agentEscape(suite.name || '评测集')}</strong>
                <span>${suite.target_type === 'workflow' ? `工作流 · ${agentEscape(suite.workflow_name || '-')}` : `自主任务 · ${agentEscape(suite.model_name || '-')}`} · 通过线 ${Number(suite.run_config?.passThreshold || 80)} 分</span>
            </div>
            <div class="agent-eval-detail-actions">
                <button type="button" class="btn-secondary" data-agent-eval-edit>编辑</button>
                <button type="button" class="btn-danger-outline" data-agent-eval-delete>归档</button>
                <button type="button" class="btn-primary" data-agent-eval-run ${cases.length ? '' : 'disabled'}>运行 ${cases.length} 个用例</button>
            </div>
        </div>
        ${suite.description ? `<p class="agent-eval-description">${agentEscape(suite.description)}</p>` : ''}
        <div class="agent-eval-case-summary">
            ${cases.map(item => `<span title="${agentEscapeAttr(item.input)}">${agentEscape(item.name)}</span>`).join('') || '<span>尚未添加用例</span>'}
        </div>
        <div class="agent-eval-history">
            <div class="agent-tool-section-head compact"><strong>回归历史</strong><span>${runs.length} 个批次</span></div>
            <div class="agent-eval-history-list">
                ${runs.map(run => {
                    const summary = agentEvalSummary(run.summary);
                    return `<button type="button" class="agent-eval-history-item ${run.id === latest?.id ? 'is-latest' : ''}" data-agent-eval-run-id="${agentEscapeAttr(run.id)}"><strong>${Number(summary.averageScore || 0)} 分</strong><span>${Number(summary.passRate || 0)}% 通过 · ${agentEscape(agentEvalStatusLabel(run.status))}</span><small>${agentEscape(formatDateToCN(run.created_at))}</small></button>`;
                }).join('') || '<div class="empty-state compact">尚未建立质量基线</div>'}
            </div>
        </div>
        <div id="agent-eval-run-detail" class="agent-eval-run-detail"></div>
    `);
    target.querySelector('[data-agent-eval-edit]')?.addEventListener('click', () => openAgentEvalEditor(payload));
    target.querySelector('[data-agent-eval-delete]')?.addEventListener('click', () => deleteAgentEvalSuite(suite.id));
    target.querySelector('[data-agent-eval-run]')?.addEventListener('click', () => runAgentEvalSuite(suite.id, cases.length));
    target.querySelectorAll('[data-agent-eval-run-id]').forEach(button => {
        button.addEventListener('click', () => loadAgentEvalRun(button.dataset.agentEvalRunId));
    });
    if (latest) loadAgentEvalRun(latest.id, { silent: true }).catch(() => {});
}

async function loadAgentEvalSuite(suiteId, options = {}) {
    agentEvalStopPolling();
    activeAgentEvalSuiteId = String(suiteId || '');
    renderAgentEvalSuiteList();
    const target = document.getElementById('agent-eval-suite-detail');
    if (target && !options.silent) PivotSafeHtml.setHtml(target, '<div class="empty-state compact">正在加载评测详情...</div>');
    const response = await apiFetch(`${API_BASE}/agents/evaluations/suites/${encodeURIComponent(suiteId)}`);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return showToast(data.error || '评测集加载失败', 'error');
    renderAgentEvalSuiteDetail(data);
    return data;
}

function defaultAgentEvalCase(seed = null) {
    return {
        id: '',
        name: seed ? agentDisplayTitle(seed).slice(0, 100) : `用例 ${agentEvalEditorCases.length + 1}`,
        input: seed?.goal || '',
        input_variables: {},
        expected_output: '',
        assertions: { requiredPhrases: [], forbiddenPhrases: [], minLength: 0, maxDurationMs: 0, maxTokens: 0, requireJson: false, outputSchema: {} }
    };
}

function renderAgentEvalEditorCases() {
    const list = document.getElementById('agent-eval-editor-cases');
    if (!list) return;
    PivotSafeHtml.setHtml(list, agentEvalEditorCases.map((item, index) => {
        const assertions = item.assertions || {};
        return `
            <div class="agent-eval-case-editor" data-agent-eval-case-index="${index}">
                <div class="agent-eval-case-editor-head"><strong>用例 ${index + 1}</strong><button type="button" class="btn-danger-outline" data-agent-eval-case-remove="${index}" title="移除用例">移除</button></div>
                <input type="hidden" data-eval-field="id" value="${agentEscapeAttr(item.id || '')}">
                <div class="modal-form-grid modal-form-grid--3 agent-eval-case-fields">
                    <div class="modal-form-field"><label for="agent-eval-case-${index}-name">名称</label><input id="agent-eval-case-${index}-name" class="form-input" data-eval-field="name" value="${agentEscapeAttr(item.name || '')}" maxlength="100"></div>
                    <div class="modal-form-field modal-form-field--span-2"><label for="agent-eval-case-${index}-input">任务输入</label><textarea id="agent-eval-case-${index}-input" class="form-input" data-eval-field="input" rows="3">${agentEscape(item.input || '')}</textarea></div>
                    <div class="modal-form-field"><label for="agent-eval-case-${index}-required">必须包含</label><textarea id="agent-eval-case-${index}-required" class="form-input" data-eval-field="requiredPhrases" rows="2" placeholder="每行一个关键短语">${agentEscape((assertions.requiredPhrases || []).join('\n'))}</textarea></div>
                    <div class="modal-form-field"><label for="agent-eval-case-${index}-forbidden">禁止包含</label><textarea id="agent-eval-case-${index}-forbidden" class="form-input" data-eval-field="forbiddenPhrases" rows="2" placeholder="每行一个禁用短语">${agentEscape((assertions.forbiddenPhrases || []).join('\n'))}</textarea></div>
                    <div class="modal-form-field"><label for="agent-eval-case-${index}-min-length">最少字数</label><input id="agent-eval-case-${index}-min-length" class="form-input" data-eval-field="minLength" type="number" min="0" value="${Number(assertions.minLength || 0)}"></div>
                    <div class="modal-form-field"><label for="agent-eval-case-${index}-max-duration">最长耗时（毫秒）</label><input id="agent-eval-case-${index}-max-duration" class="form-input" data-eval-field="maxDurationMs" type="number" min="0" value="${Number(assertions.maxDurationMs || 0)}"></div>
                    <div class="modal-form-field"><label for="agent-eval-case-${index}-max-tokens">Token 上限</label><input id="agent-eval-case-${index}-max-tokens" class="form-input" data-eval-field="maxTokens" type="number" min="0" value="${Number(assertions.maxTokens || 0)}"></div>
                    <label class="modal-form-check agent-eval-json-toggle"><input data-eval-field="requireJson" type="checkbox" ${assertions.requireJson ? 'checked' : ''}><span>必须是有效 JSON</span></label>
                </div>
                <details class="agent-eval-case-advanced">
                    <summary>高级断言与工作流变量</summary>
                    <div class="modal-form-field"><label for="agent-eval-case-${index}-expected">必须包含的参考文本</label><textarea id="agent-eval-case-${index}-expected" class="form-input" data-eval-field="expectedOutput" rows="2">${agentEscape(item.expected_output || '')}</textarea></div>
                    <div class="modal-form-field"><label for="agent-eval-case-${index}-variables">工作流输入变量（JSON）</label><textarea id="agent-eval-case-${index}-variables" class="form-input agent-eval-code" data-eval-field="inputVariables" rows="4">${agentEscape(JSON.stringify(item.input_variables || {}, null, 2))}</textarea></div>
                    <div class="modal-form-field"><label for="agent-eval-case-${index}-schema">输出结构（JSON Schema）</label><textarea id="agent-eval-case-${index}-schema" class="form-input agent-eval-code" data-eval-field="outputSchema" rows="5">${agentEscape(JSON.stringify(assertions.outputSchema || {}, null, 2))}</textarea></div>
                </details>
            </div>
        `;
    }).join('') || '<div class="empty-state compact">至少添加一个评测用例</div>');
    const count = document.getElementById('agent-eval-case-count');
    if (count) count.textContent = `${agentEvalEditorCases.length} 个用例`;
    list.querySelectorAll('[data-agent-eval-case-remove]').forEach(button => {
        button.addEventListener('click', () => {
            collectAgentEvalEditorCases(false);
            agentEvalEditorCases.splice(Number(button.dataset.agentEvalCaseRemove), 1);
            renderAgentEvalEditorCases();
        });
    });
}

function collectAgentEvalEditorCases(throwOnInvalid = true) {
    const rows = Array.from(document.querySelectorAll('#agent-eval-editor-cases [data-agent-eval-case-index]'));
    const next = rows.map((row, index) => {
        const value = field => row.querySelector(`[data-eval-field="${field}"]`);
        const parseObject = (text, label) => {
            try {
                const parsed = JSON.parse(String(text || '{}'));
                if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
                return parsed;
            } catch (error) {
                if (throwOnInvalid) throw new Error(`用例 ${index + 1} 的${label}必须是 JSON 对象`);
                return {};
            }
        };
        return {
            id: value('id')?.value || '',
            name: value('name')?.value.trim() || `用例 ${index + 1}`,
            input: value('input')?.value.trim() || '',
            inputVariables: parseObject(value('inputVariables')?.value, '工作流输入变量'),
            expectedOutput: value('expectedOutput')?.value.trim() || '',
            assertions: {
                requiredPhrases: value('requiredPhrases')?.value.split(/\n/).map(text => text.trim()).filter(Boolean) || [],
                forbiddenPhrases: value('forbiddenPhrases')?.value.split(/\n/).map(text => text.trim()).filter(Boolean) || [],
                minLength: Number(value('minLength')?.value || 0),
                maxDurationMs: Number(value('maxDurationMs')?.value || 0),
                maxTokens: Number(value('maxTokens')?.value || 0),
                requireJson: Boolean(value('requireJson')?.checked),
                outputSchema: parseObject(value('outputSchema')?.value, '输出结构')
            }
        };
    });
    agentEvalEditorCases = next;
    return next;
}

async function loadAgentEvalWorkflows() {
    if (agentEvalWorkflowsCache.length) return agentEvalWorkflowsCache;
    const response = await apiFetch(`${API_BASE}/agents/workflows`);
    const data = await response.json().catch(() => ({}));
    if (response.ok) agentEvalWorkflowsCache = data.data || [];
    return agentEvalWorkflowsCache;
}

function ensureAgentEvalEditorModal() {
    let modal = document.getElementById('agent-eval-editor-modal');
    if (modal) return modal;
    modal = document.createElement('div');
    modal.id = 'agent-eval-editor-modal';
    modal.className = 'modal-overlay hidden agent-eval-editor-overlay';
    PivotSafeHtml.setHtml(modal, `
        <div class="modal agent-eval-editor-modal">
            <div class="agent-config-modal-head">
                <div class="agent-eval-editor-heading">
                    <h3 id="agent-eval-editor-title">新建评测集</h3>
                    <p>配置评测目标、通过标准与用例</p>
                </div>
                <button type="button" class="btn-secondary" data-agent-eval-editor-close>关闭</button>
            </div>
            <div class="agent-eval-editor-body">
                <input type="hidden" id="agent-eval-editor-id">
                <section class="agent-eval-editor-section">
                    <div class="agent-eval-editor-section-head">
                        <strong>基础设置</strong>
                    </div>
                    <div class="modal-form-grid modal-form-grid--3 agent-eval-suite-fields">
                        <div class="modal-form-field"><label for="agent-eval-editor-name">名称</label><input id="agent-eval-editor-name" class="form-input" maxlength="100"></div>
                        <div class="modal-form-field"><label for="agent-eval-editor-target">目标类型</label><select id="agent-eval-editor-target" class="form-input"><option value="free">自主任务</option><option value="workflow">工作流</option></select></div>
                        <div class="modal-form-field"><label for="agent-eval-editor-model">模型</label><select id="agent-eval-editor-model" class="form-input"></select></div>
                        <div class="modal-form-field" data-agent-eval-workflow-field><label for="agent-eval-editor-workflow">工作流</label><select id="agent-eval-editor-workflow" class="form-input"></select></div>
                        <div class="modal-form-field"><label for="agent-eval-editor-threshold">通过线</label><input id="agent-eval-editor-threshold" class="form-input" type="number" min="1" max="100" value="80"></div>
                        <div class="modal-form-field modal-form-field--span-2"><label for="agent-eval-editor-description">说明</label><input id="agent-eval-editor-description" class="form-input" maxlength="500"></div>
                    </div>
                </section>
                <section class="agent-eval-editor-section agent-eval-editor-cases-section">
                    <div class="agent-eval-editor-case-toolbar">
                        <div><strong>评测用例</strong><span id="agent-eval-case-count">0 个用例</span></div>
                        <button id="agent-eval-add-case" type="button" class="btn-secondary">添加用例</button>
                    </div>
                    <div id="agent-eval-editor-cases" class="agent-eval-editor-cases"></div>
                </section>
            </div>
            <div class="agent-eval-editor-footer">
                <button type="button" class="btn-secondary" data-agent-eval-editor-close>取消</button>
                <button id="agent-eval-editor-save" type="button" class="btn-primary">保存评测集</button>
            </div>
        </div>
    `);
    document.body.appendChild(modal);
    modal.addEventListener('click', event => {
        if (event.target === modal || event.target.closest('[data-agent-eval-editor-close]')) modal.classList.add('hidden');
    });
    modal.querySelector('#agent-eval-add-case').addEventListener('click', () => {
        collectAgentEvalEditorCases(false);
        agentEvalEditorCases.push(defaultAgentEvalCase());
        renderAgentEvalEditorCases();
    });
    modal.querySelector('#agent-eval-editor-target').addEventListener('change', updateAgentEvalEditorTarget);
    modal.querySelector('#agent-eval-editor-save').addEventListener('click', saveAgentEvalSuite);
    return modal;
}

function updateAgentEvalEditorTarget() {
    const modal = document.getElementById('agent-eval-editor-modal');
    if (!modal) return;
    const isWorkflow = modal.querySelector('#agent-eval-editor-target').value === 'workflow';
    modal.querySelector('[data-agent-eval-workflow-field]')?.classList.toggle('hidden', !isWorkflow);
}

async function openAgentEvalEditor(payload = null, seed = null) {
    const modal = ensureAgentEvalEditorModal();
    const suite = payload?.suite || {};
    const workflows = await loadAgentEvalWorkflows();
    const models = window._cachedAgentModels || [];
    PivotSafeHtml.setHtml(modal.querySelector('#agent-eval-editor-model'), `<option value="">自动选择</option>${models.map(model => `<option value="${agentEscapeAttr(model.id)}">${agentEscape(model.name)}</option>`).join('')}`);
    PivotSafeHtml.setHtml(modal.querySelector('#agent-eval-editor-workflow'), `<option value="">请选择已发布工作流</option>${workflows.filter(item => item.is_published).map(item => `<option value="${agentEscapeAttr(item.id)}">${agentEscape(item.name)} · v${Number(item.published_version || 0)}</option>`).join('')}`);
    modal.querySelector('#agent-eval-editor-id').value = suite.id || '';
    modal.querySelector('#agent-eval-editor-name').value = suite.name || (seed ? `${agentDisplayTitle(seed)}质量回归` : '');
    modal.querySelector('#agent-eval-editor-description').value = suite.description || '';
    modal.querySelector('#agent-eval-editor-target').value = suite.target_type || (seed?.run_mode === 'dag' ? 'workflow' : 'free');
    modal.querySelector('#agent-eval-editor-model').value = suite.model_id || seed?.model_id || document.getElementById('agent-model-select')?.value || '';
    modal.querySelector('#agent-eval-editor-workflow').value = suite.workflow_id || '';
    modal.querySelector('#agent-eval-editor-threshold').value = Number(suite.run_config?.passThreshold || 80);
    agentEvalEditorRunConfig = { ...(suite.run_config || {}), maxSteps: Number(suite.run_config?.maxSteps || 10) };
    agentEvalEditorCases = (payload?.cases || []).map(item => ({ ...item }));
    if (seed && !agentEvalEditorCases.some(item => item.input === seed.goal)) agentEvalEditorCases.push(defaultAgentEvalCase(seed));
    if (!agentEvalEditorCases.length) agentEvalEditorCases.push(defaultAgentEvalCase(seed));
    modal.querySelector('#agent-eval-editor-title').textContent = suite.id ? '编辑评测集' : '新建评测集';
    updateAgentEvalEditorTarget();
    renderAgentEvalEditorCases();
    modal.classList.remove('hidden');
}

async function saveAgentEvalSuite() {
    const modal = document.getElementById('agent-eval-editor-modal');
    if (!modal) return;
    try {
        const id = modal.querySelector('#agent-eval-editor-id').value;
        const targetType = modal.querySelector('#agent-eval-editor-target').value;
        const workflowId = modal.querySelector('#agent-eval-editor-workflow').value;
        const cases = collectAgentEvalEditorCases(true);
        if (!cases.length) throw new Error('至少添加一个评测用例');
        if (cases.some(item => !item.input)) throw new Error('每个评测用例都需要任务输入');
        if (targetType === 'workflow' && !workflowId) throw new Error('请选择已发布工作流');
        if (targetType === 'free' && !modal.querySelector('#agent-eval-editor-model').value) throw new Error('请选择评测模型');
        const workflow = agentEvalWorkflowsCache.find(item => String(item.id) === String(workflowId));
        const payload = {
            name: modal.querySelector('#agent-eval-editor-name').value,
            description: modal.querySelector('#agent-eval-editor-description').value,
            targetType,
            modelId: modal.querySelector('#agent-eval-editor-model').value || null,
            workflowId: workflowId || null,
            workflowVersion: targetType === 'workflow' ? 'published' : '',
            runConfig: { ...agentEvalEditorRunConfig, passThreshold: Number(modal.querySelector('#agent-eval-editor-threshold').value || 80) },
            cases
        };
        if (targetType === 'workflow' && !workflow?.is_published) throw new Error('目标工作流尚未发布');
        const response = await apiFetch(id ? `${API_BASE}/agents/evaluations/suites/${encodeURIComponent(id)}` : `${API_BASE}/agents/evaluations/suites`, {
            method: id ? 'PUT' : 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || '评测集保存失败');
        modal.classList.add('hidden');
        activeAgentEvalSuiteId = String(data.suite.id);
        showToast(id ? '评测集已更新' : '评测集已创建', 'success');
        await loadAgentEvaluationSuites({ silent: true });
        await loadAgentEvalSuite(activeAgentEvalSuiteId);
    } catch (error) {
        showToast(error.message || '评测集保存失败', 'error');
    }
}

function runAgentEvalSuite(suiteId, caseCount) {
    showConfirm('运行质量评测', `将创建 ${caseCount} 个真实智能体任务，并计入模型用量。确定继续吗？`, async () => {
        const response = await apiFetch(`${API_BASE}/agents/evaluations/suites/${encodeURIComponent(suiteId)}/runs`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) return showToast(data.error || '评测启动失败', 'error');
        showToast('评测任务已进入队列', 'success');
        await loadAgentEvalSuite(suiteId, { silent: true });
        await loadAgentEvalRun(data.run.id);
    });
}

function deleteAgentEvalSuite(suiteId) {
    showConfirm('归档评测集', '归档后不再显示，但历史任务与评测数据仍保留。', async () => {
        const response = await apiFetch(`${API_BASE}/agents/evaluations/suites/${encodeURIComponent(suiteId)}`, { method: 'DELETE' });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) return showToast(data.error || '评测集归档失败', 'error');
        activeAgentEvalSuiteId = '';
        const detail = document.getElementById('agent-eval-suite-detail');
        if (detail) PivotSafeHtml.setHtml(detail, '<div class="empty-state">请选择或新建评测集</div>');
        await loadAgentEvaluationSuites({ silent: true });
        showToast('评测集已归档', 'success');
    });
}

function bindAgentEvaluationCenter() {
    const createButton = document.getElementById('agent-eval-create-btn');
    if (createButton && createButton.dataset.boundAgentEval !== '1') {
        createButton.dataset.boundAgentEval = '1';
        createButton.addEventListener('click', () => openAgentEvalEditor());
    }
    const refreshButton = document.getElementById('agent-eval-refresh-btn');
    if (refreshButton && refreshButton.dataset.boundAgentEval !== '1') {
        refreshButton.dataset.boundAgentEval = '1';
        refreshButton.addEventListener('click', () => loadAgentEvaluationSuites({ keepDetail: true }).catch(error => showToast(error.message, 'error')));
    }
}

async function openAgentEvaluationForRun(run) {
    closeAgentRunDetailModal();
    openAgentConfigSection('evaluations');
    let payload = null;
    if (activeAgentEvalSuiteId) payload = await loadAgentEvalSuite(activeAgentEvalSuiteId, { silent: true });
    await openAgentEvalEditor(payload, run);
}

window.Pivot.exposeModule('agent.evaluations', {
    bind: bindAgentEvaluationCenter,
    loadSuites: loadAgentEvaluationSuites,
    openForRun: openAgentEvaluationForRun
});
