/* Agent DAG 工具栏、工具元数据与输入结构辅助函数（拆自 agents-dag-editor.js） */



function renderToolSchemaHint(tool) {
        const schema = getToolSchema(tool);
        const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
        const required = new Set(Array.isArray(schema.required) ? schema.required : []);
        const rows = Object.entries(props).slice(0, 8).map(([name, item]) => {
            const type = friendlySchemaTypeLabel(item);
            const mark = required.has(name) ? '必填' : '可选';
            const description = friendlyFieldDescription(name, item, tool);
            return `
                <div class="pivot-dag-schema-row">
                    <div class="pivot-dag-schema-row-head">
                        <strong>${dagEscapeHtml(friendlyFieldLabel(name, item, tool))}</strong>
                        <em>${dagEscapeHtml(type)} · ${mark}</em>
                        <code>${dagEscapeHtml(name)}</code>
                    </div>
                    ${description ? `<small>${dagEscapeHtml(description)}</small>` : ''}
                </div>
            `;
        });
        if (!rows.length) return '<div class="pivot-dag-schema-hint is-empty">当前工具不需要输入参数</div>';
        return `<div class="pivot-dag-schema-hint">${rows.join('')}</div>`;
    }

function makeButton(label, title, onClick, options = {}) {
        const btn = document.createElement('button');
        btn.type = 'button';
        const baseClass = options.variant === 'primary' ? 'btn-primary' : 'btn-secondary';
        btn.className = `${baseClass} pivot-dag-toolbar-btn${options.tone ? ` is-${options.tone}` : ''}`;
        if (options.icon) {
            const icon = document.createElement('span');
            icon.className = 'pivot-dag-toolbar-btn-icon';
            icon.setAttribute('aria-hidden', 'true');
            icon.textContent = options.icon;
            const text = document.createElement('span');
            text.className = 'pivot-dag-toolbar-btn-text';
            text.textContent = label;
            btn.appendChild(icon);
            btn.appendChild(text);
        } else {
            btn.textContent = label;
        }
        if (title) btn.title = title;
        if (options.disabled) {
            btn.disabled = true;
            btn.setAttribute('aria-disabled', 'true');
        }
        if (options.runSource) btn.classList.add(`agent-workflow-run-${options.runSource}`);
        if (typeof onClick === 'function') btn.addEventListener('click', onClick);
        return btn;
    }

function makeToolbarDropdown(label, buttons, className = '') {
        const dropdown = document.createElement('details');
        dropdown.className = `pivot-dag-toolbar-dropdown${className ? ` ${className}` : ''}`;
        dropdown.setAttribute('aria-label', label);
        const summary = document.createElement('summary');
        summary.className = 'pivot-dag-toolbar-summary';
        summary.textContent = label;
        const menu = document.createElement('div');
        menu.className = 'pivot-dag-toolbar-menu';
        menu.setAttribute('role', 'menu');
        buttons.forEach(button => {
            if (button.tagName === 'BUTTON') {
                button.setAttribute('role', 'menuitem');
                button.addEventListener('click', () => { dropdown.open = false; });
            }
            menu.appendChild(button);
        });
        dropdown.appendChild(summary);
        dropdown.appendChild(menu);
        dropdown.addEventListener('toggle', () => {
            const host = dropdown.parentElement;
            if (!dropdown.open || !host) return;
            host.querySelectorAll('.pivot-dag-toolbar-dropdown[open]').forEach(item => {
                if (item !== dropdown) item.open = false;
            });
        });
        return dropdown;
    }

function makeToolbarGroup(items, className = '') {
        const group = document.createElement('div');
        group.className = `pivot-dag-toolbar-group${className ? ` ${className}` : ''}`;
        items.forEach(item => group.appendChild(item));
        return group;
    }

