const crypto = require('crypto');

const AGENT_STEP_CONTEXT_SCHEMA_VERSION = 1;

function stableValue(value, seen = new WeakSet()) {
    if (value === null || value === undefined) return value;
    if (typeof value !== 'object') return value;
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    if (Array.isArray(value)) return value.map(item => stableValue(item, seen));
    return Object.keys(value).sort().reduce((result, key) => {
        const item = value[key];
        if (item === undefined || typeof item === 'function') return result;
        result[key] = stableValue(item, seen);
        return result;
    }, {});
}

function hashValue(value) {
    return crypto.createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex');
}

function freezeDeep(value, seen = new WeakSet()) {
    if (!value || typeof value !== 'object' || seen.has(value)) return value;
    seen.add(value);
    Object.values(value).forEach(item => freezeDeep(item, seen));
    return Object.freeze(value);
}

function normalizeToolSnapshot(toolList = []) {
    return (Array.isArray(toolList) ? toolList : [])
        .map(tool => ({
            name: String(tool?.name || '').trim(),
            version: String(tool?.version || '1.0.0'),
            source: String(tool?.source || 'builtin'),
            capabilities: Array.isArray(tool?.capabilities) ? [...tool.capabilities].map(String).sort() : [],
            riskLevel: Number(tool?.risk_level ?? tool?.riskLevel ?? tool?.risk ?? 0) || 0,
            idempotent: Boolean(tool?.idempotent),
            sideEffect: Boolean(tool?.side_effect ?? tool?.sideEffect),
            concurrency: String(tool?.concurrency || (tool?.side_effect ?? tool?.sideEffect ? 'write' : 'read')),
            cancellable: tool?.cancellable === undefined ? !Boolean(tool?.side_effect ?? tool?.sideEffect) : Boolean(tool.cancellable),
            network: Boolean(tool?.network),
            approvalRequired: Boolean(tool?.approval_required ?? tool?.approvalRequired),
            inputSchema: tool?.input_schema || tool?.inputSchema || tool?.parameters || { type: 'object', properties: {} }
        }))
        .filter(tool => tool.name)
        .sort((left, right) => left.name.localeCompare(right.name));
}

function worldStateBody(worldState = {}) {
    const safe = worldState && typeof worldState === 'object' ? worldState : {};
    const { hash: _hash, ...body } = safe;
    return body;
}

function diffWorldState(previous, current, path = '', changes = []) {
    if (Object.is(previous, current)) return changes;
    const previousObject = previous && typeof previous === 'object' && !Array.isArray(previous);
    const currentObject = current && typeof current === 'object' && !Array.isArray(current);
    if (!previousObject || !currentObject) {
        changes.push({ op: 'replace', path: path || '/', value: current });
        return changes;
    }
    const keys = [...new Set([...Object.keys(previous), ...Object.keys(current)])].sort();
    for (const key of keys) {
        const childPath = `${path}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`;
        if (!(key in current)) changes.push({ op: 'remove', path: childPath });
        else if (!(key in previous)) changes.push({ op: 'add', path: childPath, value: current[key] });
        else diffWorldState(previous[key], current[key], childPath, changes);
    }
    return changes;
}

function buildWorldStateInjection(worldState = {}, previousWorldState = null, options = {}) {
    const current = worldState && typeof worldState === 'object' ? worldState : {};
    const currentHash = String(current.hash || hashValue(worldStateBody(current)));
    const previousHash = String(previousWorldState?.hash || previousWorldState?.worldStateHash || '');
    const fullBody = worldStateBody(current);
    if (options.forceFull || !previousHash || !previousWorldState) {
        return {
            mode: 'full',
            baseHash: '',
            hash: currentHash,
            patch: [],
            state: fullBody
        };
    }
    if (previousHash === currentHash) {
        return { mode: 'reference', baseHash: previousHash, hash: currentHash, patch: [], state: null };
    }
    const patch = diffWorldState(worldStateBody(previousWorldState), fullBody);
    const fullSize = JSON.stringify(fullBody).length;
    const patchSize = JSON.stringify(patch).length;
    if (patch.length > 96 || patchSize >= Math.floor(fullSize * 0.8)) {
        return { mode: 'full', baseHash: previousHash, hash: currentHash, patch: [], state: fullBody };
    }
    return { mode: 'diff', baseHash: previousHash, hash: currentHash, patch, state: null };
}

