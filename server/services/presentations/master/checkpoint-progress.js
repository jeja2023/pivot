'use strict';

const { failedObservation } = require('./observations');

const stages = ['direction', 'design', 'template'];
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;

function recordMaterialRead(material, observation) {
    if (failedObservation(observation)) {
        material.failedReads++;
        return;
    }
    const result = observation.result;
    if (!result || result.path !== material.path) return;
    material.reads++;
    const offset = result.offset;
    if (nonnegative(result.totalChars)) material.totalChars = result.totalChars;
    const end = nonnegative(result.nextOffset) ? result.nextOffset
        : result.nextOffset === null && nonnegative(result.totalChars) ? result.totalChars : undefined;
    if (nonnegative(offset) && nonnegative(end) && end >= offset) material.ranges.push([offset, end]);
}

function materialView(material) {
    let contiguous = 0;
    for (const [start, end] of material.ranges.sort((left, right) => left[0] - right[0])) {
        if (start > contiguous) break;
        contiguous = Math.max(contiguous, end);
    }
    const { title, saved, reads, failedReads, totalChars } = material;
    return { title, saved, reads, failedReads, contiguous,
        ...(nonnegative(totalChars) ? { totalChars } : {}),
        complete: material.ranges.length > 0 && nonnegative(totalChars) && contiguous >= totalChars };
}

function planView(stage, status, plan) {
    const summary = typeof plan?.summary === 'string' ? plan.summary.slice(0, 4000) : '';
    const pages = Array.isArray(plan?.pages) ? plan.pages.slice(0, 100).map(page => ({
        title: typeof page?.title === 'string' ? page.title.slice(0, 180) : '',
        values: Array.isArray(page?.values) ? page.values.slice(0, 8)
            .flatMap(value => typeof value?.text === 'string' && value.text ? [value.text.slice(0, 120)] : []) : []
    })) : [];
    return summary || pages.some(page => page.title) ? { stage, status, summary, pages } : null;
}

function checkpointProgressView(state, pending) {
    if (!state?.request) return undefined;
    const savedText = new Map((state.request.inputFiles || []).filter(file => file.kind === 'text').map(file => [file.path, file]));
    const materials = (state.request.materials || []).map((material, index) => ({
        path: material.path, title: (typeof material.title === 'string' && material.title || '材料 ' + (index + 1)).slice(0, 240),
        saved: savedText.has(material.path), reads: 0, failedReads: 0, ranges: []
    }));
    const byPath = new Map(materials.filter(material => material.saved).map(material => [material.path, material]));
    const latest = new Map();
    const messages = state.messages || [];
    for (let index = 0; index < messages.length; index++) {
        if (messages[index]?.role !== 'assistant') continue;
        let turn;
        try { turn = JSON.parse(messages[index].content); } catch (_) { continue; }
        const input = turn?.requestInput;
        if (input?.kind === 'confirmation' && stages.includes(input.stage)) latest.set(input.stage, input.plan);
        if (!Array.isArray(turn?.actions) || messages[index + 1]?.role !== 'user') continue;
        let results;
        try { results = JSON.parse(messages[index + 1].content); } catch (_) { continue; }
        if (!Array.isArray(results)) continue;
        turn.actions.forEach((action, position) => {
            const material = action?.action === 'read' && byPath.get(action.path);
            const observation = results[position];
            if (material && observation?.action === 'read') recordMaterialRead(material, observation);
        });
    }
    const plans = [];
    for (const stage of stages) {
        const approved = state.review?.approvals?.[stage]?.plan;
        if (approved) plans.push(planView(stage, 'approved', approved));
        if (pending?.stage === stage && !state.response) plans.push(planView(stage, 'pending', pending.plan));
        else if (stage === 'design' && state.citationDraft?.stage === stage) plans.push(planView(stage, 'citation_review', state.citationDraft.plan));
        else if (!approved && latest.has(stage)) plans.push(planView(stage, 'previous', latest.get(stage)));
    }
    return { requirementsLoaded: state.bootstrapped === true, materials: materials.map(materialView), plans: plans.filter(Boolean) };
}

module.exports = { checkpointProgressView };
