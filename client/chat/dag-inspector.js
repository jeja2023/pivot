/* DAG 检查器与 JSON 输入编辑器（拆自 agents-dag-editor.js） */



function createDagInspectorController(ctx) {
    const inspector = ctx.inspector;
    const onNodeSelectionChange = ctx.onNodeSelectionChange;
    const currentTools = () => typeof ctx.currentTools === 'function' ? (ctx.currentTools() || []) : [];
    const getDependencyCandidateNodes = (...args) => ctx.getDependencyCandidateNodes?.(...args) || [];
    const isForwardDependency = (...args) => Boolean(ctx.isForwardDependency?.(...args));
    const wouldCreateCycle = (...args) => Boolean(ctx.wouldCreateCycle?.(...args));
    const openNodeInputWizard = (...args) => ctx.openNodeInputWizard?.(...args);
    const renderInputSummary = (...args) => ctx.renderInputSummary?.(...args) || '';
    const notifySelectionChange = (node) => {
        if (typeof onNodeSelectionChange !== 'function') return;
        onNodeSelectionChange(node ? {
            id: node.id,
            title: node.title,
            tool: node.tool
        } : null);
    };

    const openNodeJsonEditor = (nodeId) => {
        const node = ctx.spec.nodes.find(n => n.id === nodeId);
        if (!node) return;
        const tool = resolveToolForNode(currentTools(), node.tool);
        let modal = document.getElementById('pivot-dag-json-input-editor');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'pivot-dag-json-input-editor';
            modal.className = 'modal-overlay hidden pivot-dag-json-input-overlay';
            document.body.appendChild(modal);
        }
        const variableTokens = [
            { label: '任务目标', token: '{{goal}}' },
            { label: '运行输入', token: '{{inputs}}' },
            ...(node.dependsOn || []).flatMap(dep => ([
                { label: `${dep} 输出`, token: `{{nodes.${dep}.output}}` },
                { label: `${dep} 结构化结果`, token: `{{nodes.${dep}.output.structuredContent}}` },
                { label: `${dep} 数据行`, token: `{{nodes.${dep}.output.rows}}` },
                { label: `${dep} 状态`, token: `{{nodes.${dep}.status}}` }
            ]))
        ];
        modal.innerHTML = `
            <div class="modal rag-detail-modal pivot-dag-json-input-editor">
                <div class="rag-detail-header pivot-dag-input-head">
                    <div>
                        <h3>编辑 JSON 参数</h3>
                        <p class="model-modal-desc">${dagEscapeHtml([friendlyToolTitle(tool), node.title || node.id].filter(Boolean).join(' · '))}</p>
                    </div>
                    <button type="button" class="btn-danger-outline" data-pivot-dag-json-close="1">关闭</button>
                </div>
                <div class="pivot-dag-json-input-body">
                    <div class="pivot-dag-json-main">
                        <textarea class="form-input" data-pivot-dag-json-input spellcheck="false">${dagEscapeHtml(JSON.stringify(node.input || {}, null, 2))}</textarea>
                        <div class="pivot-dag-json-error" data-pivot-dag-json-error></div>
                    </div>
                    <aside class="pivot-dag-json-side">
                        <div class="pivot-dag-json-side-section">
                            <strong>参数字段</strong>
                            ${renderToolSchemaHint(tool)}
                        </div>
                        <div class="pivot-dag-json-side-section">
                            <strong>插入变量</strong>
                            <div class="pivot-dag-token-list">
                                ${variableTokens.map(item => `<button type="button" class="pivot-dag-token-btn" data-pivot-dag-json-token="${dagEscapeAttr(item.token)}" title="${dagEscapeAttr(item.token)}">${dagEscapeHtml(item.label)}</button>`).join('')}
                            </div>
                        </div>
                    </aside>
                </div>
                <div class="agent-workflow-create-actions pivot-dag-json-actions">
                    <button type="button" class="btn-secondary" data-pivot-dag-json-format="1">格式化</button>
                    <button type="button" class="btn-primary" data-pivot-dag-json-apply="1">应用</button>
                </div>
            </div>
        `;
        const textareaEl = modal.querySelector('[data-pivot-dag-json-input]');
        const errorEl = modal.querySelector('[data-pivot-dag-json-error]');
        const setError = message => {
            if (!errorEl) return;
            errorEl.textContent = message || '';
        };
        const closeJson = () => modal.classList.add('hidden');
        const parseInput = () => {
            try {
                const parsed = JSON.parse(textareaEl.value || '{}');
                if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('JSON 参数必须是对象。');
                setError('');
                textareaEl.classList.remove('is-invalid');
                return parsed;
            } catch (e) {
                textareaEl.classList.add('is-invalid');
                setError(e.message || 'JSON 格式不正确。');
                return null;
            }
        };
        const applyJson = () => {
            const parsed = parseInput();
            if (!parsed) return;
            node.input = parsed;
            ctx.render?.();
            ctx.flushOut?.();
            closeJson();
            window.showToast?.('JSON 参数已更新', 'success');
        };
        const insertToken = token => {
            if (!token || !textareaEl) return;
            const start = textareaEl.selectionStart ?? textareaEl.value.length;
            const end = textareaEl.selectionEnd ?? textareaEl.value.length;
            const before = textareaEl.value.slice(0, start);
            const quoteCount = (before.match(/(?<!\\)"/g) || []).length;
            const insertText = quoteCount % 2 === 1 ? token : JSON.stringify(token);
            textareaEl.value = `${before}${insertText}${textareaEl.value.slice(end)}`;
            textareaEl.selectionStart = start + insertText.length;
            textareaEl.selectionEnd = start + insertText.length;
            textareaEl.focus();
        };
        modal.querySelector('[data-pivot-dag-json-close]')?.addEventListener('click', closeJson);
        modal.querySelector('[data-pivot-dag-json-apply]')?.addEventListener('click', applyJson);
        modal.querySelector('[data-pivot-dag-json-format]')?.addEventListener('click', () => {
            const parsed = parseInput();
            if (parsed) textareaEl.value = JSON.stringify(parsed, null, 2);
        });
        modal.querySelectorAll('[data-pivot-dag-json-token]').forEach(btn => {
            btn.addEventListener('click', () => insertToken(btn.dataset.pivotDagJsonToken || ''));
        });
        modal.addEventListener('click', event => {
            if (event.target === modal) closeJson();
        }, { once: true });
        modal.classList.remove('hidden');
        requestAnimationFrame(() => textareaEl?.focus?.({ preventScroll: true }));
    };

    const renderInspector = () => {
        if (!inspector) return;
        const node = ctx.spec.nodes.find(n => n.id === ctx.selectedId);
        const active = document.activeElement;
        const focusSnapshot = active && inspector.contains(active) ? {
            field: active.dataset?.pivotDagField || '',
            depend: active.dataset?.pivotDagDepend || '',
            start: null,
            end: null
        } : null;
        if (focusSnapshot) {
            try {
                focusSnapshot.start = active.selectionStart;
                focusSnapshot.end = active.selectionEnd;
            } catch (e) {
                // Some input types do not expose text selection.
            }
        }
        if (!node) {
            inspector.innerHTML = '<div class="pivot-dag-inspector-empty">选中节点后可在此编辑标题、工具与输入。</div>';
            notifySelectionChange(null);
            return;
        }
        notifySelectionChange(node);
        const tools = currentTools();
        const selectedTool = resolveToolForNode(tools, node.tool);
        const upstreamNodes = getDependencyCandidateNodes(node);
        const dependsChecks = upstreamNodes.map(upstreamNode => `
            <label class="pivot-dag-depends-item">
                <input type="checkbox" data-pivot-dag-depend="${dagEscapeAttr(upstreamNode.id)}" ${node.dependsOn.includes(upstreamNode.id) ? 'checked' : ''}>
                <span>
                    <strong>${dagEscapeHtml(upstreamNode.title || upstreamNode.id)}</strong>
                    <em>${dagEscapeHtml(upstreamNode.id)}</em>
                </span>
            </label>
        `).join('') || '<span class="pivot-dag-inspector-empty">这是起始节点，没有可选上游节点。</span>';
        const toolOptions = renderToolOptions(tools, node.tool);
        inspector.innerHTML = `
            <div class="pivot-dag-inspector-row pivot-dag-inspector-row-main">
                <label class="pivot-dag-node-id-field">
                    <span>节点 ID</span>
                    <input type="text" data-pivot-dag-node-id-display value="${dagEscapeHtml(node.id)}" readonly aria-readonly="true" title="系统自动生成，用于依赖和变量引用，默认不可修改">
                    <small>系统自动生成，用于依赖和变量引用</small>
                </label>
                <label><span>标题</span><input type="text" data-pivot-dag-field="title" value="${dagEscapeHtml(node.title)}" maxlength="120"></label>
            </div>
            <div class="pivot-dag-inspector-row pivot-dag-inspector-row-tool">
                <label class="pivot-dag-tool-field"><span>工具</span>
                    <select data-pivot-dag-field="tool">${toolOptions}</select>
                </label>
                <label><span>条件</span>
                    <select data-pivot-dag-field="condition">
                        <option value="success" ${node.condition === 'success' ? 'selected' : ''}>上游成功后执行</option>
                        <option value="always" ${node.condition === 'always' ? 'selected' : ''}>始终执行</option>
                    </select>
                </label>
            </div>
            ${renderSelectedToolMeta(selectedTool)}
            <div class="pivot-dag-inspector-row pivot-dag-inspector-row-runtime">
                <label><span>失败策略</span>
                    <select data-pivot-dag-field="onError">
                        <option value="skip_dependents" ${node.onError === 'skip_dependents' ? 'selected' : ''}>失败后跳过下游</option>
                        <option value="continue" ${node.onError === 'continue' ? 'selected' : ''}>失败后继续下游</option>
                        <option value="stop" ${node.onError === 'stop' ? 'selected' : ''}>失败后停止工作流</option>
                    </select>
                </label>
                <label><span>重试次数</span><input type="number" min="0" max="5" data-pivot-dag-field="retryLimit" value="${Number(node.retryLimit || 0)}" placeholder="0" title="失败后自动重试次数，0 表示不重试，最多 5 次"></label>
                <label><span>超时 ms</span><input type="number" min="0" max="600000" step="1000" data-pivot-dag-field="timeoutMs" value="${Number(node.timeoutMs || 0)}" placeholder="默认" title="节点工具调用超时毫秒数，0 表示使用智能体全局超时设置"></label>
            </div>
            <div class="pivot-dag-inspector-depends">
                <div class="pivot-dag-inspector-depends-head">
                    <strong>上游节点</strong>
                    <span>本节点会等待这些前置节点完成，并可引用其输出</span>
                </div>
                <div class="pivot-dag-inspector-depends-list">${dependsChecks}</div>
            </div>
            <div class="pivot-dag-input-overview">
                <div class="pivot-dag-input-overview-head">
                    <div>
                        <strong>参数输入</strong>
                        <span>侧栏只显示摘要，点击按钮进入弹窗编辑。</span>
                    </div>
                </div>
                <div class="pivot-dag-input-overview-summary">${renderInputSummary(node.input, selectedTool, tools)}</div>
                <div class="pivot-dag-input-overview-actions">
                    <button type="button" class="btn-primary" data-pivot-dag-open-wizard="1">配置参数</button>
                    <button type="button" class="btn-secondary" data-pivot-dag-open-json="1">编辑 JSON</button>
                    <button type="button" class="btn-secondary" data-pivot-dag-apply-template="1">套用模板</button>
                </div>
            </div>
        `;
        inspector.querySelector('[data-pivot-dag-open-wizard]')?.addEventListener('click', () => openNodeInputWizard(node.id));
        inspector.querySelector('[data-pivot-dag-open-json]')?.addEventListener('click', () => openNodeJsonEditor(node.id));

        inspector.querySelectorAll('[data-pivot-dag-field]').forEach(input => {
            input.addEventListener('input', (e) => handleInspectorEdit(e.target));
            input.addEventListener('change', (e) => handleInspectorEdit(e.target));
        });
        inspector.querySelectorAll('[data-pivot-dag-depend]').forEach(checkbox => {
            checkbox.addEventListener('change', (e) => handleDependsToggle(e.target));
        });
        inspector.querySelector('[data-pivot-dag-apply-template]')?.addEventListener('click', () => applyToolInputTemplate(node.id));
        if (focusSnapshot?.field) {
            const next = inspector.querySelector(`[data-pivot-dag-field="${cssEscape(focusSnapshot.field)}"]`);
            next?.focus?.({ preventScroll: true });
            if (next && focusSnapshot.start !== null && typeof next.setSelectionRange === 'function') {
                try {
                    next.setSelectionRange(focusSnapshot.start, focusSnapshot.end ?? focusSnapshot.start);
                } catch (e) {
                    // Ignore controls that cannot restore a cursor range.
                }
            }
        } else if (focusSnapshot?.depend) {
            inspector.querySelector(`[data-pivot-dag-depend="${cssEscape(focusSnapshot.depend)}"]`)?.focus?.({ preventScroll: true });
        }
    };

    const applyToolInputTemplate = (nodeId) => {
        const node = ctx.spec.nodes.find(n => n.id === nodeId);
        if (!node) return;
        const tool = resolveToolForNode(currentTools(), node.tool);
        const template = buildToolInputTemplate(tool);
        node.input = { ...template, ...(node.input || {}) };
        ctx.render?.();
        ctx.flushOut?.();
        window.showToast?.('已套用工具参数模板', 'success');
    };

    const handleInspectorEdit = (input) => {
        const node = ctx.spec.nodes.find(n => n.id === ctx.selectedId);
        if (!node) return;
        const field = input.dataset.pivotDagField;
        if (field === 'title') {
            node.title = String(input.value || '').slice(0, 120);
        } else if (field === 'tool') {
            const nextTool = String(input.value || '');
            if (isLlmNode(node) && nextTool !== 'agent.llm' && llmNodes(ctx.spec.nodes).length <= 1) {
                input.value = node.tool;
                window.showToast?.('工作流必须保留 1 个大模型节点', 'warning');
                return;
            }
            node.tool = nextTool;
            if (node.tool === 'agent.llm') {
                node.input = { ...defaultLlmInput(), ...(node.input || {}) };
                ensureLlmNodeInput(node);
            }
        } else if (field === 'condition') {
            node.condition = ['always', 'success'].includes(input.value) ? input.value : 'success';
        } else if (field === 'onError') {
            node.onError = ['skip_dependents', 'continue', 'stop'].includes(input.value) ? input.value : 'skip_dependents';
        } else if (field === 'retryLimit') {
            node.retryLimit = Math.max(0, Math.min(Number.parseInt(input.value, 10) || 0, 5));
        } else if (field === 'timeoutMs') {
            node.timeoutMs = Math.max(0, Math.min(Number.parseInt(input.value, 10) || 0, 600000));
        } else if (field === 'input') {
            try {
                const parsed = JSON.parse(input.value || '{}');
                node.input = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
                input.classList.remove('is-invalid');
            } catch (e) {
                input.classList.add('is-invalid');
                return;
            }
        }
        ctx.render?.();
        ctx.flushOut?.();
    };

    const handleDependsToggle = (checkbox) => {
        const node = ctx.spec.nodes.find(n => n.id === ctx.selectedId);
        if (!node) return;
        const dep = checkbox.dataset.pivotDagDepend;
        const deps = new Set(node.dependsOn || []);
        if (checkbox.checked) {
            if (!isForwardDependency(dep, node.id)) {
                checkbox.checked = false;
                window.showToast?.('只能选择当前节点左侧的上游节点', 'error');
                return;
            }
            if (wouldCreateCycle(dep, node.id)) {
                checkbox.checked = false;
                window.showToast?.('不能添加循环依赖', 'error');
                return;
            }
            deps.add(dep);
        } else {
            deps.delete(dep);
        }
        node.dependsOn = [...deps];
        clampDependsOn(ctx.spec.nodes);
        ctx.render?.();
        ctx.flushOut?.();
    };

    return {
        renderInspector
    };
}
