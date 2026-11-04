'use strict';
/* global window */

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

test('轮次显示区分本段与累计，过期快照和历史翻页不回退预算展示', { timeout: 60000 }, async () => {
    const app = express();
    app.use('/chat', express.static(path.resolve('client/chat')));
    app.get('/fixture.js', (_req, res) => res.type('js').send(`
        window.Pivot={exposeModule:(name,api)=>{window.stateApi=api;}};
        window.agentRunMetadata=run=>run.metadata||{}; window.agentStatusLabel=()=>'';
    `));
    app.get('/', (_req, res) => res.send('<!doctype html><meta charset="utf-8"><div id="label"></div><script src="/fixture.js"></script><script src="/chat/chat-task-state.js"></script><script src="/chat/agent-run-status-views.js"></script>'));
    const service = http.createServer(app);
    await new Promise(resolve => service.listen(0, '127.0.0.1', resolve));
    let browser;
    try {
        browser = await chromium.launch({ headless: true, executablePath: require('../server/services/agent-browser').resolveChromiumExecutable(chromium) });
        const page = await browser.newPage();
        await page.goto(`http://127.0.0.1:${service.address().port}/`);
        const result = await page.evaluate(() => {
            const state = window.stateApi.create('run', 'session');
            const run = { id: 'run', session_id: 'session', run_mode: 'standard', status: 'running', updated_at: '2026-11-04T12:00:00+08:00' };
            const progress = { totalRoundCount: 35, totalRoundLimit: 60, segmentRoundCount: 5, segmentRoundLimit: 30 };
            window.stateApi.applyFeed(state, { run, progress, cursor: { eventSeq: 10 }, events: [] });
            window.stateApi.applyFeed(state, { run: { ...run, updated_at: '2026-11-04T11:59:00+08:00' }, progress: { totalRoundCount: 2 }, cursor: { eventSeq: 9 }, events: [] });
            return window.agentRunFriendlySummary(state.run, state.progress);
        });
        assert.match(result, /本段已执行 5\/30 轮/);
        assert.match(result, /任务累计 35\/60 轮/);
        assert.doesNotMatch(result, /上限 30 轮/);
        await page.setViewportSize({ width: 390, height: 844 });
        assert.equal(await page.evaluate(() => window.agentRunFriendlySummary({ status: 'running', run_mode: 'dag' }, { stepCount: 5 })), '工作流正在运行，当前已有 5 条执行记录。');
    } finally {
        await browser?.close(); service.closeAllConnections?.();
        await new Promise(resolve => service.close(resolve));
    }
});
