const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('personal Agent first-use journey is backed by an editable profile and privacy-bounded events', () => {
    const client = read('client/chat/personal-agent-onboarding.js');
    const partial = read('client/chat/partials/workspaces/personal.html');
    const routes = read('server/routes/agent-control-plane.js');
    const service = read('server/services/agent-experience-events.js');
    assert.match(partial, /id="personal-agent-onboarding"/);
    assert.match(partial, /id="personal-quick-task-form"/);
    assert.match(partial, /type="submit">交给 Agent/);
    assert.match(client, /\/agents\/profile/);
    assert.match(client, /onboarding_completed/);
    assert.match(routes, /\/agents\/experience\/events/);
    assert.match(service, /SAFE_METADATA_KEYS/);
    assert.doesNotMatch(service, /metadata\.(prompt|content|attachment)/i);
});

test('memory, goal and delivery journeys retain a controlled confirmation and source boundary', () => {
    const memories = read('server/services/agent-memory-intents.js');
    const goals = read('server/services/agent-goals.js');
    const state = read('server/services/agent-runtime/run-state.js');
    const client = read('client/chat/agent-personal-experience.js');
    const harness = read('client/chat/agent-harness.js');
    assert.match(memories, /previewMemoryIntent/);
    assert.match(memories, /applyMemoryIntent/);
    assert.match(goals, /goalSnapshot/);
    assert.match(goals, /deliverGoalRunResult/);
    assert.match(state, /deliverGoalRunResult\(runId, targetStatus\)/);
    assert.match(client, /\/agents\/goals\/preview/);
    assert.match(harness, /channels\/deliveries\/.*\/retry/);
});

test('correction feedback can create a governed learning job and an auto-matched experience can be paused', () => {
    const feedback = read('server/services/agent-feedback.js');
    const routes = read('server/routes/agent-control-plane.js');
    const context = read('client/chat/agent-run-personal-context.js');
    const detail = read('client/chat/agent-run-detail.js');
    assert.match(feedback, /learning = await enqueueAgentLearningJob/);
    assert.match(routes, /\/agents\/runs\/:id\/skill-match\/pause/);
    assert.match(routes, /metadata\.learnedSkillAuto !== true/);
    assert.match(context, /skillContextMarkup/);
    assert.match(context, /data-agent-skill-match-pause/);
    assert.match(detail, /bindSkillMatchPause/);
    assert.match(context, /基于这次修正生成一条待确认的个人经验/);
});

test('historical session search is user-scoped, time-bounded, and carries a source reference', () => {
    const tools = read('server/services/agent-session-search.js');
    assert.match(tools, /input\.sessionId/);
    assert.match(tools, /input\.from/);
    assert.match(tools, /m\.user_id = \?/);
    assert.match(tools, /openUrl: `\/chat\?sessionId=/);
});
