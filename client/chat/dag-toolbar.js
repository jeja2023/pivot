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
        btn.addEventListener('click', onClick);
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
            const addLlmNode = () => ctx.addPresetNode({
                    base: 'llm',
                    title: '大模型处理',
                    patterns: ['agent.llm'],
                    input: ({ selectedNode }) => defaultLlmInput(selectedNode)
                });
            ctx.toolbar.appendChild(makeToolbarGroup([
                makeToolbarDropdown('添加节点', [
                    makeButton('大模型', '添加大模型处理节点', addLlmNode, { icon: '+', tone: 'llm' }),
                    makeButton('自定义节点', '从空白节点开始，自选工具、输入和依赖', ctx.addNode, { icon: '+' }),
                    makeButton('委派智能体', '调用一次独立模型，返回专家结果并自动生成交接信息；通常无需另加交接节点', () => ctx.addPresetNode({
                    base: 'delegate',
                    title: '委派智能体',
                    patterns: ['agent.delegate'],
                    input: { agentName: '领域专家', role: 'analyst', model: defaultWorkflowModelId(), task: '{{goal}}', context: '{{goal}}', responseFormat: 'markdown', temperature: 0.2, maxTokens: 1200 },
                    outputSchema: { type: 'object', required: ['content', 'agent', 'handoff'], properties: { content: { type: 'string' }, agent: { type: 'object' }, handoff: { type: 'object' } } }
                }), { icon: '+' }),
                    makeButton('智能体交接', '仅整理已有结果，不调用模型；需要统一交接格式或汇总多来源时使用', () => ctx.addPresetNode({
                    base: 'handoff',
                    title: '智能体交接',
                    patterns: ['agent.handoff'],
                    input: { fromAgent: '上游智能体', toAgent: 'Supervisor', summary: '', findings: [], evidence: [], risks: [], openQuestions: [], confidence: 0.7 },
                    outputSchema: { type: 'object', required: ['fromAgent', 'toAgent', 'summary', 'status'], properties: { fromAgent: { type: 'string' }, toAgent: { type: 'string' }, summary: { type: 'string' }, status: { type: 'string' } } }
                }), { icon: '+' }),
                    makeButton('代码执行', '添加 JS 代码执行节点，对上游数据做转换/计算', () => ctx.addPresetNode({
                    base: 'code',
                    title: '代码执行',
                    patterns: ['agent.code'],
                    input: { code: '// 可通过 vars 接收上游数据\n// 用 return 返回结果\nreturn vars.input;', vars: {} },
                    outputSchema: { type: 'object', properties: { output: {}, text: { type: 'string' } } }
                }), { icon: '+', tone: 'code' }),
                    makeButton('HTTP 请求', '调用外部 REST API，支持 GET/POST 等', () => ctx.addPresetNode({
                    base: 'http',
                    title: 'HTTP 请求',
                    patterns: ['agent.http'],
                    input: { url: '', method: 'GET', headers: {}, body: null },
                    outputSchema: { type: 'object', properties: { statusCode: { type: 'integer' }, ok: { type: 'boolean' }, data: {}, text: { type: 'string' } } }
                }), { icon: '+', tone: 'http' }),
                    makeButton('变量聚合', '把多个上游输出合并为一个对象', () => ctx.addPresetNode({
                    base: 'merge',
                    title: '变量聚合',
                    patterns: ['agent.merge'],
                    input: { fields: {} },
                    outputSchema: { type: 'object', properties: { merged: { type: 'object' }, keys: { type: 'array' } } }
                }), { icon: '+', tone: 'merge' }),
                    makeButton('检索', '添加知识检索节点', () => ctx.addPresetNode({
                    base: 'search',
                    title: '知识检索',
                    patterns: ['rag.search', 'knowledge', 'search'],
                    input: { query: '' }
                }), { icon: '+' }),
                    makeButton('数据', '添加可视化数据库查询节点，也可切换到高级 SQL', () => ctx.addPresetNode({
                    base: 'data',
                    title: '数据查询',
                    patterns: ['db.run_readonly_query', 'db.list_tables', 'database'],
                    input: {}
                }), { icon: '+' }),
                    makeButton('图表', '添加图表生成节点', () => ctx.addPresetNode({
                    base: 'chart',
                    title: '图表生成',
                    patterns: ['viz.build_chart', 'chart'],
                    input: {}
                }), { icon: '+' }),
                    makeButton('报告', '添加报告编排节点', () => ctx.addPresetNode({
                    base: 'report',
                    title: '报告编排',
                    patterns: ['report.compose', 'report'],
                    input: {}
                }), { icon: '+' })
                ])
            ], 'is-node-group'));
            ctx.toolbar.appendChild(makeToolbarDropdown('模板', [
                makeButton('多智能体审阅', '添加并行研究员、审阅员与 Supervisor 裁决节点', ctx.addAgentTeamTemplate),
                makeButton('统计图模板', '从数据库表和字段快速生成可编辑的统计图工作流', ctx.openStatsChartWizard)
            ], 'is-template-group'));
            ctx.toolbar.appendChild(makeToolbarDropdown('操作', [
                makeButton('校验', '校验节点、依赖和工具可用性', ctx.showValidationResult),
                makeButton('自动布局', '按依赖层次重新排列', ctx.resetLayout),
                makeButton('适配画布', '重置缩放和平移到默认视角', ctx.fitToContent),
                makeButton('JSON 视图', '打开高级 JSON 编辑弹窗', () => {
                    if (typeof ctx.onOpenJson === 'function') ctx.onOpenJson();
                })
            ], 'is-action-group'));
            ctx.toolbar.appendChild(makeToolbarDropdown('发布', [
                makeButton('发布当前版本', '保存并发布当前工作流版本', () => window.publishSelectedAgentWorkflow?.('current'))
            ], 'is-publish-group'));
            ctx.toolbar.appendChild(makeToolbarDropdown('运行', [
                makeButton('预览运行', '使用当前画布快照运行一次', () => window.runAgentWorkflowPreview?.()),
                makeButton('运行发布版', '使用最近发布的稳定版本运行', () => window.runAgentWorkflowPublished?.())
            ], 'is-run-group'));
            const toolbarStatus = document.createElement('div');
            toolbarStatus.className = 'pivot-dag-toolbar-status';
            ctx.toolbar.appendChild(toolbarStatus);
        return toolbarStatus;
    }

