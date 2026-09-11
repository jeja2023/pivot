/* Agent DAG 核心数据、节点、连线与布局辅助函数（拆自 agents-dag-editor.js） */



const SVG_NS = 'http://www.w3.org/2000/svg';

const NODE_WIDTH = 188;

const NODE_HEIGHT = 62;

const NODE_GAP_X = 72;

const NODE_GAP_Y = 30;

const PADDING = 24;

const DEFAULT_VIEW_SCALE = 0.72;

const SCALE_MIN = 0.3;

const SCALE_MAX = 2.5;

const MIN_CONTENT_WIDTH = 960;

const MIN_CONTENT_HEIGHT = 360;

// 工作流是无限画布：允许节点越过默认原点向左、向上布局，同时保留足够大的
// 安全边界，避免异常数据把 SVG / 小地图扩展到不可渲染的尺寸。
const DAG_COORDINATE_MIN = -100000;

const DAG_COORDINATE_MAX = 100000;

function clampDagCoordinate(value, fallback = 0) {
        const coordinate = Number(value);
        if (!Number.isFinite(coordinate)) return fallback;
        return Math.max(DAG_COORDINATE_MIN, Math.min(DAG_COORDINATE_MAX, coordinate));
    }

const dagEscapeHtml = (typeof window !== 'undefined' && window.Pivot?.legacy?.PivotSafeHtml && window.Pivot.legacy.PivotSafeHtml.escapeHtml)
        || ((value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));

