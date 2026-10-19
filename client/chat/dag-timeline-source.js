/* 将瀑布图绑定到实际工作流运行，避免复用其他画布的节点状态。 */
/* global API_BASE, apiFetch */
(function () {
    const recentRuns = new Map();
    const parse = value => {
        if (value && typeof value === 'object') return value;
        try { return JSON.parse(value || '{}'); } catch (_) { return {}; }
    };
    function stable(value) {
        if (value == null) return 'null';
        if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
        if (typeof value !== 'object') return JSON.stringify(value);
        return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
    }
    function signature(spec = {}) {
        const nodes = (spec.nodes || []).map(node => ({
            id: node.id, tool: node.tool, input: node.input || {},
            dependsOn: [...(node.dependsOn || [])].sort(), condition: node.condition || 'success',
            when: node.when || null, onError: node.onError || 'skip_dependents',
            cache: node.cache !== false, joinMode: node.joinMode || 'all',
            retryLimit: Number(node.retryLimit || 0), timeoutMs: Number(node.timeoutMs || 0),
            fallbackOutput: node.fallbackOutput ?? null
        })).sort((a, b) => String(a.id).localeCompare(String(b.id)));
        const edges = (spec.edges?.length ? spec.edges : nodes.flatMap(node => node.dependsOn.map(from => ({ from, to: node.id, route: 'default' }))))
            .map(edge => ({ from: edge.from, to: edge.to, route: edge.route || 'default' }))
            .sort((a, b) => stable(a).localeCompare(stable(b)));
        return stable({ nodes, edges, cacheEnabled: spec.cacheEnabled !== false });
    }
    const keyFor = (spec, workflowId) => `${workflowId || 'draft'}:${signature(spec)}`;
    function rememberRun(run, { spec, workflowId = '' } = {}) {
        if (!run?.id) return;
        const metadata = parse(run.metadata);
        const graph = metadata.dagSpec || metadata.dag || spec;
        if (!graph?.nodes?.length) return;
        recentRuns.set(keyFor(graph, workflowId || metadata.workflowId || metadata.workflowEditorId), run.id);
        if (recentRuns.size > 50) recentRuns.delete(recentRuns.keys().next().value);
    }
    async function read(url, signal) {
        const response = await apiFetch(url, { cache: 'no-store', signal });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || '加载执行耗时失败，请稍后重试。');
        return data;
    }
    function createSource({ spec, workflowId = '', workflowName = '' }) {
        const key = keyFor(spec, workflowId);
        let runId = '';
        return async ({ signal } = {}) => {
            runId = recentRuns.get(key) || runId;
            if (!runId) {
                const data = await read(`${API_BASE}/agents/runs?includePreview=true&limit=100`, signal);
                const run = (data.data || []).find(candidate => {
                    const metadata = parse(candidate.metadata);
                    const graph = metadata.dagSpec || metadata.dag;
                    const owner = String(metadata.workflowId || metadata.workflowEditorId || '');
                    const sameWorkflow = owner ? owner === String(workflowId)
                        : workflowName && metadata.workflowName === workflowName;
                    return candidate.run_mode === 'dag' && sameWorkflow && graph?.nodes?.length && signature(graph) === signature(spec);
                });
                if (!run) return { run: null, runStates: new Map(), message: '当前画布暂无匹配的运行记录，请先预览运行或运行发布版。' };
                runId = run.id;
                recentRuns.set(key, runId);
            }
            const data = await read(`${API_BASE}/agents/runs/${encodeURIComponent(runId)}`, signal);
            const cachedTitles = new Set((data.steps || []).filter(step => /^\[快取复用\] DAG 节点：/u.test(step.title || ''))
                .map(step => step.title.replace(/^\[快取复用\] DAG 节点：/u, '')));
            const states = new Map((data.dagNodes || []).map(node => [String(node.node_key || node.id), {
                status: node.status, durationMs: node.duration_ms, startedAt: node.started_at,
                completedAt: node.completed_at, cached: Boolean(node.cached || cachedTitles.has(node.title) &&
                    data.dagNodes.filter(item => item.title === node.title).length === 1), title: node.title
            }]));
            return { run: data.run, runStates: states, message: `运行记录：${data.run?.title || '工作流'} · ${data.run?.created_at || runId}` };
        };
    }
    window.Pivot?.exposeModule?.('agent.dagTimelineSource', { createSource, rememberRun });
})();
