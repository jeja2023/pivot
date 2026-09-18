/* DAG 空画布引导：将首次编排转换为可直接操作的起步路径。 */
/* global createDagIcon */

function createDagEmptyCanvasHint({ createIcon, onAddPreset, onOpenStatsTemplate } = {}) {
    const hint = document.createElement('section');
    hint.className = 'pivot-dag-empty-hint';
    hint.setAttribute('aria-label', '工作流起步方式');
    const icon = document.createElement('span');
    icon.className = 'pivot-dag-empty-hint-icon';
    icon.setAttribute('aria-hidden', 'true');
    if (typeof createIcon === 'function') {
        const iconNode = createIcon('puzzle');
        if (iconNode) icon.appendChild(iconNode);
    } else if (typeof createDagIcon === 'function') {
        icon.appendChild(createDagIcon('puzzle'));
    }
    const title = document.createElement('strong');
    title.textContent = '选择一种开始方式';
    const description = document.createElement('small');
    description.textContent = '先添加业务节点；需要时再连接下游节点和补充高级配置。';
    const actions = document.createElement('div');
    actions.className = 'pivot-dag-empty-hint-actions';
    [
        { key: 'llm', label: '从任务开始', detail: '添加大模型节点', primary: true },
        { key: 'data', label: '查询数据', detail: '添加数据查询节点' },
        { key: 'stats', label: '统计图模板', detail: '按向导生成流程' }
    ].forEach(item => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = item.primary ? 'btn-primary' : 'btn-secondary';
        button.dataset.pivotDagEmptyAction = item.key;
        button.title = item.detail;
        button.textContent = item.label;
        button.addEventListener('click', () => {
            if (item.key === 'stats') onOpenStatsTemplate?.();
            else onAddPreset?.(item.key);
        });
        actions.appendChild(button);
    });
    hint.append(icon, title, description, actions);
    return hint;
}
