const fs = require('fs');
const path = require('path');
const os = require('os');
const { createWorkspaceJail, runSandboxedProcess } = require('./agent-sandbox');

function resolvePythonExecutable(value = '') {
    const configured = String(value || process.env.PIVOT_AGENT_PYTHON || '').trim();
    if (configured && !/[\\/]/.test(configured)) return configured;
    if (configured && fs.existsSync(configured)) return path.resolve(configured);
    const bundledCandidates = process.resourcesPath ? [
        path.join(process.resourcesPath, 'agent-runtime', 'python', process.platform === 'win32' ? 'python.exe' : 'bin/python3'),
        path.join(process.resourcesPath, 'agent-runtime', 'python', process.platform === 'win32' ? 'python.exe' : 'python3')
    ] : [];
    const bundled = bundledCandidates.find(candidate => candidate && fs.existsSync(candidate));
    if (bundled) return bundled;
    return process.platform === 'win32' ? 'python.exe' : 'python3';
}

function normalizePythonInput(value) {
    if (value === undefined) return {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Python Worker 输入必须是 JSON 对象。');
    return value;
}

async function runPythonScript({ script, input = {}, workspaceRoot, taskId = 'python', timeoutMs = 30000, pythonExecutable, strictIsolation = (process.env.PIVOT_AGENT_STRICT_ISOLATION === '1' || process.env.PIVOT_AGENT_STRICT_ISOLATION === 'true'), networkDisabled = true, memoryLimitBytes } = {}) {
    const source = String(script || '').trim();
    if (!source) throw new Error('Python Worker 脚本不能为空。');
    if (source.length > 256 * 1024) throw new Error('Python Worker 脚本超过 256KB 限制。');
    const root = path.resolve(String(workspaceRoot || path.join(os.tmpdir(), 'pivot-agent-python')));
    const jail = createWorkspaceJail(root, taskId);
    const scriptPath = jail.resolve('run.py');
    const inputPath = jail.resolve('input.json');
    fs.writeFileSync(scriptPath, source, { encoding: 'utf8', mode: 0o600 });
    fs.writeFileSync(inputPath, JSON.stringify(normalizePythonInput(input)), { encoding: 'utf8', mode: 0o600 });
    const executable = resolvePythonExecutable(pythonExecutable);
    const result = await runSandboxedProcess(executable, ['-I', scriptPath, '--pivot-input', inputPath], {
        jail,
        timeoutMs: Math.min(Math.max(Number(timeoutMs) || 30000, 100), 120000),
        strictIsolation,
        networkDisabled,
        memoryLimitBytes,
        env: { PIVOT_AGENT_WORKER: '1', PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1' }
    });
    return { ...result, executable, scriptPath, inputPath, jail: jail.metadata };
}

module.exports = { normalizePythonInput, resolvePythonExecutable, runPythonScript };
