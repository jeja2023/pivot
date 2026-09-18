/* DAG 报表向导辅助：从授权文件读取工作表和字段候选。 */
/* global dagEscapeAttr, dagEscapeHtml, toolShortName, toolValue, PivotSafeHtml */

function createDagWizardReportAssist() {
    const reportToolPrefix = tool => String(toolValue(tool) || '').match(/^(mcp\.[^.]+\.)/i)?.[1] || '';
    const reportSummaryTool = (tool, wizardTools = []) => {
        const candidates = (Array.isArray(wizardTools) ? wizardTools : []).filter(item => toolShortName(item) === 'reports.read_file_summary');
        const prefix = reportToolPrefix(tool);
        return candidates.find(item => !prefix || String(toolValue(item) || '').startsWith(prefix)) || candidates[0] || null;
    };
    const sheetValue = control => {
        const select = control.querySelector('[data-pivot-dag-report-sheet-select]');
        if (select?.value === '__manual__') return String(control.querySelector('[data-pivot-dag-report-sheet-manual]')?.value || '').trim() || undefined;
        return String(select?.value || '').trim() || undefined;
    };
    const syncSheetMode = control => {
        const select = control.querySelector('[data-pivot-dag-report-sheet-select]');
        const manual = control.querySelector('[data-pivot-dag-report-sheet-manual]');
        manual?.classList.toggle('is-visible', select?.value === '__manual__');
    };
    const setManualSheet = (control, value = '') => {
        const select = control.querySelector('[data-pivot-dag-report-sheet-select]');
        const manual = control.querySelector('[data-pivot-dag-report-sheet-manual]');
        if (select) select.value = '__manual__';
        if (manual) manual.value = String(value || '');
        syncSheetMode(control);
    };
    const hydrateSheet = (control, value) => {
        const select = control.querySelector('[data-pivot-dag-report-sheet-select]');
        if (!select) return;
        const nextValue = String(value || '').trim();
        const known = [...select.options].some(option => option.value === nextValue);
        select.value = known ? nextValue : (nextValue ? '__manual__' : '');
        const manual = control.querySelector('[data-pivot-dag-report-sheet-manual]');
        if (manual) manual.value = known ? '' : nextValue;
        syncSheetMode(control);
    };
    const bindReportSheetPicker = ({ control, fieldsByName, properties, tool, wizardTools, callTool, getFieldValue, setActiveField, showToast }) => {
        const select = control.querySelector('[data-pivot-dag-report-sheet-select]');
        const manual = control.querySelector('[data-pivot-dag-report-sheet-manual]');
        const loadButton = control.querySelector('[data-pivot-dag-report-sheet-load]');
        const status = control.querySelector('[data-pivot-dag-report-sheet-status]');
        select?.addEventListener('change', () => {
            setActiveField(control);
            syncSheetMode(control);
            if (select.value === '__manual__') manual?.focus?.({ preventScroll: true });
        });
        manual?.addEventListener('input', () => setActiveField(control));
        loadButton?.addEventListener('click', async () => {
            const compareFiles = toolShortName(tool) === 'reports.compare_files';
            const pathFields = compareFiles
                ? [['leftPath', 'left_path'], ['rightPath', 'right_path']].map(names => names.find(name => fieldsByName.has(name))).filter(Boolean)
                : [(['path', 'leftPath', 'left_path'].find(name => fieldsByName.has(name)) || 'path')];
            const paths = pathFields.map(field => {
                const pathControl = fieldsByName.get(field);
                return pathControl ? getFieldValue(pathControl, properties[field] || {}, field) : undefined;
            });
            if (paths.length !== (compareFiles ? 2 : 1) || paths.some(path => !path || typeof path !== 'string' || /^\s*\{\{/.test(path))) {
                showToast?.(compareFiles ? '请先选择两份具体的授权报表文件，再读取共同工作表。' : '请先选择一份具体的授权报表文件，再读取工作表和字段。', 'warning');
                return;
            }
            const summaryTool = reportSummaryTool(tool, wizardTools);
            if (!summaryTool) {
                showToast?.('当前报表连接没有“读取报表摘要”权限。', 'warning');
                return;
            }
            const originalText = loadButton.textContent;
            loadButton.disabled = true;
            loadButton.textContent = '正在读取…';
            if (status) status.textContent = compareFiles ? '正在读取两份文件的共同工作表…' : '正在读取工作表和字段…';
            try {
                const results = await Promise.all(paths.map(path => callTool(summaryTool, { path, sampleRows: 1 })));
                const sheetLists = results.map(result => [...new Set((Array.isArray(result?.sheets) ? result.sheets : []).map(item => String(item || '').trim()).filter(Boolean))]);
                const sheets = compareFiles
                    ? sheetLists[0].filter(sheet => sheetLists[1].includes(sheet))
                    : sheetLists[0];
                const columns = [...new Set((Array.isArray(results[0]?.columns) ? results[0].columns : []).map(item => String(item || '').trim()).filter(Boolean))];
                const current = sheetValue(control);
                const known = sheets.includes(current);
                PivotSafeHtml.setHtml(select, [
                    '<option value="">使用文件默认工作表</option>',
                    ...sheets.map(sheet => `<option value="${dagEscapeAttr(sheet)}">${dagEscapeHtml(sheet)}</option>`),
                    '<option value="__manual__">手动填写工作表名称</option>'
                ].join(''));
                if (known) {
                    select.value = current;
                    if (manual) manual.value = '';
                    syncSheetMode(control);
                } else if (current) setManualSheet(control, current);
                else syncSheetMode(control);
                const columnsControl = fieldsByName.get('columns');
                const list = columnsControl?.querySelector('[data-pivot-dag-report-columns-list]');
                if (list) PivotSafeHtml.setHtml(list, columns.map(column => `<option value="${dagEscapeAttr(column)}">${dagEscapeHtml(column)}</option>`).join(''));
                const columnHint = columnsControl?.querySelector('[data-pivot-dag-report-columns-hint]');
                if (columnHint) columnHint.textContent = columns.length ? `已读取 ${columns.length} 个字段，可直接添加。` : '没有读取到字段，可手动输入。';
                const filtersControl = fieldsByName.get('filters');
                const filterList = filtersControl?.querySelector('[data-pivot-dag-report-filter-fields-list]');
                if (filterList) PivotSafeHtml.setHtml(filterList, columns.map(column => `<option value="${dagEscapeAttr(column)}">${dagEscapeHtml(column)}</option>`).join(''));
                const filterHint = filtersControl?.querySelector('[data-pivot-dag-report-filter-fields-hint]');
                if (filterHint) filterHint.textContent = columns.length ? `已读取 ${columns.length} 个字段，可按字段添加筛选条件。` : '没有读取到字段，可手动输入筛选字段。';
                if (status) status.textContent = compareFiles
                    ? (sheets.length ? `已读取 ${sheets.length} 个共同工作表。` : '两份文件没有同名工作表；留空时各自使用默认工作表。')
                    : `已读取 ${sheets.length} 个工作表、${columns.length} 个字段。`;
            } catch (error) {
                if (status) status.textContent = error.message || '读取工作表和字段失败。';
                showToast?.(error.message || '读取工作表和字段失败。', 'error');
            } finally {
                loadButton.disabled = false;
                loadButton.textContent = originalText;
            }
        });
        syncSheetMode(control);
    };
    return { bindReportSheetPicker, hydrateSheet, setManualSheet, sheetValue };
}
