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

function ensureDefaults(spec) {
        const nodes = Array.isArray(spec?.nodes) ? spec.nodes.map(n => ({
            id: String(n.id || '').trim() || 'node',
            title: String(n.title || n.id || '').trim() || '未命名',
            tool: String(n.tool || '').trim(),
            input: n.input && typeof n.input === 'object' ? n.input : {},
            dependsOn: Array.isArray(n.dependsOn) ? n.dependsOn.slice() : [],
            condition: ['always', 'success'].includes(n.condition) ? n.condition : 'success',
            retryLimit: Math.max(0, Math.min(Number.parseInt(n.retryLimit ?? n.retry_limit ?? 0, 10) || 0, 5)),
            timeoutMs: Math.max(0, Math.min(Number.parseInt(n.timeoutMs ?? n.timeout_ms ?? 0, 10) || 0, 600000)),
            onError: ['skip_dependents', 'continue', 'stop'].includes(String(n.onError || n.on_error || 'skip_dependents')) ? String(n.onError || n.on_error || 'skip_dependents') : 'skip_dependents',
            // 保留已有坐标，避免 autoLayout 丢失用户手动调整的位置
            _x: Number.isFinite(Number(n._x)) ? Number(n._x) : undefined,
            _y: Number.isFinite(Number(n._y)) ? Number(n._y) : undefined
        })) : [];
        if (!nodes.length) nodes.push(createDefaultLlmNode([]));
        nodes.forEach(ensureLlmNodeInput);
        clampDependsOn(nodes);
        // 只有在新节点缺少坐标时才自动布局
        const hasMissingCoords = nodes.some(n => n._x === undefined || n._y === undefined);
        if (hasMissingCoords) autoLayout(nodes);
        return { nodes };
    }

function serialize(spec) {
        return {
            nodes: spec.nodes.map(({ id, title, tool, input, dependsOn, condition, retryLimit, timeoutMs, onError, _x, _y }) => ({
                id,
                title,
                tool,
                input,
                dependsOn: [...(dependsOn || [])],
                condition,
                retryLimit: Number(retryLimit || 0),
                timeoutMs: Number(timeoutMs || 0),
                onError: onError || 'skip_dependents',
                // 保留坐标以便再次加载时恢复用户手动调整的布局
                _x: Number.isFinite(_x) ? _x : undefined,
                _y: Number.isFinite(_y) ? _y : undefined
            }))
        };
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

function createDefaultLlmNode(existingIds = []) {
        return {
            id: uniqueId(existingIds, 'llm'),
            title: '大模型处理',
            tool: 'agent.llm',
            input: defaultLlmInput(),
            dependsOn: [],
            condition: 'success',
            retryLimit: 0,
            timeoutMs: 0,
            onError: 'skip_dependents',
            _x: PADDING,
            _y: PADDING
        };
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
