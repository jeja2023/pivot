(function () {
    'use strict';
    const app = window.Pivot.legacy.PivotDataAnalysis; const { esc } = app; const $ = id => document.getElementById(id);
    const fields = { account: '本方账户（必选）', counterpartyAccount: '对手账户', counterpartyName: '对手户名', time: '交易时间（必选）', amount: '金额（必选）', direction: '借贷或收支方向', currency: '币种', balance: '余额', memo: '摘要', transactionId: '交易编号', status: '交易状态' };
    const ruleLabels = { largeAmount: '大额交易', roundAmount: '整数金额', lateNight: '凌晨交易', frequency: '短时高频', quickInOut: '短时进出匹配', balanceMismatch: '余额连续性差异' };
    let timer; let sequence = 0; let datasetId; let job; let dialog;
    const api = '/api/apps/data-analysis/transactions';
    const request = (path, options) => app.fetchJson(api + path, options);
    const json = body => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const html = (node, value) => PivotSafeHtml.setHtml(node, value);
    const table = (header, rows) => {
        const head = header.map(text => `<th>${esc(text)}</th>`).join('');
        const body = rows.map(row => {
            const cells = row.map(text => `<td>${esc(text ?? '')}</td>`).join('');
            return `<tr>${cells}</tr>`;
        }).join('');
        const empty = `<tr><td colspan="${header.length}">暂无数据</td></tr>`;
        return `<div class="table-container"><table class="data-table compact-table"><thead><tr>${head}</tr></thead><tbody>${body || empty}</tbody></table></div>`;
    };
    function close() { clearTimeout(timer); sequence++; dialog?.remove(); dialog = null; job = null; }
    function modal(title, body) {
        close(); dialog = document.createElement('div'); dialog.id = 'finance-dialog'; dialog.className = 'modal-overlay'; dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); dialog.setAttribute('aria-label', title);
        html(dialog, `<div class="workspace-modal"><div class="workspace-modal-header"><h3>${esc(title)}</h3><button class="btn-secondary" type="button" data-finance="close">关闭</button></div><div class="workspace-modal-body workspace-scroll-content">${body}<p id="finance-dialog-status" role="status"></p></div></div>`);
        $('data-analysis-view').appendChild(dialog); dialog.querySelector('input,select,button')?.focus();
    }
    function configForm(config = {}) {
        const dataset = app.state.datasets.find(row => row.id === datasetId); if (!dataset) throw new Error('请先选择数据集。');
        const options = '<option value="">不使用</option>' + dataset.columns.map(column => `<option value="${esc(column.key)}">${esc(column.name)}</option>`).join('');
        modal('确认交易映射与统计口径', `<p>账户需要以文本保存才能保留前导零；已经数值化的账户不能由系统恢复。请确认借贷方向的本方视角，金额不接受货币符号或千位分隔。每次创建都会保存一份独立映射和规则版本。</p><div class="mindmap-property-grid">${Object.entries(fields).map(([key, label]) => `<label>${esc(label)}<select class="form-input" id="finance-field-${key}">${options}</select></label>`).join('')}</div><label>金额口径<select class="form-input" id="finance-mode"><option value="signed">正数为收入，负数为支出</option><option value="direction">按已确认的收支方向映射，负数视作冲正</option></select></label><label>收入方向值（逗号分隔）<input class="form-input" id="finance-income" value="${esc((config.incomeValues || ['收入','入','贷']).join(','))}"></label><label>支出方向值（逗号分隔）<input class="form-input" id="finance-expense" value="${esc((config.expenseValues || ['支出','出','借']).join(','))}"></label><label>默认币种<input class="form-input" maxlength="3" id="finance-currency" value="${esc(config.defaultCurrency || 'CNY')}"></label><label>时区偏移分钟<input class="form-input" type="number" min="-840" max="840" id="finance-zone" value="${config.timezoneOffsetMinutes ?? 480}"></label><label>本方账户范围（逗号分隔，空为全部）<textarea class="form-input" id="finance-accounts" rows="2">${esc((config.accounts || []).join(','))}</textarea></label><label>内部转账<select class="form-input" id="finance-internal"><option value="include">包含全部记录</option><option value="exclude-both-in-scope">排除双方均在本方账户范围的交易</option></select></label><label>重复记录<select class="form-input" id="finance-duplicate"><option value="exclude-id">按账户、币种和交易编号排除重复（无编号则保留）</option><option value="exclude-exact">排除字段完全相同的记录</option><option value="include">全部保留</option></select></label><label>大额阈值（每行 币种=金额）<textarea class="form-input" id="finance-thresholds" rows="3">${esc(Object.entries(config.rules?.thresholds || { CNY: '10000' }).map(([currency, amount]) => `${currency}=${amount}`).join('\n'))}</textarea></label><label>整数金额单位<input class="form-input" id="finance-round" value="${esc(config.rules?.roundAmount || '1000')}"></label><label>短时进出最低金额<input class="form-input" id="finance-minimum" value="${esc(config.rules?.quickMinimum || '1000')}"></label><label>时间窗（分钟）<input class="form-input" type="number" min="1" max="1440" id="finance-window" value="${config.rules?.windowMinutes || 60}"></label><label>高频阈值（笔）<input class="form-input" type="number" min="2" max="1000" id="finance-frequency" value="${config.rules?.frequency || 20}"></label><label>摘要分类规则（每行 关键词=分类，按先后匹配）<textarea class="form-input" id="finance-categories" rows="4">${esc((config.categories || []).map(rule => `${rule.value}=${rule.label}`).join('\n'))}</textarea></label><label>人工分类修正（每行 来源行号=分类）<textarea class="form-input" id="finance-corrections" rows="3">${esc(Object.entries(config.corrections || {}).map(([row, label]) => `${row}=${label}`).join('\n'))}</textarea></label><label>分析保留天数<input class="form-input" type="number" min="1" max="365" id="finance-retention" value="${config.retentionDays || 30}"></label><p>保留期到期或删除分析时，清理本分析、关联报告和自动生成的导图；源数据集按数据集生命周期保留。主动另存的副本、已下载文件和备份按各自策略管理。</p><button class="btn-primary" type="button" data-finance="create">确认并运行分析</button>`);
        for (const [key, value] of Object.entries(config.mapping || {})) if ($(`finance-field-${key}`)) $(`finance-field-${key}`).value = value;
        $('finance-mode').value = config.amountMode || 'signed'; $('finance-internal').value = config.internalTransfer || 'include'; $('finance-duplicate').value = config.duplicatePolicy || 'exclude-id';
    }
    const pairs = value => Object.fromEntries(value.split('\n').map(line => line.trim()).filter(Boolean).map(line => { const index = line.indexOf('='); if (index < 1) throw new Error('每行需要使用“名称=值”的格式。'); return [line.slice(0, index).trim(), line.slice(index + 1).trim()]; }));
    function inputConfig() {
        const values = id => $(id).value.split(/[,，]/).map(text => text.trim()).filter(Boolean);
        return { datasetId, mapping: Object.fromEntries(Object.keys(fields).map(key => [key, $(`finance-field-${key}`).value]).filter(([, value]) => value)), amountMode: $('finance-mode').value, incomeValues: values('finance-income'), expenseValues: values('finance-expense'), defaultCurrency: $('finance-currency').value, timezoneOffsetMinutes: Number($('finance-zone').value), accounts: values('finance-accounts'), internalTransfer: $('finance-internal').value, duplicatePolicy: $('finance-duplicate').value, rules: { thresholds: pairs($('finance-thresholds').value), roundAmount: $('finance-round').value, quickMinimum: $('finance-minimum').value, windowMinutes: Number($('finance-window').value), frequency: Number($('finance-frequency').value) }, categories: Object.entries(pairs($('finance-categories').value)).map(([value, label], index) => ({ id: `category-${index + 1}`, field: 'memo', operator: 'contains', value, label })), corrections: pairs($('finance-corrections').value), retentionDays: Number($('finance-retention').value), requestKey: `finance:${window.crypto.randomUUID()}` };
    }
    async function refresh() {
        const version = ++sequence; clearTimeout(timer); datasetId = $('finance-dataset').value;
        if (!datasetId) { html($('finance-runs'), ''); return; }
        const result = await request(`?datasetId=${encodeURIComponent(datasetId)}`); if (version !== sequence) return;
        html($('finance-runs'), result.rows.map(row => `<tr><td>${esc(row.id.slice(0, 8))}</td><td>${esc({ queued: '排队中', running: '计算中', succeeded: '已完成', failed: '失败' }[row.status] || row.status)}</td><td>${esc(new Date(row.created_at).toLocaleString())}</td><td>${esc(row.error)}</td><td><button class="btn-secondary" type="button" data-finance="view" data-id="${row.id}">查看</button> <button class="btn-danger" type="button" data-finance="delete" data-id="${row.id}">删除</button></td></tr>`).join('') ||
            '<tr><td colspan="5">暂无分析，确认字段映射后创建。</td></tr>');
        if (!dialog && result.rows.some(row => ['queued','running'].includes(row.status))) timer = setTimeout(() => { void refresh().catch(app.toast); }, 3000);
    }
    function detail(value) {
        const result = value.result;
        const body = result ? `<p>分析编号 ${esc(value.id)}；规则版本 ${esc(result.ruleVersion.slice(0, 12))}；纳入 ${result.counts.accepted} / ${result.counts.source} 行；无效 ${result.counts.invalid} 行；重复排除 ${result.counts.duplicates} 行。</p><h4>收支概览</h4>${table(['币种','收入','支出','净流量','笔数'], result.currencies.map(row => [row.currency,row.income,row.expense,row.net,row.count]))}<h4>月度收支</h4>${table(['币种','月份','收入','支出','净流量'], result.monthly.slice(0, 100).map(row => [row.currency,row.month,row.income,row.expense,row.net]))}<h4>周度收支（周一开始）</h4>${table(['币种','周起始日','收入','支出'], result.weekly.slice(0, 100).map(row => [row.currency,row.week,row.income,row.expense]))}<h4>对手方汇总</h4>${table(['币种','脱敏账户','收入','支出','笔数','窗口内首见','来源行'], result.counterparties.map(row => [row.currency,row.account,row.income,row.expense,row.count,row.firstSeen,row.evidenceRows.join('、')]))}<h4>分类汇总</h4>${table(['币种','分类','收入','支出'], result.categories.map(row => [row.currency,row.category,row.income,row.expense]))}<h4>待核验线索</h4>${table(['规则','币种','金额','来源行'], result.evidence.map(row => [ruleLabels[row.rule],row.currency,row.amount,row.rows.join('、')]))}<h4>无效记录（最多展示一百项）</h4>${table(['来源行','原因'], result.issues.map(row => [row.row,row.reason]))}<p>${result.caveats.map(esc).join('<br>')}</p><div class="mindmap-toolbar"><button class="btn-secondary" type="button" data-finance="rerun">修正映射或分类后重算</button><button class="btn-secondary" type="button" data-finance="docx">生成 Word</button><button class="btn-secondary" type="button" data-finance="pdf">生成 PDF</button><button class="btn-secondary" type="button" data-finance="mindmap">生成导图</button><button class="btn-secondary" type="button" data-finance="ai">AI 解读</button></div><div id="finance-outputs"></div><div id="finance-ai" role="status"></div>` : `<p>${esc(value.status === 'failed' ? value.error : '任务正在处理，请稍后刷新查看。')}</p><button class="btn-secondary" type="button" data-finance="rerun">修正后重新分析</button>`;
        modal('资金交易分析结果', body); job = value;
        if (result) void outputs().catch(app.toast);
    }
    async function outputs() {
        const current = sequence; const id = job.id; clearTimeout(timer);
        const result = await request(`/${id}/outputs`); if (current !== sequence || job?.id !== id || !$('finance-outputs')) return;
        $('finance-outputs').replaceChildren();
        for (const output of result.rows) {
            const row = document.createElement('p'); row.textContent = `${output.format.toUpperCase()}：${({ queued: '排队中', running: '生成中', succeeded: '已生成', failed: output.error })[output.status] || output.status} `;
            if (output.status === 'succeeded') { const button = document.createElement('button'); button.className = 'btn-secondary'; button.type = 'button'; button.dataset.finance = output.format === 'mindmap' ? 'open-map' : 'download'; button.dataset.artifact = output.artifact_id; button.dataset.rendition = output.rendition_id; button.textContent = output.format === 'mindmap' ? '打开导图' : '下载'; row.appendChild(button); }
            $('finance-outputs').appendChild(row);
        }
        if (result.rows.some(row => ['queued','running'].includes(row.status))) timer = setTimeout(() => { void outputs().catch(app.toast); }, 2000);
    }
    async function action(button) {
        const name = button.dataset.finance;
        if (name === 'close') { close(); return refresh(); }
        if (name === 'new') return configForm();
        if (name === 'refresh') return refresh();
        if (name === 'create') { const version = sequence; const response = await request('', json(inputConfig())); if (version !== sequence) return; close(); await refresh(); detail(response.job); return; }
        if (name === 'view') { const version = sequence; const response = await request(`/${button.dataset.id}`); if (version === sequence) detail(response.job); return; }
        if (name === 'delete') { if (!window.confirm('删除此分析及关联报告、自动生成导图？此操作不能恢复，已下载或主动另存的副本由你管理。')) return; await request(`/${button.dataset.id}`, { method: 'DELETE' }); return refresh(); }
        if (name === 'rerun') { const config = job.config; return configForm(config); }
        if (['docx','pdf','mindmap'].includes(name)) { const version = sequence; await request(`/${job.id}/outputs`, json({ format: name })); if (version === sequence) await outputs(); return; }
        if (name === 'ai') { const version = sequence; $('finance-ai').textContent = '正在生成基于已计算事实的解读…'; let response; try { response = await request(`/${job.id}/ai`, json({ model: $('data-analysis-ai-model')?.value || '' })); } catch (error) { if (version === sequence && $('finance-ai')) $('finance-ai').textContent = `解读失败：${error.message}`; throw error; } if (version === sequence && $('finance-ai')) $('finance-ai').textContent = response.content || response.text || '未返回解读。'; return; }
        if (name === 'open-map') { const id = button.dataset.artifact; close(); await window.Pivot.loadScriptOnce('/chat/apps-workbench-mindmaps.js'); return window.Pivot.moduleApi('apps.mindmaps').show({ artifactId: id }); }
        if (name === 'download') {
            const response = await app.fetchJson(`/api/agents/renditions/${button.dataset.rendition}/download-token`, json({}));
            const anchor = document.createElement('a'); anchor.href = `/api/agents/renditions/${button.dataset.rendition}/download?token=${encodeURIComponent(response.token)}`; anchor.rel = 'noopener'; anchor.click();
        }
    }
    function mount() {
        const root = $('data-analysis-view'); if (!root || $('data-analysis-transactions-panel')) return;
        const button = document.createElement('button'); button.className = 'data-analysis-tab'; button.type = 'button'; button.dataset.dataAnalysisTab = 'transactions'; button.textContent = '资金交易分析'; root.querySelector('.data-analysis-tabs').appendChild(button);
        const panel = document.createElement('section'); panel.id = 'data-analysis-transactions-panel'; panel.className = 'data-analysis-tab-panel hidden';
        html(panel, '<div class="workspace-toolbar mindmap-toolbar"><label>数据集<select class="form-input" id="finance-dataset"></select></label><button class="btn-primary" type="button" data-finance="new">新建资金分析</button><button class="btn-secondary" type="button" data-finance="refresh">刷新</button></div><p>确认字段与收支口径后，按币种计算精确金额；分类与异常规则结果均保留来源行号。</p><div class="table-container"><table class="data-table compact-table"><thead><tr><th>编号</th><th>状态</th><th>创建时间</th><th>错误信息</th><th>操作</th></tr></thead><tbody id="finance-runs"></tbody></table></div>'); root.querySelector('.data-analysis-main').appendChild(panel);
        root.addEventListener('click', event => { const target = event.target.closest('[data-finance]'); if (target) { target.disabled = true; void action(target).catch(error => { if ($('finance-dialog-status')) $('finance-dialog-status').textContent = error.message; app.toast(error.message, 'error'); }).finally(() => { if (target.isConnected) target.disabled = false; }); } });
        $('finance-dataset').addEventListener('change', () => { close(); void refresh().catch(app.toast); });
    }
    const ensureView = app.ensureView; app.ensureView = function (...args) { const result = ensureView(...args); mount(); return result; };
    const onTab = app.onDataAnalysisTabActivated; app.onDataAnalysisTabActivated = function (tab) { onTab?.(tab); if (tab !== 'transactions') { close(); return; } mount(); html($('finance-dataset'), app.state.datasets.map(dataset => `<option value="${esc(dataset.id)}">${esc(dataset.name)}</option>`).join('')); $('finance-dataset').value = datasetId || app.state.activeId || app.state.datasets[0]?.id || ''; void refresh().catch(app.toast); };
    const resetAi = app.resetAiWorkspace; app.resetAiWorkspace = (...args) => { close(); return resetAi?.(...args); };
    app.transactionReset = close;
})();