function buildWorldState({ run = {}, modelCfg = null, toolList = [], contextConfig = {}, resumeContext = {}, environment = {}, memory = {} } = {}) {
    const metadata = typeof run.metadata === 'string' ? (() => {
        try { return JSON.parse(run.metadata); } catch (_) { return {}; }
    })() : (run.metadata && typeof run.metadata === 'object' ? run.metadata : {});
    const state = {
        schemaVersion: 1,
        run: {
            id: String(run.id || ''),
            mode: String(run.run_mode || run.runMode || 'standard'),
            goal: String(run.goal || ''),
            policy: String(run.tool_policy || run.toolPolicy || 'all'),
            allowlist: Array.isArray(run.tool_allowlist) ? [...run.tool_allowlist].map(String).sort() : [],
            approvalPolicy: String(run.approval_policy || run.approvalPolicy || 'safe_mcp_auto'),
            networkPolicy: run.network_policy || run.networkPolicy || {},
            budgetConfig: run.budget_config || run.budgetConfig || {}
        },
        model: modelCfg ? {
            id: modelCfg.id ?? null,
            name: String(modelCfg.name || modelCfg.model_name || ''),
            modelName: String(modelCfg.model_name || ''),
            contextWindow: Number(modelCfg.context_window || modelCfg.max_input_tokens || 0) || 0
        } : null,
        tools: normalizeToolSnapshot(toolList),
        context: contextConfig && typeof contextConfig === 'object' ? contextConfig : {},
        environment: environment && typeof environment === 'object' ? environment : {},
        memory: memory && typeof memory === 'object' ? memory : {},
        resume: resumeContext && typeof resumeContext === 'object' ? {
            sourceRunId: String(resumeContext.sourceRunId || ''),
            latestCheckpointId: String(resumeContext.latestCheckpointId || ''),
            latestStepIndex: Number(resumeContext.latestStepIndex || 0) || 0
        } : {},
        // Metadata is deliberately limited to non-secret, routing-relevant fields.
        extensions: {
            skillId: String(metadata.skillId || ''),
            skillVersion: String(metadata.skillVersion || ''),
            workflowId: metadata.workflowId ?? null,
            workflowVersion: metadata.workflowVersion ?? null
        }
    };
    const canonical = stableValue(state);
    return { ...canonical, hash: hashValue(canonical) };
}

function normalizeEntrypoint(value, fallback = 'agent') {
    const entrypoint = String(value || '').trim().toLowerCase();
    return ['chat', 'agent', 'desktop'].includes(entrypoint) ? entrypoint : fallback;
}

function serializeAgentStepContext(context = {}) {
    const safe = context && typeof context === 'object' ? context : {};
    const injection = safe.worldStateInjection && typeof safe.worldStateInjection === 'object'
        ? safe.worldStateInjection
        : {};
    return stableValue({
        schemaVersion: AGENT_STEP_CONTEXT_SCHEMA_VERSION,
        entrypoint: normalizeEntrypoint(safe.entrypoint),
        runId: String(safe.runId || ''),
        turnId: String(safe.turnId || ''),
        stepIndex: Math.max(Number(safe.stepIndex) || 0, 0),
        contextHash: String(safe.contextHash || ''),
        worldStateHash: String(safe.worldStateHash || ''),
        worldStateMode: String(safe.worldStateMode || injection.mode || 'full'),
        previousWorldStateHash: String(safe.previousWorldStateHash || injection.baseHash || ''),
        worldStateWindow: stableValue(safe.worldStateWindow || {}),
        policy: stableValue(safe.policy || {}),
        approval: stableValue(safe.approval || {}),
        sandbox: stableValue(safe.sandbox || {})
    });
}

