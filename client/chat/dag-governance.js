/* Agent DAG 工作流治理模块：静态拓扑体检 (Lint)、版本 Diff 对比与标准规范导入导出 */

(function () {
    /**
     * 提取模板表达式中的依赖节点 ID，例如 {{nodes.fetch_data.output.text}} -> 'fetch_data'
     */
    function extractNodeIdReferences(input) {
        const refs = new Set();
        const walk = (val) => {
            if (typeof val === 'string') {
                const regex = /\{\{\s*nodes\.([a-zA-Z0-9_\-]+)\./g;
                let match;
                while ((match = regex.exec(val)) !== null) {
                    refs.add(match[1]);
                }
            } else if (Array.isArray(val)) {
                val.forEach(walk);
            } else if (val && typeof val === 'object') {
                Object.values(val).forEach(walk);
            }
        };
        walk(input);
        return Array.from(refs);
    }

    /**
     * 检测 DAG 中是否存在循环依赖 (Cycle Detection via DFS)
     */
    function detectCycle(nodes = []) {
        const adj = new Map();
        nodes.forEach(n => adj.set(n.id, Array.isArray(n.dependsOn) ? [...n.dependsOn] : []));

        const visited = new Set();
        const inStack = new Set();
        const cyclePath = [];

        function dfs(nodeId, path = []) {
            visited.add(nodeId);
            inStack.add(nodeId);
            path.push(nodeId);

            const neighbors = adj.get(nodeId) || [];
            for (const neighbor of neighbors) {
                if (!visited.has(neighbor)) {
                    if (dfs(neighbor, [...path])) return true;
                } else if (inStack.has(neighbor)) {
                    cyclePath.push(...path, neighbor);
                    return true;
                }
            }

            inStack.delete(nodeId);
            return false;
        }

        for (const node of nodes) {
            if (!visited.has(node.id)) {
                if (dfs(node.id)) return { hasCycle: true, cyclePath };
            }
        }
        return { hasCycle: false, cyclePath: [] };
    }

    /**
     * 工作流静态体检与拓扑死锁/孤立节点自检 (Preflight Graph Linting)
     */
    function normalizeGraphInput(value) {
        if (Array.isArray(value)) return { nodes: value, edges: [] };
        if (value && typeof value === 'object') return {
            nodes: Array.isArray(value.nodes) ? value.nodes : [],
            edges: Array.isArray(value.edges) ? value.edges : []
        };
        return { nodes: [], edges: [] };
    }

    function lintDagGraph(value = []) {
        const graph = normalizeGraphInput(value);
        const list = graph.nodes;
        const edges = graph.edges;
        const errors = [];
        const warnings = [];

        if (!list.length) {
            warnings.push({
                type: 'empty_graph',
                message: '画布为空，尚未添加任何工作流节点。'
            });
            return { valid: true, errors, warnings };
        }

        const nodeMap = new Map(list.map(n => [n.id, n]));
        const outDegrees = new Map();
        list.forEach(n => outDegrees.set(n.id, 0));

        // 统计出度与入度
        list.forEach(n => {
            (n.dependsOn || []).forEach(depId => {
                outDegrees.set(depId, (outDegrees.get(depId) || 0) + 1);
            });
        });

        const routeTargets = new Map();
        edges.forEach(edge => {
            const from = String(edge?.from || '').trim();
            const to = String(edge?.to || '').trim();
            const route = String(edge?.route || 'default').trim().toLowerCase();
            if (!nodeMap.has(from) || !nodeMap.has(to)) {
                errors.push({ type: 'invalid_route_edge', nodeId: to || from, message: `路由边引用了不存在的节点：${from} → ${to}` });
            }
            if (!['default', 'true', 'false'].includes(route)) {
                errors.push({ type: 'invalid_route', nodeId: to || from, message: `路由边分支无效：${route}` });
            }
            if (route !== 'default' && nodeMap.get(from)?.tool !== 'workflow.condition') {
                errors.push({ type: 'invalid_route_source', nodeId: from, message: `只有条件节点才能使用 True/False 路由：${from}` });
            }
            const key = `${from}→${to}`;
            if (!routeTargets.has(key)) routeTargets.set(key, new Set());
            routeTargets.get(key).add(route);
            const target = nodeMap.get(to);
            if (target && !(target.dependsOn || []).includes(from)) {
                warnings.push({ type: 'route_dependency_mismatch', nodeId: to, message: `路由边 ${from} → ${to} 未同步到 dependsOn。` });
            }
        });
        routeTargets.forEach((routes, key) => {
            if (routes.has('true') && routes.has('false')) {
                errors.push({ type: 'ambiguous_routes', nodeId: key.split('→')[1], message: `同一目标不能同时连接 True 和 False 路由：${key}` });
            }
        });

        // 1. 循环依赖检测
        const cycleResult = detectCycle(list);
        if (cycleResult.hasCycle) {
            errors.push({
                type: 'circular_dependency',
                nodeId: cycleResult.cyclePath[0],
                message: `检测到循环依赖环路：${cycleResult.cyclePath.join(' → ')}，请解除回环连线。`
            });
        }

        list.forEach(node => {
            const inCount = (node.dependsOn || []).length;
            const outCount = outDegrees.get(node.id) || 0;

            // 2. 空工具校验
            if (!node.tool || !String(node.tool).trim()) {
                errors.push({
                    type: 'missing_tool',
                    nodeId: node.id,
                    message: `节点「${node.title || node.id}」未指定执行工具。`
                });
            }

            // 3. 悬空/不存在的前序依赖检查
            (node.dependsOn || []).forEach(depId => {
                if (!nodeMap.has(depId)) {
                    errors.push({
                        type: 'dangling_dependency',
                        nodeId: node.id,
                        message: `节点「${node.title || node.id}」依赖了不存在的前序节点 ID：${depId}。`
                    });
                }
            });

            // 4. 输入参数中的模板变量引用自检
            const whenReference = node.when?.source ? `{{${String(node.when.source).trim()}}}` : '';
            const referencedNodes = [...new Set([
                ...extractNodeIdReferences(node.input),
                ...extractNodeIdReferences(whenReference)
            ])];
            referencedNodes.forEach(refId => {
                if (!nodeMap.has(refId)) {
                    errors.push({
                        type: 'invalid_variable_reference',
                        nodeId: node.id,
                        message: `节点「${node.title || node.id}」的参数引用了不存在的节点「${refId}」。`
                    });
                } else if (!(node.dependsOn || []).includes(refId)) {
                    warnings.push({
                        type: 'undeclared_dependency',
                        nodeId: node.id,
                        message: `节点「${node.title || node.id}」参数使用了「${refId}」的输出，但未在拓扑中建立依赖连线，可能导致无法求值。`
                    });
                }
            });

            // 5. 孤立节点警告（多于1个节点时，既无入度又无出度）
            if (list.length > 1 && inCount === 0 && outCount === 0) {
                warnings.push({
                    type: 'isolated_node',
                    nodeId: node.id,
                    message: `节点「${node.title || node.id}」为孤立节点，未与任何其他节点建立依赖关系。`
                });
            }
        });

        return {
            valid: errors.length === 0,
            errors,
            warnings
        };
    }

    /**
     * 工作流版本对比 (Workflow Version Diff)
     */
    function computeDagDiff(v1Nodes = [], v2Nodes = []) {
        const graph1 = normalizeGraphInput(v1Nodes);
        const graph2 = normalizeGraphInput(v2Nodes);
        const list1 = graph1.nodes;
        const list2 = graph2.nodes;

        const map1 = new Map(list1.map(n => [n.id, n]));
        const map2 = new Map(list2.map(n => [n.id, n]));

        const added = [];
        const removed = [];
        const modified = [];
        const dependencyChanges = [];
        const routeChanges = [];

        list2.forEach(n2 => {
            if (!map1.has(n2.id)) {
                added.push({ id: n2.id, title: n2.title || n2.id, tool: n2.tool });
            } else {
                const n1 = map1.get(n2.id);
                const isToolDiff = n1.tool !== n2.tool;
                const isTitleDiff = n1.title !== n2.title;
                const isInputDiff = JSON.stringify(n1.input || {}) !== JSON.stringify(n2.input || {});
                const isWhenDiff = n1.when !== n2.when;
                const isConditionDiff = n1.condition !== n2.condition;

                if (isToolDiff || isTitleDiff || isInputDiff || isWhenDiff || isConditionDiff) {
                    modified.push({
                        id: n2.id,
                        title: n2.title || n2.id,
                        changes: {
                            ...(isToolDiff ? { tool: { from: n1.tool, to: n2.tool } } : {}),
                            ...(isTitleDiff ? { title: { from: n1.title, to: n2.title } } : {}),
                            ...(isInputDiff ? { input: true } : {}),
                            ...(isWhenDiff ? { when: { from: n1.when, to: n2.when } } : {}),
                            ...(isConditionDiff ? { condition: { from: n1.condition, to: n2.condition } } : {})
                        }
                    });
                }

                // 连线变更
                const deps1 = (n1.dependsOn || []).slice().sort().join(',');
                const deps2 = (n2.dependsOn || []).slice().sort().join(',');
                if (deps1 !== deps2) {
                    dependencyChanges.push({
                        id: n2.id,
                        title: n2.title || n2.id,
                        from: n1.dependsOn || [],
                        to: n2.dependsOn || []
                    });
                }
            }
        });

        list1.forEach(n1 => {
            if (!map2.has(n1.id)) {
                removed.push({ id: n1.id, title: n1.title || n1.id, tool: n1.tool });
            }
        });

        const routes1 = JSON.stringify(graph1.edges.map(edge => ({ from: edge.from, to: edge.to, route: edge.route || 'default' })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
        const routes2 = JSON.stringify(graph2.edges.map(edge => ({ from: edge.from, to: edge.to, route: edge.route || 'default' })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
        if (routes1 !== routes2) routeChanges.push({ from: graph1.edges, to: graph2.edges });

        const hasDifferences = added.length > 0 || removed.length > 0 || modified.length > 0 || dependencyChanges.length > 0 || routeChanges.length > 0;

        return {
            hasDifferences,
            summary: `新增 ${added.length} 个节点，删除 ${removed.length} 个节点，修改 ${modified.length} 个节点，调整连线 ${dependencyChanges.length + routeChanges.length} 处`,
            added,
            removed,
            modified,
            dependencyChanges,
            routeChanges
        };
    }

    /**
     * 导出标准 JSON 规范
     */
    const SENSITIVE_EXPORT_KEY = /(?:^|[_-])(password|passwd|token|api[_-]?key|authorization|cookie|secret|private[_-]?key)(?:$|[_-])/i;
    const CREDENTIAL_REFERENCE_KEY = /^(?:credentialSecret|credential_secret)$/;
    const REDACTED_VALUE = '[REDACTED: configure credential in target environment]';

    function sanitizeExportValue(value, key = '', redactions = []) {
        if (SENSITIVE_EXPORT_KEY.test(String(key)) && !CREDENTIAL_REFERENCE_KEY.test(String(key))) {
            if (value !== undefined && value !== null && String(value).trim()) redactions.push(String(key));
            return REDACTED_VALUE;
        }
        if (typeof value === 'string') {
            try {
                const url = new URL(value);
                const sensitiveParams = [];
                [...url.searchParams.keys()].forEach(param => {
                    if (SENSITIVE_EXPORT_KEY.test(param)) {
                        url.searchParams.set(param, REDACTED_VALUE);
                        sensitiveParams.push(param);
                    }
                });
                if (sensitiveParams.length) redactions.push(...sensitiveParams.map(param => `${key || 'url'}.${param}`));
                return url.toString();
            } catch (_) {
                return value;
            }
        }
        if (Array.isArray(value)) return value.map(item => sanitizeExportValue(item, '', redactions));
        if (value && typeof value === 'object') {
            return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, sanitizeExportValue(childValue, childKey, redactions)]));
        }
        return value;
    }

    function buildWorkflowPackageManifest(nodes = [], redactions = []) {
        const add = (map, source, node) => {
            const key = String(source || '').trim();
            if (!key) return;
            if (!map.has(key)) map.set(key, { source: key, nodes: [] });
            map.get(key).nodes.push({ id: String(node.id || ''), title: String(node.title || node.id || '') });
        };
        const models = new Map(); const tools = new Map(); const credentials = new Map();
        const networkTargets = new Map(); const subworkflows = new Map();
        nodes.forEach(node => {
            const tool = String(node.tool || '').trim();
            const input = node.input && typeof node.input === 'object' ? node.input : {};
            add(tools, tool, node);
            if (['agent.llm', 'agent.content_review', 'agent.delegate'].includes(tool)) add(models, input.model || input.modelId || input.model_id, node);
            if (tool === 'agent.http') {
                add(credentials, input.credentialSecret || input.credential_secret, node);
                try {
                    const url = new URL(String(input.url || ''));
                    add(networkTargets, url.origin, node);
                } catch (_) {}
            }
            if (tool === 'workflow.subworkflow' || tool === 'workflow.iteration') {
                const id = String(input.workflowId || input.workflow_id || '').trim();
                if (id) {
                    const version = String(input.version || input.workflowVersion || 'published').trim() || 'published';
                    add(subworkflows, `${id}@${version}`, node);
                }
            }
        });
        return {
            format: 'pivot.workflow-package.v1',
            models: [...models.values()], tools: [...tools.values()], credentials: [...credentials.values()],
            networkTargets: [...networkTargets.values()], subworkflows: [...subworkflows.values()],
            redactedFields: [...new Set(redactions)].sort()
        };
    }

    function findUnsafeSensitiveLiterals(value, _key = '', issues = [], path = 'spec') {
        if (typeof value === 'string') {
            try {
                const url = new URL(value);
                [...url.searchParams.entries()].forEach(([param, paramValue]) => {
                    if (SENSITIVE_EXPORT_KEY.test(param) && paramValue !== REDACTED_VALUE && String(paramValue).trim()) {
                        issues.push(`${path}.${param}`);
                    }
                });
            } catch (_) {}
            return issues;
        }
        if (Array.isArray(value)) {
            value.forEach((item, index) => findUnsafeSensitiveLiterals(item, '', issues, `${path}[${index}]`));
            return issues;
        }
        if (!value || typeof value !== 'object') return issues;
        Object.entries(value).forEach(([childKey, childValue]) => {
            const childPath = `${path}.${childKey}`;
            if (SENSITIVE_EXPORT_KEY.test(childKey) && !CREDENTIAL_REFERENCE_KEY.test(childKey)
                && childValue !== REDACTED_VALUE && String(childValue ?? '').trim()) {
                issues.push(childPath);
                return;
            }
            findUnsafeSensitiveLiterals(childValue, childKey, issues, childPath);
        });
        return issues;
    }

    function exportDagWorkflowSpec(spec = {}, metadata = {}) {
        const nodes = Array.isArray(spec?.nodes) ? spec.nodes : [];
        const redactions = [];
        const cleanNodes = nodes.map(n => ({
            id: String(n.id || ''),
            title: String(n.title || n.id || ''),
            tool: String(n.tool || ''),
            input: sanitizeExportValue(n.input || {}, 'input', redactions),
            inputSchema: n.inputSchema || n.input_schema || null,
            outputSchema: n.outputSchema || n.output_schema || null,
            dependsOn: Array.isArray(n.dependsOn) ? n.dependsOn : [],
            condition: n.condition || 'success',
            when: n.when || '',
            retryLimit: Number(n.retryLimit ?? n.retry_limit ?? 0),
            timeoutMs: Number(n.timeoutMs ?? n.timeout_ms ?? 0),
            onError: n.onError || n.on_error || 'skip_dependents',
            ...(Object.prototype.hasOwnProperty.call(n, 'fallbackOutput') || Object.prototype.hasOwnProperty.call(n, 'fallback_output')
                ? { fallbackOutput: n.fallbackOutput ?? n.fallback_output }
                : {}),
            joinMode: n.joinMode || n.join_mode || 'all',
            cache: n.cache !== false,
            _x: Math.round(Number(n._x) || 0),
            _y: Math.round(Number(n._y) || 0)
        }));

        const edges = Array.isArray(spec.edges) ? spec.edges.map(edge => ({ from: edge.from, to: edge.to, route: edge.route || 'default' })) : [];
        return {
            schemaVersion: edges.length ? 'pivot.dag.v2' : 'pivot.dag.v1',
            exportedAt: new Date().toISOString(),
            metadata: {
                name: metadata.name || '导出工作流',
                description: metadata.description || '',
                version: metadata.version || '1.0.0'
            },
            spec: {
                cacheEnabled: spec.cacheEnabled !== false,
                nodes: cleanNodes,
                ...(edges.length ? { edges } : {})
            },
            dependencies: buildWorkflowPackageManifest(cleanNodes, redactions)
        };
    }

    /**
     * 导入并校验标准 JSON 规范
     */
    function importDagWorkflowSpec(jsonText) {
        if (!jsonText || typeof jsonText !== 'string') {
            return { ok: false, error: '导入内容为空' };
        }
        let parsed;
        try {
            parsed = JSON.parse(jsonText.trim());
        } catch (e) {
            return { ok: false, error: `JSON 格式解析失败：${e.message}` };
        }

        const nodes = Array.isArray(parsed?.spec?.nodes)
            ? parsed.spec.nodes
            : Array.isArray(parsed?.nodes)
                ? parsed.nodes
                : null;

        if (!nodes) {
            return { ok: false, error: 'JSON 中未包含合法的 spec.nodes 数组' };
        }

        const unsafeLiterals = findUnsafeSensitiveLiterals({ nodes });
        if (unsafeLiterals.length) {
            return { ok: false, error: `导入包包含未脱敏的敏感字段：${unsafeLiterals[0]}。请改用凭据引用后重新导出。` };
        }

        // 执行静态体检
        const edges = Array.isArray(parsed?.spec?.edges) ? parsed.spec.edges : (Array.isArray(parsed?.edges) ? parsed.edges : []);
        const lint = lintDagGraph({ nodes, edges });
        if (!lint.valid) {
            return {
                ok: false,
                error: `工作流规范校验不通过：${lint.errors[0]?.message || '存在格式错误'}`
            };
        }

        return {
            ok: true,
            spec: {
                cacheEnabled: parsed.spec?.cacheEnabled !== false,
                nodes,
                ...(edges.length ? { schemaVersion: 'pivot.dag.v2', edges } : {})
            },
            metadata: parsed.metadata || {},
            dependencies: parsed.dependencies && typeof parsed.dependencies === 'object' ? parsed.dependencies : null,
            warnings: [
                ...lint.warnings,
                ...(Array.isArray(parsed?.dependencies?.redactedFields) && parsed.dependencies.redactedFields.length
                    ? [`导入包已脱敏 ${parsed.dependencies.redactedFields.length} 个敏感字段；请在目标环境配置凭据。`]
                    : [])
            ]
        };
    }

    function validateWorkflowRoutes(nodes = [], edges = []) {
        return lintDagGraph({ nodes, edges });
    }

    if (typeof window !== 'undefined' && window.Pivot?.registerModule) {
        window.Pivot.registerModule('agent.dagGovernance', {
            lintDagGraph,
            validateWorkflowRoutes,
            computeDagDiff,
            buildWorkflowPackageManifest,
            exportDagWorkflowSpec,
            importDagWorkflowSpec
        });
    }

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = {
            lintDagGraph,
            computeDagDiff,
            buildWorkflowPackageManifest,
            exportDagWorkflowSpec,
            importDagWorkflowSpec
        };
    }
})();