function renderDagToolbar(ctx) {
        if (!ctx.toolbar) return null;
            ctx.toolbar.replaceChildren();
            if (ctx.readOnly) {
                const readOnlyStatus = document.createElement('div');
                readOnlyStatus.className = 'pivot-dag-toolbar-status is-readonly';
                readOnlyStatus.textContent = '共享工作流 · 只读发布版';
                ctx.toolbar.appendChild(readOnlyStatus);
                return readOnlyStatus;
            }
            const tools = typeof ctx.currentTools === 'function' ? ctx.currentTools() : [];
            const registry = window.Pivot.moduleApi('agent.dagNodePresets');
            const groups = registry?.groups || [];

            // 构造按 6 大分类结构化分块的预设节点列表与「添加节点」下拉菜单
            const presetButtons = groups.flatMap(group => {
                const sectionLabel = document.createElement('div');
                sectionLabel.className = 'pivot-dag-toolbar-section-label';

                const titleSpan = document.createElement('span');
                titleSpan.className = 'pivot-dag-toolbar-section-title';
                titleSpan.textContent = group.group;

                const countBadge = document.createElement('span');
                countBadge.className = 'pivot-dag-toolbar-section-badge';
                countBadge.textContent = String(group.items.length);

                sectionLabel.appendChild(titleSpan);
                sectionLabel.appendChild(countBadge);

                const items = group.items.map(preset => {
                    const availability = registry.availability(preset, tools);
                    const advHint = preset.advanced ? '（高级）' : '';
                    const btn = makeButton(
                        preset.title,
                        availability.available ? `${preset.desc}${advHint}` : availability.reason,
                        () => ctx.addPresetNode(preset),
                        { icon: '+', tone: preset.theme || '', disabled: !availability.available }
                    );
                    if (preset.advanced) {
                        btn.classList.add('is-advanced');
                        const advTag = document.createElement('span');
                        advTag.className = 'pivot-dag-toolbar-adv-badge';
                        advTag.textContent = '高级';
                        btn.appendChild(advTag);
                    }
                    return btn;
                });
                return [sectionLabel, ...items];
            });

            ctx.toolbar.appendChild(makeToolbarGroup([
                makeToolbarDropdown('添加节点', [
                    makeButton('自定义节点', '从空白节点开始，自选工具、输入和依赖', ctx.addNode, { icon: '+' }),
                    ...presetButtons
                ])
            ], 'is-node-group'));
            ctx.toolbar.appendChild(makeToolbarDropdown('模板', [
                makeButton('多智能体审阅', '添加并行研究员、审阅员与主管智能体裁决节点', ctx.addAgentTeamTemplate),
                makeButton('统计图模板', '从数据库表和字段快速生成可编辑的统计图工作流', ctx.openStatsChartWizard)
            ], 'is-template-group'));
            const showTimelineWaterfall = () => {
                const api = window.Pivot?.moduleApi?.('agent.dagTimeline');
                api?.showTimelineWaterfallModal?.({
                    nodes: ctx.spec?.nodes || [],
                    runStates: window.Pivot?.legacy?.dagNodeRunStates || new Map(),
                    onFocusNode: id => ctx.selectNode?.(id, false)
                });
            };

            const lintWorkflow = () => {
                const gov = window.Pivot?.moduleApi?.('agent.dagGovernance');
                const report = gov?.lintDagGraph?.(ctx.spec?.nodes || []);
                if (!report) return;
                if (!report.valid) {
                    const first = report.errors[0];
                    if (first?.nodeId) ctx.selectNode?.(first.nodeId, false);
                    window.Pivot?.legacy?.showToast?.(`体检未通过：${first.message}`, 'error');
                } else if (report.warnings?.length) {
                    window.Pivot?.legacy?.showToast?.(`体检通过（建议：${report.warnings[0].message}）`, 'warning');
                } else {
                    window.Pivot?.legacy?.showToast?.('工作流静态体检满分通过，无死锁与孤立节点', 'success');
                }
            };

            const exportWorkflowSpec = () => {
                const gov = window.Pivot?.moduleApi?.('agent.dagGovernance');
                const data = gov?.exportDagWorkflowSpec?.(ctx.spec);
                if (!data) return;
                const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = `workflow-${Date.now()}.json`;
                a.click();
                URL.revokeObjectURL(a.href);
                window.Pivot?.legacy?.showToast?.('工作流规范已导出', 'success');
            };

            const importWorkflowSpec = () => {
                const inp = document.createElement('input');
                inp.type = 'file';
                inp.accept = '.json,application/json';
                inp.onchange = async e => {
                    const f = e.target.files?.[0];
                    if (!f) return;
                    const text = await f.text();
                    const res = window.Pivot?.moduleApi?.('agent.dagGovernance')?.importDagWorkflowSpec?.(text);
                    if (!res?.ok) {
                        window.Pivot?.legacy?.showToast?.(res?.error || '导入失败', 'error');
                        return;
                    }
                    ctx.recordHistory?.();
                    if (ctx.spec && ctx.ensureDefaults) {
                        const parsed = ctx.ensureDefaults(res.spec);
                        ctx.spec.nodes = parsed.nodes;
                        ctx.spec.cacheEnabled = parsed.cacheEnabled;
                    }
                    ctx.render?.();
                    ctx.flushOut?.();
                    window.Pivot?.legacy?.showToast?.(`已导入 ${res.spec.nodes.length} 个节点`, 'success');
                };
                inp.click();
            };

            ctx.toolbar.appendChild(makeToolbarDropdown('操作', [
                makeButton('撤销', '撤销上一步画布修改', ctx.undo, { icon: '↶' }),
                makeButton('重做', '恢复刚撤销的画布修改', ctx.redo, { icon: '↷' }),
                makeButton('复制节点', '复制当前选中的节点 (Ctrl+C)', ctx.copySelection),
                makeButton('粘贴节点', '粘贴已复制的节点 (Ctrl+V)', ctx.pasteSelection),
                makeButton('创建副本', '复制并立即粘贴当前节点 (Ctrl+D)', ctx.duplicateSelection),
                makeButton('水平居中对齐', '将选中的多个节点水平中心对齐', () => ctx.alignSelection?.('horizontal_center')),
                makeButton('垂直居中对齐', '将选中的多个节点垂直中心对齐', () => ctx.alignSelection?.('vertical_center')),
                makeButton('水平等间距分布', '将选中的多个节点水平间距等分排列', () => ctx.alignSelection?.('distribute_h')),
                makeButton('垂直等间距分布', '将选中的多个节点垂直间距等分排列', () => ctx.alignSelection?.('distribute_v')),
                makeButton('静态体检', '静态自检拓扑死锁、孤立节点与变量依赖', lintWorkflow, { icon: '✓' }),
                makeButton('导出规范', '导出为标准 .workflow.json 资产文件', exportWorkflowSpec, { icon: '↓' }),
                makeButton('导入规范', '从外部标准 JSON 文件载入工作流', importWorkflowSpec, { icon: '↑' }),
                makeButton('自动布局', '按依赖层次重新排列，并自动适配全部节点', ctx.resetLayout),
                makeButton('适配画布', '显示全部节点并居中', ctx.fitToContent),
                makeButton('初始视图', '默认缩放并将现有节点居中', ctx.resetView),
                makeButton('高级配置', '打开高级配置编辑窗口', () => {
                    if (typeof ctx.onOpenJson === 'function') ctx.onOpenJson();
                })
            ], 'is-action-group'));
            ctx.toolbar.appendChild(makeToolbarDropdown('发布', [
                makeButton('发布当前版本', '保存并发布当前工作流版本', () => window.Pivot.legacy.publishSelectedAgentWorkflow?.('current')),
                ...(typeof isSuperAdminUser === 'function' && isSuperAdminUser()
                    ? [makeButton('紧急跳过门禁发布', '仅系统管理员可用，必须填写紧急原因', () => window.Pivot.legacy.publishSelectedAgentWorkflow?.('current', { skipEvaluationGate: true }))]
                    : [])
            ], 'is-publish-group'));
            ctx.toolbar.appendChild(makeToolbarDropdown('运行', [
                makeButton('预览运行', '使用当前画布快照运行一次', () => window.Pivot.legacy.runAgentWorkflowPreview?.(), { runSource: 'draft' }),
                makeButton('运行发布版', '使用最近发布的稳定版本运行', () => window.Pivot.legacy.runAgentWorkflowPublished?.(), { runSource: 'published' }),
                makeButton('耗时瀑布图', '查看各节点的执行耗时分析与甘特图', showTimelineWaterfall)
            ], 'is-run-group'));
            const toolbarStatus = document.createElement('div');
            toolbarStatus.className = 'pivot-dag-toolbar-status';
            ctx.toolbar.appendChild(toolbarStatus);
        return toolbarStatus;
    }

