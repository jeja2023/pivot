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
    function lintDagGraph(nodes = []) {
        const list = Array.isArray(nodes) ? nodes : [];
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
            const referencedNodes = extractNodeIdReferences(node.input);
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
        const list1 = Array.isArray(v1Nodes) ? v1Nodes : [];
        const list2 = Array.isArray(v2Nodes) ? v2Nodes : [];

        const map1 = new Map(list1.map(n => [n.id, n]));
        const map2 = new Map(list2.map(n => [n.id, n]));

        const added = [];
        const removed = [];
        const modified = [];
        const dependencyChanges = [];

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

        const hasDifferences = added.length > 0 || removed.length > 0 || modified.length > 0 || dependencyChanges.length > 0;

        return {
            hasDifferences,
            summary: `新增 ${added.length} 个节点，删除 ${removed.length} 个节点，修改 ${modified.length} 个节点，调整连线 ${dependencyChanges.length} 处`,
            added,
            removed,
            modified,
            dependencyChanges
        };
    }

    /**
     * 导出标准 JSON 规范
     */
    function exportDagWorkflowSpec(spec = {}, metadata = {}) {
        const nodes = Array.isArray(spec?.nodes) ? spec.nodes : [];
        const cleanNodes = nodes.map(n => ({
            id: String(n.id || ''),
            title: String(n.title || n.id || ''),
            tool: String(n.tool || ''),
            input: n.input || {},
            outputSchema: n.outputSchema || null,
            dependsOn: Array.isArray(n.dependsOn) ? n.dependsOn : [],
            condition: n.condition || 'success',
            when: n.when || '',
            cache: n.cache !== false,
            _x: Math.round(Number(n._x) || 0),
            _y: Math.round(Number(n._y) || 0)
        }));

        return {
            schemaVersion: 'pivot.dag.v1',
            exportedAt: new Date().toISOString(),
            metadata: {
                name: metadata.name || '导出工作流',
                description: metadata.description || '',
                version: metadata.version || '1.0.0'
            },
            spec: {
                cacheEnabled: spec.cacheEnabled !== false,
                nodes: cleanNodes
            }
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

        // 执行静态体检
        const lint = lintDagGraph(nodes);
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
                nodes
            },
            metadata: parsed.metadata || {},
            warnings: lint.warnings
        };
    }

    if (typeof window !== 'undefined' && window.Pivot?.registerModule) {
        window.Pivot.registerModule('agent.dagGovernance', {
            lintDagGraph,
            computeDagDiff,
            exportDagWorkflowSpec,
            importDagWorkflowSpec
        });
    }

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = {
            lintDagGraph,
            computeDagDiff,
            exportDagWorkflowSpec,
            importDagWorkflowSpec
        };
    }
})();
