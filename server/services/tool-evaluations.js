'use strict';

const crypto = require('crypto');
const { query: selectMany, queryOne: selectOne, transaction } = require('../db/client');
const { getBeijingTimestamp } = require('../time');
const { formatToolList } = require('./agent-tool-catalog');

function evalId() { return `tooleval_${crypto.randomUUID().replace(/-/g, '')}`; }
function parseJson(value, fallback = []) { if (value && typeof value === 'object') return value; try { return JSON.parse(value || '') || fallback; } catch (_) { return fallback; } }

function normalizedExpected(value) {
    return [...new Set((Array.isArray(value) ? value : []).map(item => String(item || '').trim()).filter(Boolean))].slice(0, 20);
}

function terms(value) {
    const source = String(value || '').toLowerCase();
    const words = source.split(/[\s,，。；;、/\\|()[\]{}]+/).map(item => item.trim()).filter(item => item.length > 1);
    const cjkBigrams = [...source.matchAll(/[\u3400-\u9fff]{2,}/g)]
        .flatMap(match => Array.from(match[0]).map((_char, index, chars) => chars.slice(index, index + 2).join('')).filter(item => item.length === 2));
    return [...new Set([...words, ...cjkBigrams])];
}

function databaseApi(executor) {
    return {
        mutate: (...args) => executor.execute(...args)
    };
}

function rankToolsForPrompt(prompt, tools = []) {
    const queryTerms = terms(prompt);
    return (tools || []).map(tool => {
        const corpus = [tool.name, tool.title, tool.description, ...(tool.capabilities || [])].join(' ').toLowerCase();
        const matchedTerms = queryTerms.filter(term => corpus.includes(term));
        const exact = corpus.includes(String(prompt || '').toLowerCase()) ? 2 : 0;
        return { tool, score: matchedTerms.length + exact, matchedTerms };
    }).filter(item => item.score > 0).sort((left, right) => right.score - left.score || String(left.tool.name).localeCompare(String(right.tool.name)));
}

function scoreSelection(selected = [], expected = []) {
    const wanted = new Set(normalizedExpected(expected));
    if (!wanted.size) return { score: 1, top1: true, top3: true };
    const first = String(selected[0] || '');
    const top1 = wanted.has(first);
    const top3 = selected.slice(0, 3).some(item => wanted.has(String(item)));
    return { score: top1 ? 1 : top3 ? 0.7 : 0, top1, top3 };
}

async function createToolEvalSuite(user, input = {}) {
    const name = String(input.name || '').trim().slice(0, 255);
    if (!name) {
        const error = new Error('评测集名称不能为空。'); error.status = 400; throw error;
    }
    const now = getBeijingTimestamp();
    return await selectOne(`
        INSERT INTO tool_eval_suites (name, description, owner_user_id, status, created_at, updated_at)
        VALUES (?, ?, ?, 'active', ?, ?) RETURNING *
    `, [name, String(input.description || '').trim().slice(0, 4000), user.id, now, now]);
}

async function listToolEvalSuites(user) {
    return await selectMany('SELECT * FROM tool_eval_suites WHERE owner_user_id = ? OR owner_user_id IS NULL ORDER BY updated_at DESC, id DESC', [user.id]);
}

async function getToolEvalSuite(id, user) {
    return await selectOne('SELECT * FROM tool_eval_suites WHERE id = ? AND (owner_user_id = ? OR owner_user_id IS NULL)', [id, user.id]);
}

async function saveToolEvalCase(suiteId, user, input = {}) {
    const suite = await getToolEvalSuite(suiteId, user);
    if (!suite) return null;
    const name = String(input.name || '').trim().slice(0, 255);
    const prompt = String(input.prompt || '').trim().slice(0, 12000);
    const expected = normalizedExpected(input.expectedToolNames || input.expected_tool_names);
    if (!name || !prompt || !expected.length) {
        const error = new Error('评测用例需要名称、问题和至少一个期望工具。'); error.status = 400; throw error;
    }
    const now = getBeijingTimestamp();
    if (input.id) {
        return await selectOne(`
            UPDATE tool_eval_cases SET name = ?, prompt = ?, expected_tool_names = ?::jsonb, expected_outcome = ?::jsonb,
                tags = ?::jsonb, updated_at = ? WHERE id = ? AND suite_id = ? RETURNING *
        `, [name, prompt, JSON.stringify(expected), JSON.stringify(input.expectedOutcome || input.expected_outcome || {}), JSON.stringify(Array.isArray(input.tags) ? input.tags.slice(0, 30) : []), now, input.id, suite.id]);
    }
    return await selectOne(`
        INSERT INTO tool_eval_cases (suite_id, name, prompt, expected_tool_names, expected_outcome, tags, status, created_at, updated_at)
        VALUES (?, ?, ?, ?::jsonb, ?::jsonb, ?::jsonb, 'active', ?, ?) RETURNING *
    `, [suite.id, name, prompt, JSON.stringify(expected), JSON.stringify(input.expectedOutcome || input.expected_outcome || {}), JSON.stringify(Array.isArray(input.tags) ? input.tags.slice(0, 30) : []), now, now]);
}

