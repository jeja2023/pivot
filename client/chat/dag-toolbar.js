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
            button.setAttribute('role', 'menuitem');
            button.addEventListener('click', () => { dropdown.open = false; });
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
            const presetButtons = (registry?.groups || []).flatMap(group => group.items.filter(preset => !preset.advanced).map(preset => {
                const availability = registry.availability(preset, tools);
                return makeButton(
                    preset.title,
                    availability.available ? preset.desc : availability.reason,
                    () => ctx.addPresetNode(preset),
                    { icon: '+', tone: preset.theme || '', disabled: !availability.available }
                );
            }));
            const advancedPresetButtons = (registry?.groups || []).flatMap(group => group.items.filter(preset => preset.advanced).map(preset => {
                const availability = registry.availability(preset, tools);
                return makeButton(
                    preset.title,
                    availability.available ? `${preset.desc}（高级节点）` : availability.reason,
                    () => ctx.addPresetNode(preset),
                    { icon: '+', tone: preset.theme || '', disabled: !availability.available }
                );
            }));
            ctx.toolbar.appendChild(makeToolbarGroup([
                makeToolbarDropdown('添加节点', [
                    makeButton('自定义节点', '从空白节点开始，自选工具、输入和依赖', ctx.addNode, { icon: '+' }),
                    ...presetButtons
                ])
            ], 'is-node-group'));
            if (advancedPresetButtons.length) {
                ctx.toolbar.appendChild(makeToolbarDropdown('高级节点', advancedPresetButtons, 'is-advanced-node-group'));
            }
            ctx.toolbar.appendChild(makeToolbarDropdown('模板', [
                makeButton('多智能体审阅', '添加并行研究员、审阅员与主管智能体裁决节点', ctx.addAgentTeamTemplate),
                makeButton('统计图模板', '从数据库表和字段快速生成可编辑的统计图工作流', ctx.openStatsChartWizard)
            ], 'is-template-group'));
            ctx.toolbar.appendChild(makeToolbarDropdown('操作', [
                makeButton('撤销', '撤销上一步画布修改', ctx.undo, { icon: '↶' }),
                makeButton('重做', '恢复刚撤销的画布修改', ctx.redo, { icon: '↷' }),
                makeButton('复制节点', '复制当前选中的节点', ctx.copySelection),
                makeButton('粘贴节点', '粘贴已复制的节点', ctx.pasteSelection),
                makeButton('创建副本', '复制并立即粘贴当前节点', ctx.duplicateSelection),
                makeButton('校验', '校验节点、依赖和工具可用性', ctx.showValidationResult),
                makeButton('自动布局', '按依赖层次重新排列', ctx.resetLayout),
                makeButton('适配画布', '重置缩放和平移到默认视角', ctx.fitToContent),
                makeButton('高级配置', '打开高级配置编辑窗口', () => {
                    if (typeof ctx.onOpenJson === 'function') ctx.onOpenJson();
                })
            ], 'is-action-group'));
            ctx.toolbar.appendChild(makeToolbarDropdown('发布', [
                makeButton('发布当前版本', '保存并发布当前工作流版本', () => window.publishSelectedAgentWorkflow?.('current'))
            ], 'is-publish-group'));
            ctx.toolbar.appendChild(makeToolbarDropdown('运行', [
                makeButton('预览运行', '使用当前画布快照运行一次', () => window.runAgentWorkflowPreview?.(), { runSource: 'draft' }),
                makeButton('运行发布版', '使用最近发布的稳定版本运行', () => window.runAgentWorkflowPublished?.(), { runSource: 'published' })
            ], 'is-run-group'));
            const toolbarStatus = document.createElement('div');
            toolbarStatus.className = 'pivot-dag-toolbar-status';
            ctx.toolbar.appendChild(toolbarStatus);
        return toolbarStatus;
    }

