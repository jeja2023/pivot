(function () {
    'use strict';
    const app = window.Pivot.legacy.PivotDataAnalysis;
    const { esc } = app;
    const $ = id => document.getElementById(id);
    const fields = {
        account: '本方账户（必选）',
        counterpartyAccount: '对手账户',
        counterpartyName: '对手户名',
        time: '交易时间（必选）',
        amount: '金额（必选）',
        direction: '借贷或收支方向',
        currency: '币种',
        balance: '余额',
        memo: '摘要',
        transactionId: '交易编号',
        status: '交易状态'
    };
    const ruleLabels = {
        largeAmount: '大额交易',
        roundAmount: '整数金额',
        lateNight: '凌晨交易',
        frequency: '短时高频',
        quickInOut: '短时进出匹配',
        balanceMismatch: '余额连续性差异'
    };
    let timer;
    let sequence = 0;
    let datasetId;
    let job;
    let dialog;
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

    function close() {
        clearTimeout(timer);
        sequence++;
        dialog?.remove();
        dialog = null;
        job = null;
    }

    function modal(title, body, options = {}) {
        close();
        dialog = document.createElement('div');
        dialog.id = 'finance-dialog';
        dialog.className = 'modal-overlay';
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');
        dialog.setAttribute('aria-label', title);
        const closeBtn = options.hideClose ? '' : '<button class="btn-secondary" type="button" data-finance="close">关闭</button>';
        html(dialog, `<div class="workspace-modal finance-modal-dialog"><div class="workspace-modal-header"><h3>${esc(title)}</h3>${closeBtn}</div><div class="workspace-modal-body workspace-scroll-content">${body}<p id="finance-dialog-status" role="status"></p></div></div>`);
        $('data-analysis-view').appendChild(dialog);
        dialog.querySelector('input,select,button')?.focus();
    }

    function configForm(config = {}) {
        const dataset = app.state.datasets.find(row => row.id === datasetId);
        if (!dataset) throw new Error('请先选择数据集。');
        const options = '<option value="">不使用</option>' + dataset.columns.map(column => `<option value="${esc(column.key)}">${esc(column.name)}</option>`).join('');

        const mappingFields = Object.entries(fields).map(([key, label]) =>
            `<div class="finance-form-field"><label for="finance-field-${key}">${esc(label)}</label><select class="form-input" id="finance-field-${key}">${options}</select></div>`
        ).join('');

        const content = `
        <div class="finance-section-card">
            <div class="finance-section-title">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h16M4 12h16M4 17h10"/></svg>
                <span>数据字段映射（账户需以文本保存以维系前导零，金额禁止货币符号）</span>
            </div>
            <div class="finance-grid-3col">${mappingFields}</div>
        </div>

        <div class="finance-section-card">
            <div class="finance-section-title">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
                <span>收支口径与计算基准</span>
            </div>
            <div class="finance-grid-3col">
                <div class="finance-form-field">
                    <label for="finance-mode">金额识别口径</label>
                    <select class="form-input" id="finance-mode">
                        <option value="signed">正数为收入，负数为支出</option>
                        <option value="direction">按收支方向映射，负数冲正</option>
                    </select>
                </div>
                <div class="finance-form-field">
                    <label for="finance-income">收入标识词（逗号分隔）</label>
                    <input class="form-input" id="finance-income" value="${esc((config.incomeValues || ['收入', '入', '贷']).join(','))}">
                </div>
                <div class="finance-form-field">
                    <label for="finance-expense">支出标识词（逗号分隔）</label>
                    <input class="form-input" id="finance-expense" value="${esc((config.expenseValues || ['支出', '出', '借']).join(','))}">
                </div>
                <div class="finance-form-field">
                    <label for="finance-currency">默认币种代码</label>
                    <input class="form-input" maxlength="3" id="finance-currency" value="${esc(config.defaultCurrency || 'CNY')}">
                </div>
                <div class="finance-form-field">
                    <label for="finance-zone">时区偏移（分钟，东八区填 480）</label>
                    <input class="form-input" type="number" min="-840" max="840" id="finance-zone" value="${config.timezoneOffsetMinutes ?? 480}">
                </div>
                <div class="finance-form-field">
                    <label for="finance-retention">分析保留天数（到期自动清理）</label>
                    <input class="form-input" type="number" min="1" max="365" id="finance-retention" value="${config.retentionDays || 30}">
                </div>
            </div>
        </div>

        <div class="finance-section-card">
            <div class="finance-section-title">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                <span>账户范围与去重策略</span>
            </div>
            <div class="finance-grid-2col">
                <div class="finance-form-field">
                    <label for="finance-accounts">本方账户白名单（逗号分隔，留空纳入全部）</label>
                    <textarea class="form-input" id="finance-accounts" rows="2">${esc((config.accounts || []).join(','))}</textarea>
                </div>
                <div class="finance-form-field">
                    <label for="finance-internal">内部转账处理规则</label>
                    <select class="form-input" id="finance-internal">
                        <option value="include">包含全部内部交易</option>
                        <option value="exclude-both-in-scope">排除双方均在本方账户范围的对调交易</option>
                    </select>
                    <label for="finance-duplicate">重复交易排除模式</label>
                    <select class="form-input" id="finance-duplicate">
                        <option value="exclude-id">按账户、币种与交易编号去重</option>
                        <option value="exclude-exact">按各字段完全相同去重</option>
                        <option value="include">全部保留</option>
                    </select>
                </div>
            </div>
        </div>

        <div class="finance-section-card">
            <div class="finance-section-title">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
                <span>异动线索审计规则</span>
            </div>
            <div class="finance-grid-3col">
                <div class="finance-form-field">
                    <label for="finance-thresholds">大额阈值（每行 币种=金额）</label>
                    <textarea class="form-input" id="finance-thresholds" rows="2">${esc(Object.entries(config.rules?.thresholds || { CNY: '10000' }).map(([curr, amt]) => `${curr}=${amt}`).join('\n'))}</textarea>
                </div>
                <div class="finance-form-field">
                    <label for="finance-round">整数金额基数</label>
                    <input class="form-input" id="finance-round" value="${esc(config.rules?.roundAmount || '1000')}">
                    <label for="finance-minimum">快进快出最低门槛</label>
                    <input class="form-input" id="finance-minimum" value="${esc(config.rules?.quickMinimum || '1000')}">
                </div>
                <div class="finance-form-field">
                    <label for="finance-window">滑动时间窗（分钟）</label>
                    <input class="form-input" type="number" min="1" max="1440" id="finance-window" value="${config.rules?.windowMinutes || 60}">
                    <label for="finance-frequency">短时频次阈值（笔）</label>
                    <input class="form-input" type="number" min="2" max="1000" id="finance-frequency" value="${config.rules?.frequency || 20}">
                </div>
            </div>
        </div>

        <div class="finance-section-card">
            <div class="finance-section-title">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/></svg>
                <span>摘要智能分类与人工修正</span>
            </div>
            <div class="finance-grid-2col">
                <div class="finance-form-field">
                    <label for="finance-categories">摘要分类规则（每行 关键词=分类名，按顺序优先匹配）</label>
                    <textarea class="form-input" id="finance-categories" rows="3">${esc((config.categories || []).map(r => `${r.value}=${r.label}`).join('\n'))}</textarea>
                </div>
                <div class="finance-form-field">
                    <label for="finance-corrections">人工分类强制修正（每行 原始行号=分类名）</label>
                    <textarea class="form-input" id="finance-corrections" rows="3">${esc(Object.entries(config.corrections || {}).map(([r, label]) => `${r}=${label}`).join('\n'))}</textarea>
                </div>
            </div>
        </div>

        <div class="finance-modal-actions">
            <button class="btn-secondary" type="button" data-finance="close">取消</button>
            <button class="btn-primary finance-btn-new" type="button" data-finance="create">确认配置并开始分析</button>
        </div>`;

        modal('确认资金分析映射与审计规则', content, { hideClose: true });
        for (const [key, value] of Object.entries(config.mapping || {})) {
            if ($(`finance-field-${key}`)) $(`finance-field-${key}`).value = value;
        }
        $('finance-mode').value = config.amountMode || 'signed';
        $('finance-internal').value = config.internalTransfer || 'include';
        $('finance-duplicate').value = config.duplicatePolicy || 'exclude-id';
    }

    const pairs = value => Object.fromEntries(
        value.split('\n')
            .map(line => line.trim())
            .filter(Boolean)
            .map(line => {
                const index = line.indexOf('=');
                if (index < 1) throw new Error('配置项每行需要使用“名称=值”的格式。');
                return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
            })
    );

    function inputConfig() {
        const values = id => $(id).value.split(/[,，]/).map(text => text.trim()).filter(Boolean);
        return {
            datasetId,
            mapping: Object.fromEntries(Object.keys(fields).map(key => [key, $(`finance-field-${key}`).value]).filter(([, value]) => value)),
            amountMode: $('finance-mode').value,
            incomeValues: values('finance-income'),
            expenseValues: values('finance-expense'),
            defaultCurrency: $('finance-currency').value,
            timezoneOffsetMinutes: Number($('finance-zone').value),
            accounts: values('finance-accounts'),
            internalTransfer: $('finance-internal').value,
            duplicatePolicy: $('finance-duplicate').value,
            rules: {
                thresholds: pairs($('finance-thresholds').value),
                roundAmount: $('finance-round').value,
                quickMinimum: $('finance-minimum').value,
                windowMinutes: Number($('finance-window').value),
                frequency: Number($('finance-frequency').value)
            },
            categories: Object.entries(pairs($('finance-categories').value)).map(([value, label], index) => ({
                id: `category-${index + 1}`,
                field: 'memo',
                operator: 'contains',
                value,
                label
            })),
            corrections: pairs($('finance-corrections').value),
            retentionDays: Number($('finance-retention').value),
            requestKey: `finance:${window.crypto.randomUUID()}`
        };
    }

    async function refresh() {
        const version = ++sequence;
        clearTimeout(timer);
        datasetId = $('finance-dataset')?.value;
        if (!datasetId) {
            html($('finance-runs'), '');
            if ($('finance-runs-count')) $('finance-runs-count').textContent = '0 项记录';
            return;
        }
        const result = await request(`?datasetId=${encodeURIComponent(datasetId)}`);
        if (version !== sequence) return;

        if ($('finance-runs-count')) {
            $('finance-runs-count').textContent = `${result.rows.length} 项记录`;
        }

        const statusMap = {
            queued: '<span class="finance-status-pill is-queued"><span class="finance-status-dot"></span>排队中</span>',
            running: '<span class="finance-status-pill is-running"><span class="finance-status-dot"></span>计算中</span>',
            succeeded: '<span class="finance-status-pill is-succeeded"><span class="finance-status-dot"></span>已完成</span>',
            failed: '<span class="finance-status-pill is-failed"><span class="finance-status-dot"></span>失败</span>'
        };

        const emptyState = `
            <tr>
                <td colspan="5">
                    <div class="finance-empty-card">
                        <div class="finance-empty-icon">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><circle cx="11.5" cy="14.5" r="2.5"/><path d="M13.25 16.25L16 19"/></svg>
                        </div>
                        <strong>暂无资金分析记录</strong>
                        <p>当前数据集尚未运行资金分析。点击右上角“新建资金分析”，确认借贷与映射后将自动计算净流量与异动线索。</p>
                        <button class="btn-primary finance-btn-new" type="button" data-finance="new">
                            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                            新建资金分析
                        </button>
                    </div>
                </td>
            </tr>
        `;

        if (!result.rows || result.rows.length === 0) {
            html($('finance-runs'), emptyState);
            return;
        }

        const rowsHtml = result.rows.map(row => {
            const statusBadge = statusMap[row.status] || `<span class="finance-status-pill">${esc(row.status)}</span>`;
            const errorText = row.error ? esc(row.error) : '正常无异常';
            return `
                <tr>
                    <td><span class="finance-id-pill">${esc(row.id.slice(0, 8))}</span></td>
                    <td>${statusBadge}</td>
                    <td>${esc(new Date(row.created_at).toLocaleString())}</td>
                    <td>${errorText}</td>
                    <td>
                        <div class="finance-actions-cell">
                            <button class="btn-secondary" type="button" data-finance="view" data-id="${row.id}">查看结果</button>
                            <button class="btn-danger-outline" type="button" data-finance="delete" data-id="${row.id}">删除</button>
                        </div>
                    </td>
                </tr>
            `;
        }).join('');

        html($('finance-runs'), rowsHtml);
        if (!dialog && result.rows.some(row => ['queued', 'running'].includes(row.status))) {
            timer = setTimeout(() => { void refresh().catch(app.toast); }, 3000);
        }
    }

    function detail(value) {
        const result = value.result;
        let body;
        if (result) {
            body = `
                <div class="finance-summary-stats">
                    <div class="finance-stat-box"><small>纳入计算</small><strong>${result.counts.accepted}</strong> / ${result.counts.source} 行</div>
                    <div class="finance-stat-box"><small>无效记录</small><strong>${result.counts.invalid}</strong> 行</div>
                    <div class="finance-stat-box"><small>重复排除</small><strong>${result.counts.duplicates}</strong> 行</div>
                    <div class="finance-stat-box"><small>规则版本</small><span class="finance-id-pill">${esc(result.ruleVersion.slice(0, 12))}</span></div>
                </div>

                <div class="finance-result-section-title">收支概览</div>
                ${table(['币种', '收入', '支出', '净流量', '笔数'], result.currencies.map(row => [row.currency, row.income, row.expense, row.net, row.count]))}

                <div class="finance-result-section-title">月度收支走势</div>
                ${table(['币种', '月份', '收入', '支出', '净流量'], result.monthly.slice(0, 100).map(row => [row.currency, row.month, row.income, row.expense, row.net]))}

                <div class="finance-result-section-title">周度收支节奏（周一开始）</div>
                ${table(['币种', '周起始日', '收入', '支出'], result.weekly.slice(0, 100).map(row => [row.currency, row.week, row.income, row.expense]))}

                <div class="finance-result-section-title">对手方深度汇总</div>
                ${table(['币种', '脱敏账户', '收入', '支出', '笔数', '窗口内首见', '来源行'], result.counterparties.map(row => [row.currency, row.account, row.income, row.expense, row.count, row.firstSeen, row.evidenceRows.join('、')]))}

                <div class="finance-result-section-title">分类汇总</div>
                ${table(['币种', '分类', '收入', '支出'], result.categories.map(row => [row.currency, row.category, row.income, row.expense]))}

                <div class="finance-result-section-title">待核验异动线索</div>
                ${table(['规则', '币种', '金额', '来源行'], result.evidence.map(row => [ruleLabels[row.rule], row.currency, row.amount, row.rows.join('、')]))}

                <div class="finance-result-section-title">无效记录异常原因（最多展示一百项）</div>
                ${table(['来源行', '原因'], result.issues.map(row => [row.row, row.reason]))}

                <div class="finance-section-card finance-caveats-box">
                    <div class="finance-section-title">
                        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
                        <span>审计与合规提示</span>
                    </div>
                    <p class="finance-runs-card-hint">${result.caveats.map(esc).join('<br>')}</p>
                </div>

                <div class="finance-toolbar-row mindmap-toolbar">
                    <button class="btn-secondary" type="button" data-finance="rerun">修正映射重算</button>
                    <button class="btn-secondary" type="button" data-finance="docx">生成 Word 报告</button>
                    <button class="btn-secondary" type="button" data-finance="pdf">生成 PDF 报告</button>
                    <button class="btn-secondary" type="button" data-finance="mindmap">生成思维导图</button>
                    <button class="btn-secondary" type="button" data-finance="ai">AI 深度解读</button>
                </div>
                <div id="finance-outputs"></div>
                <div id="finance-ai" role="status"></div>
            `;
        } else {
            body = `
                <p>${esc(value.status === 'failed' ? value.error : '任务正在排队或后台计算中，请稍后刷新查看。')}</p>
                <button class="btn-secondary" type="button" data-finance="rerun">重新配置分析</button>
            `;
        }
        modal('资金分析结果', body);
        job = value;
        if (result) void outputs().catch(app.toast);
    }

    async function outputs() {
        const current = sequence;
        const id = job.id;
        clearTimeout(timer);
        const result = await request(`/${id}/outputs`);
        if (current !== sequence || job?.id !== id || !$('finance-outputs')) return;
        $('finance-outputs').replaceChildren();
        for (const output of result.rows) {
            const row = document.createElement('p');
            row.textContent = `${output.format.toUpperCase()}：${({ queued: '排队中', running: '生成中', succeeded: '已生成', failed: output.error })[output.status] || output.status} `;
            if (output.status === 'succeeded') {
                const button = document.createElement('button');
                button.className = 'btn-secondary';
                button.type = 'button';
                button.dataset.finance = output.format === 'mindmap' ? 'open-map' : 'download';
                button.dataset.artifact = output.artifact_id;
                button.dataset.rendition = output.rendition_id;
                button.textContent = output.format === 'mindmap' ? '打开导图' : '下载';
                row.appendChild(button);
            }
            $('finance-outputs').appendChild(row);
        }
        if (result.rows.some(row => ['queued', 'running'].includes(row.status))) {
            timer = setTimeout(() => { void outputs().catch(app.toast); }, 2000);
        }
    }

    async function action(button) {
        const name = button.dataset.finance;
        if (name === 'close') { close(); return refresh(); }
        if (name === 'new') return configForm();
        if (name === 'refresh') return refresh();
        if (name === 'create') {
            const version = sequence;
            const response = await request('', json(inputConfig()));
            if (version !== sequence) return;
            close();
            await refresh();
            detail(response.job);
            return;
        }
        if (name === 'view') {
            const version = sequence;
            const response = await request(`/${button.dataset.id}`);
            if (version === sequence) detail(response.job);
            return;
        }
        if (name === 'delete') {
            if (!window.confirm('删除此分析及关联报告、自动生成导图？此操作不能恢复，已下载或主动另存的副本由你管理。')) return;
            await request(`/${button.dataset.id}`, { method: 'DELETE' });
            return refresh();
        }
        if (name === 'rerun') {
            const config = job.config;
            return configForm(config);
        }
        if (['docx', 'pdf', 'mindmap'].includes(name)) {
            const version = sequence;
            await request(`/${job.id}/outputs`, json({ format: name }));
            if (version === sequence) await outputs();
            return;
        }
        if (name === 'ai') {
            const version = sequence;
            $('finance-ai').textContent = '正在生成基于已计算事实的解读…';
            let response;
            try {
                response = await request(`/${job.id}/ai`, json({ model: $('data-analysis-ai-model')?.value || '' }));
            } catch (error) {
                if (version === sequence && $('finance-ai')) $('finance-ai').textContent = `解读失败：${error.message}`;
                throw error;
            }
            if (version === sequence && $('finance-ai')) $('finance-ai').textContent = response.content || response.text || '未返回解读。';
            return;
        }
        if (name === 'open-map') {
            const id = button.dataset.artifact;
            close();
            await window.Pivot.loadScriptOnce('/chat/apps-workbench-mindmaps.js');
            return window.Pivot.moduleApi('apps.mindmaps').show({ artifactId: id });
        }
        if (name === 'download') {
            const response = await app.fetchJson(`/api/agents/renditions/${button.dataset.rendition}/download-token`, json({}));
            const anchor = document.createElement('a');
            anchor.href = `/api/agents/renditions/${button.dataset.rendition}/download?token=${encodeURIComponent(response.token)}`;
            anchor.rel = 'noopener';
            anchor.click();
        }
    }

    function mount() {
        const root = $('data-analysis-view');
        if (!root || $('data-analysis-transactions-panel')) return;
        const button = document.createElement('button');
        button.className = 'data-analysis-tab';
        button.type = 'button';
        button.dataset.dataAnalysisTab = 'transactions';
        button.textContent = '资金分析';
        root.querySelector('.data-analysis-tabs').appendChild(button);

        const panel = document.createElement('section');
        panel.id = 'data-analysis-transactions-panel';
        panel.className = 'data-analysis-tab-panel hidden';
        html(panel, `
            <div class="finance-header">
                <div class="finance-header-left">
                    <div class="finance-header-icon-badge">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
                    </div>
                    <div class="finance-header-intro">
                        <div class="finance-title-row">
                            <h5>资金分析工作台</h5>
                            <span class="finance-badge-safe">
                                <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                                高精度金额与溯源审计
                            </span>
                        </div>
                        <p>确认字段映射与借贷口径后，按币种精确计算收支净额；分类与异常异动均精准保留原始行号追溯证据。</p>
                    </div>
                </div>
                <div class="finance-header-actions">
                    <div class="finance-dataset-picker" title="切换分析数据集">
                        <div class="finance-dataset-prefix">
                            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>
                            <span>数据集</span>
                        </div>
                        <div class="finance-dataset-select-wrap">
                            <select class="form-input finance-dataset-select" id="finance-dataset" aria-label="分析数据集"></select>
                            <svg class="finance-dataset-chevron" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
                        </div>
                    </div>
                    <button class="btn-primary finance-btn-new" type="button" data-finance="new">
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                        新建资金分析
                    </button>
                    <button class="btn-secondary finance-btn-refresh" type="button" data-finance="refresh">
                        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
                        刷新
                    </button>
                </div>
            </div>

            <div class="finance-features-grid">
                <div class="finance-feature-card">
                    <div class="finance-feature-icon">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 16V4m0 0L3 8m4-4l4 4m6 4v12m0 0l4-4m-4 4l-4-4"/></svg>
                    </div>
                    <div class="finance-feature-content">
                        <strong>双向借贷精确核对</strong>
                        <p>支持按方向标记与正负数值双模式自动冲正，精确统计多币种收支净流量。</p>
                    </div>
                </div>
                <div class="finance-feature-card">
                    <div class="finance-feature-icon">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
                    </div>
                    <div class="finance-feature-content">
                        <strong>对手方深度穿透透视</strong>
                        <p>自动汇总本对手方交易频率与首次出现时间，脱敏输出核心往来资金体量。</p>
                    </div>
                </div>
                <div class="finance-feature-card">
                    <div class="finance-feature-icon">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                    </div>
                    <div class="finance-feature-content">
                        <strong>异动与风险线索审计</strong>
                        <p>内嵌大额、整数、短时快进快出及深夜频次审计规则，精准锁定线索证据行。</p>
                    </div>
                </div>
            </div>

            <div class="finance-runs-card">
                <div class="finance-runs-card-header">
                    <div class="finance-runs-card-title">
                        <strong>历史分析记录</strong>
                        <span class="finance-runs-badge" id="finance-runs-count">0 项记录</span>
                    </div>
                    <div class="finance-runs-card-hint">
                        数据生命周期到期前可随时导出 Word、PDF 及结构化思维导图
                    </div>
                </div>
                <div class="table-container">
                    <table class="data-table compact-table finance-runs-table">
                        <thead>
                            <tr>
                                <th class="finance-col-id">分析编号</th>
                                <th class="finance-col-status">任务状态</th>
                                <th class="finance-col-time">创建时间</th>
                                <th>执行备注 / 错误信息</th>
                                <th class="finance-col-actions">操作</th>
                            </tr>
                        </thead>
                        <tbody id="finance-runs"></tbody>
                    </table>
                </div>
            </div>
        `);
        root.querySelector('.data-analysis-main').appendChild(panel);

        root.addEventListener('click', event => {
            const target = event.target.closest('[data-finance]');
            if (target) {
                target.disabled = true;
                void action(target).catch(error => {
                    if ($('finance-dialog-status')) $('finance-dialog-status').textContent = error.message;
                    app.toast(error.message, 'error');
                }).finally(() => {
                    if (target.isConnected) target.disabled = false;
                });
            }
        });

        const updateDatasetTitle = () => {
            const selectEl = $('finance-dataset');
            if (!selectEl) return;
            const text = selectEl.options[selectEl.selectedIndex]?.text || '';
            selectEl.title = text ? `当前分析数据集：${text}` : '请选择数据集';
        };

        $('finance-dataset').addEventListener('change', () => {
            updateDatasetTitle();
            close();
            void refresh().catch(app.toast);
        });
    }

    const ensureView = app.ensureView;
    app.ensureView = function (...args) {
        const result = ensureView(...args);
        mount();
        return result;
    };

    const onTab = app.onDataAnalysisTabActivated;
    app.onDataAnalysisTabActivated = function (tab) {
        onTab?.(tab);
        if (tab !== 'transactions') {
            close();
            return;
        }
        mount();
        const datasets = app.state.datasets || [];
        if (datasets.length === 0) {
            html($('finance-dataset'), '<option value="">暂无可用数据集</option>');
        } else {
            html($('finance-dataset'), datasets.map(dataset => `<option value="${esc(dataset.id)}">${esc(dataset.name)}</option>`).join(''));
        }
        $('finance-dataset').value = datasetId || app.state.activeId || datasets[0]?.id || '';
        const selectEl = $('finance-dataset');
        if (selectEl) {
            const text = selectEl.options[selectEl.selectedIndex]?.text || '';
            selectEl.title = text ? `当前分析数据集：${text}` : '请选择数据集';
        }
        void refresh().catch(app.toast);
    };

    const resetAi = app.resetAiWorkspace;
    app.resetAiWorkspace = (...args) => {
        close();
        return resetAi?.(...args);
    };

    app.transactionReset = close;
})();
