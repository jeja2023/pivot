/* DAG 检查器的节点测试、模拟结果与会话级变量覆盖。 */
(function () {
function validateTestFixture(value, schema = {}, path = '模拟结果', depth = 0) {
    if (depth > 8 || !schema || typeof schema !== 'object') return [];
    const types = Array.isArray(schema.type) ? schema.type : (schema.type ? [schema.type] : []);
    const matchesType = type => ({
        object: value !== null && typeof value === 'object' && !Array.isArray(value),
        array: Array.isArray(value), string: typeof value === 'string', number: typeof value === 'number' && Number.isFinite(value),
        integer: Number.isInteger(value), boolean: typeof value === 'boolean', null: value === null
    })[type] === true;
    if (types.length && !types.some(matchesType)) return [`${path} 类型不符合输出契约（期望 ${types.join(' / ')}）。`];
    const issues = [];
    if (types.includes('object') && value && typeof value === 'object' && !Array.isArray(value)) {
        (schema.required || []).forEach(key => {
            if (!Object.hasOwn(value, key)) issues.push(`${path}.${key} 缺少必填字段。`);
        });
        Object.entries(schema.properties || {}).forEach(([key, child]) => {
            if (Object.hasOwn(value, key)) issues.push(...validateTestFixture(value[key], child, `${path}.${key}`, depth + 1));
        });
    }
    if (types.includes('array') && Array.isArray(value) && schema.items) {
        value.slice(0, 100).forEach((item, index) => issues.push(...validateTestFixture(item, schema.items, `${path}[${index}]`, depth + 1)));
    }
    return issues;
}

function createDagNodeTestController(options = {}) {
    const {
        inspector, ctx, getUpstreamNodes, getRunStates, getNodeTestOutputSnapshots,
        setDagNodeTestOutput, setDagNodeTestOverride, resetDagNodeTestOverride,
        snapshotValue, currentTools, resolveToolForNode, showDagToast, apiBase
    } = options;

    const renderMarkup = snapshot => `
        <details class="pivot-dag-test-override"><summary>模拟结果${snapshot?.source === 'mock' ? ' · 已启用' : ''}</summary><p>不会调用工具；模拟结果仅供当前编辑会话的下游节点测试使用，不会保存到工作流或正式运行。</p><textarea class="form-input" rows="6" data-pivot-dag-test-mock>${dagEscapeHtml(JSON.stringify(snapshot?.output ?? {}, null, 2))}</textarea><div><button type="button" class="btn-secondary" data-pivot-dag-test-mock-save>应用模拟结果</button></div></details>
        ${snapshot ? `<details class="pivot-dag-test-override"><summary>测试变量${snapshot.overridden ? ' · 已覆盖' : ''}</summary><p>只影响当前编辑会话的后续节点测试，不会保存到工作流或正式运行。</p><textarea class="form-input" rows="6" data-pivot-dag-test-override>${dagEscapeHtml(JSON.stringify(snapshot.output, null, 2))}</textarea><div><button type="button" class="btn-secondary" data-pivot-dag-test-override-save>应用测试变量</button>${snapshot.overridden ? '<button type="button" class="btn-secondary" data-pivot-dag-test-override-reset>恢复节点测试输出</button>' : ''}</div></details>` : ''}
    `;

    const testNode = async node => {
        const button = inspector.querySelector('[data-pivot-dag-test-node]');
        const result = inspector.querySelector('[data-pivot-dag-test-result]');
        if (!node?.tool || !button || !result) return;
        button.disabled = true;
        button.textContent = '测试中…';
        result.hidden = false;
        result.className = 'pivot-dag-test-result is-running';
        result.textContent = '正在执行当前节点…';
        const upstreamNodes = getUpstreamNodes(ctx.spec?.nodes || [], node.id);
        const runStates = getRunStates();
        const testSnapshots = getNodeTestOutputSnapshots();
        const upstreamStates = [];
        upstreamNodes.forEach(up => {
            const state = runStates.get(up.id);
            const snapshot = testSnapshots.get(String(up.id));
            if (snapshot && snapshot.output !== undefined) {
                upstreamStates.push([up.id, { output: snapshot.output, status: 'completed' }]);
            } else if (state && state.output !== undefined) {
                upstreamStates.push([up.id, { output: state.output, status: state.status || 'completed' }]);
            }
        });
        const upstreamContext = {
            goal: String(ctx.getDagInputs?.()?.goal || ''),
            nodes: ctx.spec?.nodes || [],
            states: upstreamStates
        };
        try {
            const response = await apiFetch(`${apiBase}/agents/tools/test`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tool: node.tool, input: node.input || {}, dagInputs: ctx.getDagInputs?.() || {}, upstreamContext })
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data.error || '节点测试失败');
            result.className = 'pivot-dag-test-result is-success';
            setDagNodeTestOutput(String(node.id), {
                output: snapshotValue(data.output), resolvedInput: snapshotValue(data.resolvedInput || node.input || {}),
                createdAt: Date.now(), expiresAt: Date.now() + 15 * 60 * 1000, source: 'test'
            });
            const snapshotNotice = upstreamStates.length ? ` · 已注入 ${upstreamStates.length} 个上游运行快照` : '';
            const resolvedInfo = data.resolvedInput && JSON.stringify(data.resolvedInput) !== JSON.stringify(node.input || {})
                ? `\n[解析后入参]:\n${JSON.stringify(data.resolvedInput, null, 2)}\n\n[输出结果]:\n` : '\n';
            result.textContent = `节点执行完成 · 耗时 ${data.durationMs || 0} 毫秒${snapshotNotice}${resolvedInfo}${JSON.stringify(data.output, null, 2)}`;
        } catch (error) {
            result.className = 'pivot-dag-test-result is-error';
            result.textContent = error.message || '节点测试失败';
        } finally {
            button.disabled = false;
            button.textContent = '测试节点';
        }
    };

    const bind = node => {
        inspector.querySelector('[data-pivot-dag-test-node]')?.addEventListener('click', () => testNode(node));
        inspector.querySelector('[data-pivot-dag-test-mock-save]')?.addEventListener('click', () => {
            const input = inspector.querySelector('[data-pivot-dag-test-mock]');
            try {
                const output = JSON.parse(input?.value || 'null');
                const selectedTool = resolveToolForNode(currentTools(), node.tool);
                const schema = Object.keys(node.outputSchema || {}).length ? node.outputSchema : (selectedTool?.output_schema || selectedTool?.outputSchema || {});
                const issues = validateTestFixture(output, schema);
                if (issues.length) throw new Error(`模拟结果不符合输出契约：${issues[0]}`);
                if (!setDagNodeTestOutput(node.id, {
                    output, resolvedInput: snapshotValue(node.input || {}), createdAt: Date.now(),
                    expiresAt: Date.now() + 15 * 60 * 1000, source: 'mock'
                })) throw new Error('无法设置当前节点的模拟结果。');
                showDagToast('已应用模拟结果；后续节点测试将使用它，不会执行外部工具。', 'success');
                ctx.render?.();
            } catch (error) {
                showDagToast(error.message || '模拟结果必须是合法 JSON。', 'error');
            }
        });
        inspector.querySelector('[data-pivot-dag-test-override-save]')?.addEventListener('click', () => {
            const input = inspector.querySelector('[data-pivot-dag-test-override]');
            try {
                const value = JSON.parse(input?.value || 'null');
                if (!setDagNodeTestOverride(node.id, value)) throw new Error('当前没有可覆盖的节点测试结果。');
                showDagToast('已应用测试变量覆盖，仅用于当前编辑会话。', 'success');
                ctx.render?.();
            } catch (error) {
                showDagToast(error.message || '测试变量必须是合法 JSON。', 'error');
            }
        });
        inspector.querySelector('[data-pivot-dag-test-override-reset]')?.addEventListener('click', () => {
            if (!resetDagNodeTestOverride(node.id)) return;
            showDagToast('已恢复节点测试输出。', 'success');
            ctx.render?.();
        });
    };

    return { bind, renderMarkup, testNode };
}

window.Pivot.registerModule('agent.dagInspectorTesting', { createDagNodeTestController, validateTestFixture });
})();
