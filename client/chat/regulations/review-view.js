(function () {
    const esc = value => PivotSafeHtml.escapeHtml(String(value ?? ''));
    const labels = { working: '审查中', completed: '初审已结束', failed: '审查未完成', cancelled: '已停止', expired: '执行期限已到', withdrawn: '已撤回' };
    const conclusions = { meets: '符合', violates: '不符合', needs_review: '待核实', not_applicable: '不适用' };
    function shell() {
        return `<section class="workspace-modal policy-review-modal" role="dialog" aria-modal="true" aria-labelledby="policy-review-title">
            <header class="workspace-modal-header"><h3 id="policy-review-title">制度材料审查</h3><button type="button" class="workspace-modal-close" data-review-action="close" aria-label="关闭材料审查">关闭</button></header>
            <div class="workspace-modal-body"><p id="policy-review-message" role="status" aria-live="polite"></p>
                <details id="policy-review-composer" open><summary>创建审查</summary><form id="policy-review-form">
                    <div class="policy-review-fields"><label>报告标题<input id="policy-review-report-title" class="form-input" maxlength="100" value="制度材料审查报告" required></label>
                    <label>业务日期<input id="policy-review-date" class="form-input" type="date" required></label>
                    <label>执行模型<select id="policy-review-model" class="form-input" required disabled><option value="">正在加载模型</option></select></label></div>
                    <label>适用范围与审查重点<textarea id="policy-review-scope" class="form-input" rows="2" maxlength="1500" placeholder="例如适用部门、材料用途、重点核对的条件"></textarea></label>
                    <div class="policy-review-actions"><input id="policy-review-policy-query" class="form-input" aria-label="查找制度" placeholder="按制度名称查找"><button class="btn-secondary" type="button" data-review-action="search">查找制度</button></div>
                    <p>选择一至三份制度。系统按业务日期读取已复核的有效版本，版本冲突或尚未复核时会停止并说明原因。</p>
                    <div class="table-container workspace-table-wrap"><table class="data-table compact-table"><thead><tr><th>选择</th><th>制度文档</th><th>适用范围</th></tr></thead><tbody id="policy-review-policies"></tbody></table></div>
                    <div id="policy-review-policy-pagination" class="workspace-pagination"></div><p id="policy-review-selected"></p>
                    <label>待审材料名称<input id="policy-review-material-title" class="form-input" maxlength="160" value="待审材料"></label>
                    <label>待审材料全文<textarea id="policy-review-material-text" class="form-input" rows="6" maxlength="60000" placeholder="粘贴待审材料，或上传下方文件；有文字的材料均会纳入本次审查。"></textarea></label>
                    <label>上传待审材料<input id="policy-review-upload" class="form-input" type="file" multiple accept=".txt,.md,.docx,.pdf"></label>
                    <ul id="policy-review-materials"></ul><p>文字与上传材料合计最多四份；制度与材料合计最多六万字符、制度最多一百六十个条目。仅审查提取的文字，Word中的图片与嵌入附件不在本次范围；扫描或缺页材料请先完成文字识别复核。实际执行消耗所选模型用量，未完成批次可继续处理。</p>
                    <button id="policy-review-start" class="btn-primary" type="submit">开始审查</button>
                </form></details>
                <section aria-label="我的审查任务"><div class="policy-review-actions"><h4>我的审查任务</h4><button type="button" class="btn-secondary" data-review-action="refresh">刷新</button></div>
                    <div class="table-container workspace-table-wrap"><table class="data-table compact-table"><thead><tr><th>序号</th><th>报告</th><th>状态</th><th>进度</th><th>操作</th></tr></thead><tbody id="policy-review-tasks"></tbody></table></div><div id="policy-review-task-pagination" class="workspace-pagination"></div></section>
                <section id="policy-review-detail" aria-label="审查报告"></section>
            </div></section>`;
    }
    function policyRows(rows, selected) {
        return rows.length ? rows.map(row => `<tr><td><input type="checkbox" data-review-document="${Number(row.id)}" aria-label="选择${esc(row.title)}"${selected.has(Number(row.id)) ? ' checked' : ''}></td><td>${esc(row.title)}</td><td>${esc(row.jurisdiction || '未登记')}</td></tr>`).join('') : '<tr><td colspan="3">没有找到制度，请调整名称或在法规查询中导入并复核。</td></tr>';
    }
    function taskRows(rows, page) {
        return rows.length ? rows.map((row, index) => `<tr><td>${(page - 1) * 10 + index + 1}</td><td>${esc(row.title)}</td><td>${esc(labels[row.status] || row.status)}</td><td>${Number(row.processed)}/${Number(row.total)}</td><td>${row.status === 'withdrawn' ? '已撤回' : `<button type="button" class="btn-secondary btn-xs" data-review-open="${esc(row.id)}">查看</button>`}</td></tr>`).join('') : '<tr><td colspan="5">暂无审查任务</td></tr>';
    }
    function findingMarkup(finding, clause, index, editable) {
        const disabled = editable ? '' : ' disabled';
        return `<details class="policy-review-finding" data-review-finding="${esc(finding.id)}"${index === 0 ? ' open' : ''}><summary>${index + 1} ${esc(clause.label)} · ${esc(conclusions[finding.status])}</summary>
            <p>制度原文：${esc(finding.ruleEvidence?.quote || clause.text)}</p>
            ${finding.ruleEvidence?.quote && finding.ruleEvidence.quote !== clause.text ? `<details><summary>查看完整制度条目</summary><p>${esc(clause.text)}</p></details>` : ''}
            ${finding.materialEvidence.map(item => `<p>材料原文 ${esc(item.title)} 字符${item.charStart + 1}至${item.charEnd}：${esc(item.quote)}</p>`).join('') || '<p>尚无可核对的相关材料片段。</p>'}
            <p>${esc(finding.evidenceNote)}</p><label>初审建议<select class="form-input" data-review-field="status"${disabled}>${Object.entries(conclusions).map(([key, label]) => `<option value="${key}"${key === finding.status ? ' selected' : ''}>${label}</option>`).join('')}</select></label>
            <label>审查说明<textarea class="form-input" rows="3" maxlength="3000" data-review-field="analysis"${disabled}>${esc(finding.analysis)}</textarea></label>
            <label>处理建议<textarea class="form-input" rows="2" maxlength="2000" data-review-field="recommendation"${disabled}>${esc(finding.recommendation)}</textarea></label>
            <small>${finding.origin === 'human' ? '说明已由用户修订' : finding.origin === 'unreviewed' ? '本条尚未完成审查' : 'AI初审建议，需业务复核'}</small></details>`;
    }
    function detail(task) {
        const editable = task.status !== 'working';
        return `<h4>${esc(task.title)}</h4><p>${esc(labels[task.status])} · 业务日期${esc(task.asOf)} · ${task.processed}/${task.total}条 · 报告版本${task.version}</p>
            <p>原文片段已核对不代表结论经过独立语义或人工核验。请核对适用条件、例外与待核实项后使用。</p>
            ${task.documents.map(item => `<p>${esc(item.title)} ${esc(item.versionLabel)} · 适用范围${esc(item.jurisdiction || '未登记')}</p>`).join('')}
            ${task.error ? `<p class="error-detail">${esc(task.error)}</p>` : ''}
            <div class="policy-review-actions">${editable ? '<button type="button" class="btn-primary" data-review-action="save">保存修订</button><button type="button" class="btn-secondary" data-review-action="export">导出可编辑Word</button>' : '<button type="button" class="btn-danger" data-review-action="cancel">停止审查</button>'}
            ${task.canResume ? '<button type="button" class="btn-secondary" data-review-action="resume">续跑未完成批次</button>' : ''}<button type="button" class="btn-danger" data-review-action="withdraw">撤回报告</button></div>
            <p id="policy-review-save-status" role="status">${editable ? '已加载保存版本，修改后请先保存再导出。' : '正在逐条审查，刷新或重新进入可恢复持久进度。'}</p>
            <p>已记录模型调用${Number(task.modelCalls)}次，用量${Number(task.usage?.totalTokens || 0)}；${Number(task.modelCalls) - Number(task.usage?.knownCalls || 0)}次调用尚无完整用量回执。</p>
            ${task.findings.map((item, index) => findingMarkup(item, task.clauses[index], index, editable)).join('')}
            <label>人工复核备注<textarea id="policy-review-notes" class="form-input" rows="3" maxlength="6000"${editable ? '' : ' disabled'}>${esc(task.notes)}</textarea></label>`;
    }
    window.Pivot.exposeModule('apps.policyReview.view', { shell, policyRows, taskRows, detail, esc });
})();