function buildAgentAuditFields(context = {}, { entrypoint = '', purpose = '', extra = {} } = {}) {
    const serialized = serializeAgentStepContext({ ...context, entrypoint: entrypoint || context.entrypoint });
    return {
        schemaVersion: AGENT_STEP_CONTEXT_SCHEMA_VERSION,
        entrypoint: serialized.entrypoint,
        turnId: serialized.turnId,
        stepIndex: serialized.stepIndex,
        contextHash: serialized.contextHash,
        worldStateHash: serialized.worldStateHash,
        worldStateMode: serialized.worldStateMode,
        previousWorldStateHash: serialized.previousWorldStateHash,
        contextWindow: serialized.worldStateWindow,
        policy: serialized.policy,
        approval: serialized.approval,
        sandbox: serialized.sandbox,
        context: serialized,
        ...(purpose ? { purpose: String(purpose) } : {}),
        ...(extra && typeof extra === 'object' ? extra : {})
    };
}

function createAgentStepContext({ run = {}, entrypoint = '', turnId = '', stepIndex = 0, modelCfg = null, toolList = [], worldState = null, previousWorldState = null, forceWorldStateFull = false, worldStateWindow = null, policy = {}, approval = {}, sandbox = {}, signal = null, deadline = 0, contextConfig = {}, resumeContext = {}, environment = {}, memory = {} } = {}) {
    const resolvedWorldState = worldState || buildWorldState({ run, modelCfg, toolList, contextConfig, resumeContext, environment, memory });
    const worldStateInjection = buildWorldStateInjection(resolvedWorldState, previousWorldState, { forceFull: forceWorldStateFull });
    const snapshot = {
        schemaVersion: AGENT_STEP_CONTEXT_SCHEMA_VERSION,
        entrypoint: normalizeEntrypoint(entrypoint || environment?.entrypoint || contextConfig?.entrypoint || run?.metadata?.entrypoint),
        runId: String(run.id || ''),
        turnId: String(turnId || `${run.id || 'run'}:turn:${Number(stepIndex) || 0}`),
        stepIndex: Math.max(Number(stepIndex) || 0, 0),
        model: resolvedWorldState.model,
        worldStateHash: resolvedWorldState.hash,
        worldState: resolvedWorldState,
        worldStateInjection,
        previousWorldStateHash: worldStateInjection.baseHash || '',
        worldStateWindow: stableValue(worldStateWindow || {}),
        policy: stableValue(policy || {}),
        approval: stableValue(approval || {}),
        sandbox: stableValue(sandbox || {}),
        deadline: Number(deadline) || 0,
        signalAborted: Boolean(signal?.aborted)
    };
    const context = { ...snapshot, contextHash: hashValue(snapshot) };
    return freezeDeep(context);
}

function buildWorldStatePrompt(worldState = {}, options = {}) {
    const safe = worldState && typeof worldState === 'object' ? worldState : {};
    const injection = options.injection || buildWorldStateInjection(safe, options.previousWorldState, { forceFull: options.forceFull });
    const payload = injection.mode === 'diff'
        ? { mode: 'diff', baseHash: injection.baseHash, hash: injection.hash, patch: injection.patch }
        : injection.mode === 'reference'
            ? { mode: 'reference', baseHash: injection.baseHash, hash: injection.hash }
            : { mode: 'full', baseHash: injection.baseHash || '', hash: injection.hash, state: injection.state || worldStateBody(safe) };
    return [
        'PIVOT_WORLD_STATE_BEGIN',
        JSON.stringify({ schemaVersion: safe.schemaVersion || 1, ...payload }),
        'PIVOT_WORLD_STATE_END'
    ].join('\n');
}

module.exports = {
    AGENT_STEP_CONTEXT_SCHEMA_VERSION,
    buildAgentAuditFields,
    buildWorldStatePrompt,
    buildWorldStateInjection,
    buildWorldState,
    createAgentStepContext,
    diffWorldState,
    freezeDeep,
    hashValue,
    normalizeToolSnapshot,
    normalizeEntrypoint,
    serializeAgentStepContext,
    stableValue
};