const dagEscapeAttr = (typeof window !== 'undefined' && window.Pivot?.legacy?.PivotSafeHtml && window.Pivot.legacy.PivotSafeHtml.escapeAttr)
        || ((value) => dagEscapeHtml(value).replace(/"/g, '&quot;'));

function uniqueId(existing, base = 'node') {
        let i = existing.length + 1;
        const set = new Set(existing);
        while (set.has(`${base}_${i}`)) i += 1;
        return `${base}_${i}`;
    }

function clampDependsOn(nodes) {
        const ids = new Set(nodes.map(n => n.id));
        nodes.forEach(node => {
            node.dependsOn = (node.dependsOn || []).filter(dep => ids.has(dep) && dep !== node.id);
        });
    }

function toolValue(tool) {
        return tool?.fullName || tool?.name || '';
    }

function autoLayout(nodes) {
        const remaining = new Map(nodes.map(n => [n.id, new Set(n.dependsOn || [])]));
        const layers = [];
        const placed = new Set();
        // 兜底：节点数 <= 50 时层次清晰；更多节点也接受较粗略布局
        while (placed.size < nodes.length) {
            const layer = [];
            nodes.forEach(node => {
                if (placed.has(node.id)) return;
                const deps = remaining.get(node.id);
                const ready = [...deps].every(dep => placed.has(dep));
                if (ready) layer.push(node);
            });
            if (layer.length === 0) {
                // 出现环时把还没排的节点全部放到下一层，避免死循环
                nodes.forEach(node => {
                    if (!placed.has(node.id)) layer.push(node);
                });
            }
            layers.push(layer);
            layer.forEach(node => placed.add(node.id));
        }
        layers.forEach((layer, layerIndex) => {
            layer.forEach((node, slot) => {
                node._x = PADDING + layerIndex * (NODE_WIDTH + NODE_GAP_X);
                node._y = PADDING + slot * (NODE_HEIGHT + NODE_GAP_Y);
            });
        });
    }

function findAvailableNodePosition(nodes, anchorId = '') {
        const anchor = nodes.find(node => node.id === anchorId);
        const baseX = anchor
            ? Number(anchor._x || 0) + NODE_WIDTH + NODE_GAP_X
            : PADDING;
        const baseY = anchor ? Number(anchor._y || 0) : PADDING;
        const occupied = nodes.filter(node => Number.isFinite(node._x) && Number.isFinite(node._y));
        const overlaps = (x, y) => occupied.some(node => (
            Math.abs(node._x - x) < NODE_WIDTH + 16
            && Math.abs(node._y - y) < NODE_HEIGHT + 12
        ));
        const rowStep = NODE_HEIGHT + NODE_GAP_Y;
        const maxAttempts = Math.max(12, nodes.length * 2 + 4);
        for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
            const y = baseY + attempt * rowStep;
            if (!overlaps(baseX, y)) return { x: baseX, y };
        }
        return { x: baseX + NODE_WIDTH + NODE_GAP_X, y: baseY };
    }

function placeNewNode(nodes, node, anchorId = '') {
        const position = findAvailableNodePosition(nodes.filter(item => item !== node), anchorId);
        node._x = position.x;
        node._y = position.y;
        return node;
    }

function ensureDefaults(spec) {
        const savedLayout = spec?.layout && typeof spec.layout === 'object' && !Array.isArray(spec.layout)
            ? spec.layout
            : {};
        const nodes = Array.isArray(spec?.nodes) ? spec.nodes.map(n => ({
            id: String(n.id || '').trim() || 'node',
            title: String(n.title || n.id || '').trim() || '未命名',
            tool: String(n.tool || '').trim(),
            input: n.input && typeof n.input === 'object' ? n.input : {},
            inputSchema: n.inputSchema && typeof n.inputSchema === 'object'
                ? n.inputSchema
                : (n.input_schema && typeof n.input_schema === 'object' ? n.input_schema : {}),
            outputSchema: n.outputSchema && typeof n.outputSchema === 'object'
                ? n.outputSchema
                : (n.output_schema && typeof n.output_schema === 'object' ? n.output_schema : {}),
            dependsOn: Array.isArray(n.dependsOn) ? n.dependsOn.slice() : [],
            condition: ['always', 'success', 'failure'].includes(n.condition) ? n.condition : 'success',
            when: (n.when && typeof n.when === 'object' && !Array.isArray(n.when) && n.when.source)
                ? { source: String(n.when.source || '').trim(), operator: String(n.when.operator || 'equals').trim(), value: n.when.value ?? '' }
                : null,
            retryLimit: Math.max(0, Math.min(Number.parseInt(n.retryLimit ?? n.retry_limit ?? 0, 10) || 0, 5)),
            timeoutMs: Math.max(0, Math.min(Number.parseInt(n.timeoutMs ?? n.timeout_ms ?? 0, 10) || 0, 600000)),
            onError: ['skip_dependents', 'continue', 'stop'].includes(String(n.onError || n.on_error || 'skip_dependents')) ? String(n.onError || n.on_error || 'skip_dependents') : 'skip_dependents',
            // 优先读取独立布局元数据，同时兼容旧版节点内坐标。
            _x: Number.isFinite(Number(savedLayout[n.id]?.x ?? n._x)) ? clampDagCoordinate(savedLayout[n.id]?.x ?? n._x) : undefined,
            _y: Number.isFinite(Number(savedLayout[n.id]?.y ?? n._y)) ? clampDagCoordinate(savedLayout[n.id]?.y ?? n._y) : undefined
        })) : [];
        nodes.forEach(ensureLlmNodeInput);
        const missingPositionNodes = nodes.filter(n => n._x === undefined || n._y === undefined);
        if (missingPositionNodes.length === nodes.length) {
            autoLayout(nodes);
        } else {
            missingPositionNodes.forEach(node => placeNewNode(nodes, node, node.dependsOn?.[0] || ''));
        }
        return { nodes };
    }

function serialize(spec) {
        const nodes = spec.nodes.map(({ id, title, tool, input, inputSchema, outputSchema, dependsOn, condition, when, retryLimit, timeoutMs, onError }) => {
            const node = {
                id,
                title,
                tool,
                input,
                inputSchema: inputSchema && typeof inputSchema === 'object' ? inputSchema : {},
                outputSchema: outputSchema && typeof outputSchema === 'object' ? outputSchema : {},
                dependsOn: [...(dependsOn || [])],
                condition,
                retryLimit: Number(retryLimit || 0),
                timeoutMs: Number(timeoutMs || 0),
                onError: onError || 'skip_dependents'
            };
            if (when && typeof when === 'object' && String(when.source || '').trim()) {
                node.when = { source: String(when.source).trim(), operator: String(when.operator || 'equals').trim(), value: when.value ?? '' };
            }
            return node;
        });
        const layout = Object.fromEntries(spec.nodes
            .filter(node => Number.isFinite(node._x) && Number.isFinite(node._y))
            .map(node => [node.id, { x: clampDagCoordinate(node._x), y: clampDagCoordinate(node._y) }]));
        return { nodes, layout };
    }

function readJson(text) {
        const raw = String(text || '').trim();
        if (!raw) return { nodes: [] };
        try {
            const value = JSON.parse(raw);
            if (Array.isArray(value)) return { nodes: value };
            if (value && typeof value === 'object') return value;
        } catch (e) {
            // 静默 — 编辑器会保留上次成功的快照
        }
        return null;
    }

function workflowModelOptions() {
        const canSelectModel = (typeof window !== 'undefined' && typeof window.Pivot?.legacy?.isSelectableModelForCurrentUser === 'function')
            ? window.Pivot.legacy.isSelectableModelForCurrentUser
            : (model => !model?.user_id || (typeof currentUser !== 'undefined' && String(model.user_id) === String(currentUser?.id)));
        const candidates = (typeof window !== 'undefined' && window.Pivot?.legacy) ? [
            ...(Array.isArray(window.Pivot.legacy._cachedAgentModels) ? window.Pivot.legacy._cachedAgentModels : []),
            ...(Array.isArray(window.Pivot.legacy._cachedModels) ? window.Pivot.legacy._cachedModels : [])
        ] : [];
        const seen = new Set();
        return candidates.filter(model => {
            const id = String(model?.id || '').trim();
            if (!id || seen.has(id) || model?.type === 'embedding' || !canSelectModel(model)) return false;
            seen.add(id);
            return true;
        });
    }

function defaultWorkflowModelId() {
        const models = workflowModelOptions();
        const selectedId = typeof document !== 'undefined' ? String(
            document.getElementById('model-selector')?.value
            || document.getElementById('agent-model-select')?.value
            || ''
        ).trim() : '';
        if (selectedId && models.some(model => String(model.id) === selectedId)) return selectedId;
        return String(models[0]?.id || '').trim();
    }

function defaultLlmInput(selectedNode = null) {
        return {
            model: defaultWorkflowModelId(),
            maxSteps: 20,
            systemPrompt: '你是工作流中的分析节点。请严格基于输入和上游结果完成任务，输出使用中文。',
            prompt: selectedNode
                ? `请基于上游节点「${selectedNode.title || selectedNode.id}」的输出完成分析：\n{{nodes.${selectedNode.id}.output}}`
                : '请根据本次工作流目标完成分析：\n{{goal}}',
            responseFormat: 'markdown',
            temperature: 0.2,
            maxTokens: 1200
        };
    }

function isLlmNode(node) {
        return String(node?.tool || '') === 'agent.llm';
    }

function llmNodes(nodes = []) {
        return nodes.filter(isLlmNode);
    }

function llmNodeInputText(node) {
        const input = node?.input && typeof node.input === 'object' ? node.input : {};
        return [
            input.prompt,
            input.systemPrompt,
            input.system_prompt,
            input.input,
            input.text
        ].map(value => String(value || '')).join('\n');
    }

function llmNodeReferencesWorkflowInput(node) {
        return /\{\{\s*(?:goal|run\.goal|inputs?\.|run\.inputs?\.)/i.test(llmNodeInputText(node));
    }

function validateLlmNodePlacement(nodes = []) {
        const issues = [];
        nodes.filter(isLlmNode).forEach(node => {
            const deps = Array.isArray(node.dependsOn) ? node.dependsOn : [];
            if (deps.length > 0) return;
            if (llmNodeReferencesWorkflowInput(node)) return;
            issues.push(`${node.title || node.id} 缺少上游输入，请连接数据/检索节点，或在提示词中引用 {{goal}} / {{inputs.*}}`);
        });
        return issues;
    }

function llmNodeModel(node) {
        return String(node?.input?.model || node?.input?.modelId || node?.input?.model_id || '').trim();
    }

function ensureLlmNodeInput(node) {
        if (!isLlmNode(node)) return;
        node.input = node.input && typeof node.input === 'object' ? node.input : {};
        if (!llmNodeModel(node)) {
            node.input.model = defaultWorkflowModelId();
        }
    }

function syncLlmOutputContract(node, input = null) {
        if (!isLlmNode(node)) return;
        const nextInput = input && typeof input === 'object' ? input : (node.input || {});
        const hasExplicitFormat = Object.prototype.hasOwnProperty.call(nextInput, 'responseFormat')
            || Object.prototype.hasOwnProperty.call(nextInput, 'response_format');
        if (!hasExplicitFormat) return;
        const format = String(nextInput.responseFormat || nextInput.response_format || 'markdown').trim();
        const schema = node.outputSchema && typeof node.outputSchema === 'object' && !Array.isArray(node.outputSchema)
            ? node.outputSchema
            : {};
        const schemaKeys = Object.keys(schema);
        const isDefaultStringSchema = schema.type === 'string' && schemaKeys.every(key => key === 'type');
        if (format === 'json' && isDefaultStringSchema) {
            node.outputSchema = {};
        } else if (format !== 'json' && !schemaKeys.length) {
            node.outputSchema = { type: 'string' };
        }
    }

function writeJson(textarea, spec) {
        if (!textarea) return;
        textarea.value = JSON.stringify(serialize(spec), null, 2);
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }

function getToolSchema(tool) {
        const schema = tool?.input_schema || tool?.inputSchema || tool?.parameters || {};
        return schema && typeof schema === 'object' ? schema : {};
    }

function isDatabaseConnectionField(name = '', tool = null) {
        if (!tool?.databaseTool) return false;
        return ['connection_id', 'database_connection_id', 'mcp_server_id'].includes(normalizeFieldKey(name));
    }

function getUpstreamNodes(nodes = [], targetNodeId = '') {
    if (!targetNodeId || !Array.isArray(nodes)) return [];
    const nodeMap = new Map(nodes.map(n => [String(n?.id || ''), n]));
    const target = nodeMap.get(String(targetNodeId));
    if (!target) return [];
    const visited = new Set();
    const result = [];
    const queue = [...(Array.isArray(target.dependsOn) ? target.dependsOn : [])];

    while (queue.length > 0) {
        const currentId = String(queue.shift() || '').trim();
        if (!currentId || visited.has(currentId) || currentId === String(targetNodeId)) continue;
        visited.add(currentId);
        const node = nodeMap.get(currentId);
        if (node) {
            result.push(node);
            (Array.isArray(node.dependsOn) ? node.dependsOn : []).forEach(depId => {
                if (!visited.has(String(depId))) queue.push(String(depId));
            });
        }
    }
    // 保持在原节点列表中的先后拓扑顺序
    return nodes.filter(n => visited.has(String(n.id)));
}

function getAvailableVariableOptions(nodes = [], targetNodeId = '', _tools = []) {
    const upstream = getUpstreamNodes(nodes, targetNodeId);
    const groups = [
        {
            group: '全局变量',
            items: [
                { expression: '{{goal}}', label: '工作流目标 (goal)', description: '当前任务的目标或用户提示词' },
                { expression: '{{inputs}}', label: '全部全局输入 (inputs)', description: '包含运行时传入的所有命名参数对象' }
            ]
        }
    ];

    if (upstream.length > 0) {
        upstream.forEach(upNode => {
            const nodeId = upNode.id;
            const nodeTitle = upNode.title || nodeId;
            const items = [
                { expression: `{{nodes.${nodeId}.output}}`, label: `${nodeTitle} · 完整输出`, description: '该节点的全部输出结果（对象或文本）' },
                { expression: `{{nodes.${nodeId}.status}}`, label: `${nodeTitle} · 运行状态`, description: 'completed / error / skipped' }
            ];

            const schema = upNode.outputSchema && typeof upNode.outputSchema === 'object' ? upNode.outputSchema : {};
            const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : null;
            if (props && Object.keys(props).length > 0) {
                Object.entries(props).forEach(([propKey, propMeta]) => {
                    items.push({
                        expression: `{{nodes.${nodeId}.output.${propKey}}}`,
                        label: `${nodeTitle} · ${propMeta.title || propMeta.description || propKey}`,
                        description: `类型: ${propMeta.type || 'any'}`
                    });
                });
            } else {
                // 常见工具推断输出字段
                const tool = String(upNode.tool || '');
                if (tool === 'agent.llm') {
                    items.push({ expression: `{{nodes.${nodeId}.output.text}}`, label: `${nodeTitle} · 文本结果 (text)`, description: '大模型回答的纯文本' });
                } else if (tool.startsWith('db.')) {
                    items.push({ expression: `{{nodes.${nodeId}.output.rows}}`, label: `${nodeTitle} · 数据行 (rows)`, description: '查询返回的数组列表' });
                    items.push({ expression: `{{nodes.${nodeId}.output.count}}`, label: `${nodeTitle} · 记录数 (count)`, description: '返回数据行数' });
                } else if (tool.startsWith('rag.')) {
                    items.push({ expression: `{{nodes.${nodeId}.output.documents}}`, label: `${nodeTitle} · 检索切片 (documents)`, description: '命中的知识库文档段落' });
                    items.push({ expression: `{{nodes.${nodeId}.output.text}}`, label: `${nodeTitle} · 检索摘要 (text)`, description: '知识切片合并摘要' });
                } else if (tool.startsWith('official_writing.')) {
                    items.push({ expression: `{{nodes.${nodeId}.output.content}}`, label: `${nodeTitle} · 公文正文 (content)`, description: '公文生成的正文文本' });
                    items.push({ expression: `{{nodes.${nodeId}.output.title}}`, label: `${nodeTitle} · 公文标题 (title)`, description: '公文拟定标题' });
                }
            }

            groups.push({
                group: `上游节点：${nodeTitle}`,
                nodeId,
                items
            });
        });
    }

    return groups;
}

function alignNodes(nodes = [], selectedIds = [], alignment = 'horizontal_center') {
    if (!Array.isArray(nodes) || !Array.isArray(selectedIds) || selectedIds.length < 2) {
        return { changed: false, modifiedCount: 0 };
    }
    const idSet = new Set(selectedIds.map(String));
    const targets = nodes.filter(n => idSet.has(String(n.id)) && Number.isFinite(n._x) && Number.isFinite(n._y));
    if (targets.length < 2) return { changed: false, modifiedCount: 0 };

    switch (alignment) {
        case 'left': {
            const minX = Math.min(...targets.map(n => n._x));
            targets.forEach(n => { n._x = clampDagCoordinate(minX); });
            break;
        }
        case 'right': {
            const maxX = Math.max(...targets.map(n => n._x));
            targets.forEach(n => { n._x = clampDagCoordinate(maxX); });
            break;
        }
        case 'top': {
            const minY = Math.min(...targets.map(n => n._y));
            targets.forEach(n => { n._y = clampDagCoordinate(minY); });
            break;
        }
        case 'bottom': {
            const maxY = Math.max(...targets.map(n => n._y));
            targets.forEach(n => { n._y = clampDagCoordinate(maxY); });
            break;
        }
        case 'horizontal_center': {
            const avgX = Math.round(targets.reduce((sum, n) => sum + n._x, 0) / targets.length);
            targets.forEach(n => { n._x = clampDagCoordinate(avgX); });
            break;
        }
        case 'vertical_center': {
            const avgY = Math.round(targets.reduce((sum, n) => sum + n._y, 0) / targets.length);
            targets.forEach(n => { n._y = clampDagCoordinate(avgY); });
            break;
        }
        case 'distribute_h': {
            targets.sort((a, b) => a._x - b._x);
            const firstX = targets[0]._x;
            const lastX = targets[targets.length - 1]._x;
            if (Math.abs(lastX - firstX) < 1) {
                targets.forEach((n, idx) => {
                    n._x = clampDagCoordinate(firstX + idx * (NODE_WIDTH + NODE_GAP_X));
                });
            } else {
                const step = (lastX - firstX) / (targets.length - 1);
                targets.forEach((n, idx) => {
                    n._x = clampDagCoordinate(Math.round(firstX + idx * step));
                });
            }
            break;
        }
        case 'distribute_v': {
            targets.sort((a, b) => a._y - b._y);
            const firstY = targets[0]._y;
            const lastY = targets[targets.length - 1]._y;
            if (Math.abs(lastY - firstY) < 1) {
                targets.forEach((n, idx) => {
                    n._y = clampDagCoordinate(firstY + idx * (NODE_HEIGHT + NODE_GAP_Y));
                });
            } else {
                const step = (lastY - firstY) / (targets.length - 1);
                targets.forEach((n, idx) => {
                    n._y = clampDagCoordinate(Math.round(firstY + idx * step));
                });
            }
            break;
        }
        default:
            return { changed: false, modifiedCount: 0 };
    }

    return { changed: true, modifiedCount: targets.length };
}

if (typeof window !== 'undefined' && window.Pivot?.registerModule) {
    window.Pivot.registerModule('agent.dagCore', {
        getUpstreamNodes,
        getAvailableVariableOptions,
        alignNodes
    });
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        SVG_NS,
        NODE_WIDTH,
        NODE_HEIGHT,
        NODE_GAP_X,
        NODE_GAP_Y,
        PADDING,
        DEFAULT_VIEW_SCALE,
        SCALE_MIN,
        SCALE_MAX,
        clampDagCoordinate,
        uniqueId,
        clampDependsOn,
        autoLayout,
        findAvailableNodePosition,
        placeNewNode,
        ensureDefaults,
        serialize,
        readJson,
        getUpstreamNodes,
        getAvailableVariableOptions,
        alignNodes
    };
}
