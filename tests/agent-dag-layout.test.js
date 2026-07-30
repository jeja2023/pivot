const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const { normalizeDagSpec } = require('../server/services/agent-validators');
const { inferDagLlmRuntimeSettings } = require('../server/services/agent-runtime/dag-run-config');

function loadDagCore() {
    const source = fs.readFileSync(path.join(__dirname, '..', 'client', 'chat', 'dag-core.js'), 'utf8');
    const sandbox = {
        window: { PivotSafeHtml: null, _cachedAgentModels: [] },
        document: { getElementById: () => null },
        currentUser: null,
        Event: class Event {}
    };
    vm.createContext(sandbox);
    vm.runInContext(source, sandbox, { filename: 'dag-core.js' });
    return sandbox;
}

test('normalizeDagSpec preserves layout and selected primary LLM node', () => {
    const normalized = normalizeDagSpec({
        primaryLlmNodeId: 'llm_final',
        layout: {
            source: { x: 36.25, y: 44 },
            llm_first: { x: 310, y: 20 },
            llm_final: { x: 580, y: 120 }
        },
        nodes: [
            { id: 'source', tool: 'rag.search' },
            { id: 'llm_first', tool: 'agent.llm', input: { model: 'model-a', prompt: '{{goal}}' } },
            { id: 'llm_final', tool: 'agent.llm', input: { model: 'model-b', maxSteps: 31, prompt: '{{goal}}' } }
        ]
    });

    assert.deepEqual(normalized.layout, {
        source: { x: 36.25, y: 44 },
        llm_first: { x: 310, y: 20 },
        llm_final: { x: 580, y: 120 }
    });
    assert.equal(normalized.primaryLlmNodeId, 'llm_final');
    assert.deepEqual(inferDagLlmRuntimeSettings(normalized), { modelId: 'model-b', maxSteps: 31 });
});

test('DAG core migrates legacy coordinates and keeps layout separate from nodes', () => {
    const core = loadDagCore();
    const internal = core.ensureDefaults({
        primaryLlmNodeId: 'llm',
        nodes: [
            { id: 'source', tool: 'rag.search', input: {}, dependsOn: [], _x: 41, _y: 53 },
            {
                id: 'llm',
                tool: 'agent.llm',
                input: { model: 'model-a', prompt: '{{nodes.source.output}}' },
                dependsOn: ['source'],
                _x: 333,
                _y: 127
            }
        ]
    });
    const serialized = JSON.parse(JSON.stringify(core.serialize(internal)));

    assert.deepEqual(serialized.layout, {
        source: { x: 41, y: 53 },
        llm: { x: 333, y: 127 }
    });
    assert.equal(serialized.primaryLlmNodeId, 'llm');
    assert.equal(Object.hasOwn(serialized.nodes[0], '_x'), false);
    assert.equal(Object.hasOwn(serialized.nodes[0], '_y'), false);
});

test('incremental node placement leaves existing manual positions unchanged', () => {
    const core = loadDagCore();
    const internal = core.ensureDefaults({
        layout: {
            source: { x: 80, y: 90 },
            llm: { x: 420, y: 210 }
        },
        nodes: [
            { id: 'source', tool: 'rag.search', input: {}, dependsOn: [] },
            { id: 'llm', tool: 'agent.llm', input: { model: 'model-a', prompt: '{{goal}}' }, dependsOn: [] }
        ]
    });
    const before = internal.nodes.map(node => ({ id: node.id, x: node._x, y: node._y }));
    const added = { id: 'chart', tool: 'viz.build_chart', dependsOn: ['source'] };

    internal.nodes.push(added);
    core.placeNewNode(internal.nodes, added, 'source');

    assert.deepEqual(
        internal.nodes.slice(0, 2).map(node => ({ id: node.id, x: node._x, y: node._y })),
        before
    );
    assert.equal(added._x > internal.nodes[0]._x, true);
    assert.equal(Number.isFinite(added._y), true);

    const reloaded = core.ensureDefaults({
        layout: { source: { x: 80, y: 90 } },
        nodes: [
            { id: 'source', tool: 'rag.search', input: {}, dependsOn: [] },
            {
                id: 'llm',
                tool: 'agent.llm',
                input: { model: 'model-a', prompt: '{{nodes.source.output}}' },
                dependsOn: ['source']
            }
        ]
    });
    assert.deepEqual(
        { x: reloaded.nodes[0]._x, y: reloaded.nodes[0]._y },
        { x: 80, y: 90 }
    );
    assert.equal(reloaded.nodes[1]._x > reloaded.nodes[0]._x, true);
});

test('editor dependency rules are independent from canvas direction', () => {
    const editor = fs.readFileSync(path.join(__dirname, '..', 'client', 'chat', 'agents-dag-editor.js'), 'utf8');
    const interaction = fs.readFileSync(path.join(__dirname, '..', 'client', 'chat', 'dag-interaction.js'), 'utf8');

    assert.doesNotMatch(editor, /isForwardDependency/);
    assert.doesNotMatch(interaction, /isForwardDependency/);
    assert.match(editor, /!wouldCreateCycle\(candidate\.id, node\?\.id\)/);
    assert.match(interaction, /ctx\.wouldCreateCycle\(connecting\.fromId, targetId\)/);
});