async function listToolEvalCases(suiteId, user) {
    const suite = await getToolEvalSuite(suiteId, user);
    if (!suite) return null;
    const cases = await selectMany('SELECT * FROM tool_eval_cases WHERE suite_id = ? AND status = ? ORDER BY id ASC', [suite.id, 'active']);
    return cases.map(item => ({ ...item, expected_tool_names: parseJson(item.expected_tool_names, []), expected_outcome: parseJson(item.expected_outcome, {}), tags: parseJson(item.tags, []) }));
}

async function runToolEvaluation(suiteId, user, options = {}) {
    const suite = await getToolEvalSuite(suiteId, user);
    if (!suite) return null;
    const cases = await listToolEvalCases(suite.id, user);
    if (!cases?.length) {
        const error = new Error('评测集没有启用的评测用例。'); error.status = 409; throw error;
    }
    const toolList = await formatToolList(user, { toolPolicy: 'all' });
    const now = getBeijingTimestamp();
    const runId = evalId();
    const releaseId = Number(options.releaseId || options.release_id) || null;
    await transaction(async trx => {
        const db = databaseApi(trx);
        await db.mutate(`INSERT INTO tool_eval_runs (id, suite_id, release_id, status, summary, created_by, started_at, created_at) VALUES (?, ?, ?, 'running', '{}'::jsonb, ?, ?, ?)`, [runId, suite.id, releaseId, user.id, now, now]);
        const results = cases.map(item => {
            const ranked = rankToolsForPrompt(item.prompt, toolList);
            const selectedTools = ranked.slice(0, 3).map(entry => entry.tool.name);
            const selection = scoreSelection(selectedTools, item.expected_tool_names);
            return { item, selectedTools, selection, ranked };
        });
        for (const result of results) {
            await db.mutate(`INSERT INTO tool_eval_results (run_id, case_id, selected_tools, outcome, score, status, error_message, created_at) VALUES (?, ?, ?::jsonb, ?::jsonb, ?, ?, '', ?)`, [
                runId, result.item.id, JSON.stringify(result.selectedTools), JSON.stringify({ top1: result.selection.top1, top3: result.selection.top3, matchedTerms: result.ranked[0]?.matchedTerms || [] }), result.selection.score, result.selection.top3 ? 'passed' : 'failed', now
            ]);
        }
        const total = results.length;
        const top1Count = results.filter(item => item.selection.top1).length;
        const top3Count = results.filter(item => item.selection.top3).length;
        const passed = results.filter(item => item.selection.top3).length;
        const summary = { caseCount: total, passed, passRate: Math.round((passed / total) * 10000) / 100, top1Rate: Math.round((top1Count / total) * 10000) / 100, top3Rate: Math.round((top3Count / total) * 10000) / 100, toolCount: toolList.length, releaseId };
        await db.mutate("UPDATE tool_eval_runs SET status = 'completed', summary = ?::jsonb, completed_at = ? WHERE id = ?", [JSON.stringify(summary), now, runId]);
    });
    return await getToolEvalRun(runId, user);
}

async function getToolEvalRun(id, user) {
    const run = await selectOne(`SELECT r.*, s.owner_user_id FROM tool_eval_runs r JOIN tool_eval_suites s ON s.id = r.suite_id WHERE r.id = ? AND (s.owner_user_id = ? OR s.owner_user_id IS NULL)`, [id, user.id]);
    if (!run) return null;
    const results = await selectMany(`SELECT r.*, c.name AS case_name, c.prompt, c.expected_tool_names FROM tool_eval_results r JOIN tool_eval_cases c ON c.id = r.case_id WHERE r.run_id = ? ORDER BY r.id ASC`, [run.id]);
    return { run: { ...run, summary: parseJson(run.summary, {}) }, results: results.map(item => ({ ...item, selected_tools: parseJson(item.selected_tools, []), outcome: parseJson(item.outcome, {}), expected_tool_names: parseJson(item.expected_tool_names, []) })) };
}

module.exports = { createToolEvalSuite, getToolEvalRun, listToolEvalCases, listToolEvalSuites, rankToolsForPrompt, runToolEvaluation, saveToolEvalCase, scoreSelection };
