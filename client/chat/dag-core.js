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

const dagEscapeHtml = (window.PivotSafeHtml && window.PivotSafeHtml.escapeHtml)
        || ((value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));

const dagEscapeAttr = (window.PivotSafeHtml && window.PivotSafeHtml.escapeAttr)
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
            _x: Number.isFinite(Number(savedLayout[n.id]?.x ?? n._x)) ? Number(savedLayout[n.id]?.x ?? n._x) : undefined,
            _y: Number.isFinite(Number(savedLayout[n.id]?.y ?? n._y)) ? Number(savedLayout[n.id]?.y ?? n._y) : undefined
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
            .map(node => [node.id, { x: Math.max(0, node._x), y: Math.max(0, node._y) }]));
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
        const canSelectModel = typeof window.isSelectableModelForCurrentUser === 'function'
            ? window.isSelectableModelForCurrentUser
            : (model => !model?.user_id || String(model.user_id) === String(currentUser?.id));
        return (Array.isArray(window._cachedAgentModels) ? window._cachedAgentModels : [])
            .filter(model => model.type !== 'embedding' && canSelectModel(model));
    }

function defaultWorkflowModelId() {
        const models = workflowModelOptions();
        const selectedId = String(
            document.getElementById('model-selector')?.value
            || document.getElementById('agent-model-select')?.value
            || ''
        ).trim();
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
