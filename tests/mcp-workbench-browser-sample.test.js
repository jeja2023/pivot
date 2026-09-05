const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadWorkbenchApi(input) {
    let api = {};
    const sandbox = {
        URL,
        document: {
            getElementById(id) {
                if (id === 'mcp-tool-test-input') return input;
                return null;
            }
        },
        window: {
            Pivot: {
                legacy: {},
                exposeModule(_name, exposed) { api = exposed; },
                moduleApi() { return {}; }
            }
        }
    };
    vm.createContext(sandbox);
    const source = fs.readFileSync(path.join(__dirname, '..', 'client', 'chat', 'mcp-workbench-main.js'), 'utf8');
    vm.runInContext(source, sandbox, { filename: 'mcp-workbench-main.js' });
    return api;
}

test('浏览器工具单步测试样例使用当前授权 Origin 与匹配设备', () => {
    const input = { value: '' };
    const api = loadWorkbenchApi(input);

    api.fillMcpToolSampleInput('mcp.0.browser.open', {
        properties: { timeoutMs: { default: 45000 } },
        localBrowserDevices: [{
            deviceId: 'desktop-1',
            browsers: [{ id: 'edge-main', label: 'Microsoft Edge', engine: 'chromium' }],
            allowedOrigins: ['https://oa.example.internal']
        }]
    });

    assert.deepEqual(JSON.parse(input.value), {
        browserId: 'edge-main',
        url: 'https://oa.example.internal/',
        timeoutMs: 45000,
        deviceId: 'desktop-1'
    });
});
