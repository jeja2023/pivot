'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

test('可见控制面合并并发刷新，隐藏时不发起请求', async () => {
    let exposed;
    let shown = true;
    let calls = 0;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const panel = { closest: () => shown ? null : {} };
    const context = {
        document: { hidden: false, getElementById: id => id === 'agent-inbox-panel' ? panel : null },
        window: { Pivot: { exposeModule(_name, value) { exposed = value; }, moduleApi() { return { async loadAgentControlPlane() { calls += 1; if (calls === 1) await gate; } }; } } },
        setTimeout, clearTimeout
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../client/chat/agent-control-plane-recovery.js'), 'utf8'), context);
    const first = exposed.refresh();
    await new Promise(resolve => setImmediate(resolve));
    const second = exposed.refresh();
    const third = exposed.refresh();
    assert.equal(calls, 1);
    release();
    await Promise.all([first, second, third]);
    assert.equal(calls, 2);
    shown = false;
    await exposed.refresh();
    assert.equal(calls, 2);
});
