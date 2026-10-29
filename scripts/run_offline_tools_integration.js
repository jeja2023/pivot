'use strict';
// 只创建本次测试拥有的隔离资源，既有容器、网络和业务数据库均不作为夹具。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { setTimeout: delay } = require('node:timers/promises');
const runFile = promisify(execFile);
const root = path.resolve(__dirname, '..');
const images = Object.freeze({ tools: 'pivot-offline-tools:1.0.0', kroki: 'yuzutech/kroki:0.28.0', mermaid: 'yuzutech/kroki-mermaid:0.28.0' });
async function command(file, args, options = {}) {
    try { return (await runFile(file, args, { cwd: root, windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024, ...options })).stdout.trim(); }
    catch (error) { throw new Error(`执行测试依赖失败：${path.basename(file)}；${error.killed ? '命令超时；' : ''}${String(error.stderr || error.message).slice(-1500)}`); }
}
const docker = (args, options) => command('docker', args, options);
async function pythonRuntime() {
    const candidates = [process.env.PIVOT_OFFLINE_TOOLS_PYTHON, path.join(root, '.tmp/offline-tools-venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'), process.platform === 'win32' ? 'python' : 'python3'].filter(Boolean);
    for (const candidate of candidates) {
        try {
            const value = await command(candidate, ['-c', 'import sys,json,importlib.metadata as m; import mcp,httpx,uvicorn; print(json.dumps({"executable":sys.executable,"versions":{p:m.version(p) for p in ("mcp","httpx","uvicorn")}}))']);
            return JSON.parse(value);
        } catch (_) { /* 候选运行时不可用时继续探测，不向外打印连接或凭据。 */ }
    }
    throw new Error('未找到含 mcp、httpx、uvicorn 的 Python 环境。请按 docker/offline-tools/requirements.lock 创建虚拟环境，并设置 PIVOT_OFFLINE_TOOLS_PYTHON。');
}
async function waitReady(container, url, requestTimeoutMs = 3000) {
    const script = `import urllib.request; response=urllib.request.urlopen(${JSON.stringify(url)},timeout=${requestTimeoutMs / 1000}); assert response.status==200`;
    const deadline = Date.now() + 150000;
    while (Date.now() < deadline) {
        try { await docker(['exec', container, 'python', '-c', script], { timeout: requestTimeoutMs + 10000 }); return; }
        catch (_) {
            const state = await docker(['inspect', '--format', '{{.State.Running}}', container]);
            if (state !== 'true') throw new Error(`隔离服务已退出：${container}，请检查容器日志。`);
            await delay(500);
        }
    }
    throw new Error(`隔离服务健康检查超时：${url}。`);
}
async function main() {
    const args = process.argv.slice(2);
    const imageArgs = args.filter(arg => arg.startsWith('--tools-image='));
    if (imageArgs.length > 1 || args.some(arg => arg !== '--all' && !arg.startsWith('--tools-image='))) {
        throw new Error('仅支持 --all 和 --tools-image=<本地镜像> 参数。');
    }
    const selectedImage = imageArgs[0]?.slice('--tools-image='.length);
    if (imageArgs.length && !selectedImage) throw new Error('必须提供本地工具镜像名称。');
    const selectedImages = { ...images, ...(selectedImage ? { tools: selectedImage } : {}) };
    const all = args.includes('--all');
    const prefix = `pivot-offline-test-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    const network = `${prefix}-network`;
    const containers = []; let networkCreated = false; let temporary;
    const report = { startedAt: new Date().toISOString(), scope: all ? 'all-node-tests' : 'offline-tools-integration', images: {}, cleanup: {} };
    let exitCode = 1;
    try {
        await docker(['info', '--format', '{{.OSType}}']).then(type => { if (type !== 'linux') throw new Error('离线绘图集成测试需要 Docker Linux 容器模式。'); });
        const python = await pythonRuntime(); report.python = python;
        await command(python.executable, ['-m', 'unittest', 'discover', '-s', 'tests/offline_tools', '-p', 'test_*.py']);
        console.log('离线工具 Python 回归通过。');
        for (const [name, reference] of Object.entries(selectedImages)) report.images[name] = { reference, id: await docker(['image', 'inspect', '--format', '{{.Id}}', reference]) };
        fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
        temporary = fs.mkdtempSync(path.join(root, '.tmp/offline-integration-'));
        const tokenFile = path.join(temporary, 'token'); fs.writeFileSync(tokenFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
        await docker(['network', 'create', '--internal', '--label', `pivot.test.owner=${prefix}`, network]); networkCreated = true;
        async function start(name, alias, image, extra = []) {
            const container = `${prefix}-${name}`; containers.push(container);
            await docker(['run', '--detach', '--pull=never', '--name', container, '--label', `pivot.test.owner=${prefix}`, '--network', network, '--network-alias', alias,
                '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=128', '--memory', name === 'tools' ? '512m' : '768m', '--cpus=2', ...extra, image], { timeout: 90000 });
            return container;
        }
        console.log('离线集成测试：启动独立内网中的绘图引擎和鉴权工具服务。');
        await start('mermaid', 'kroki-mermaid', report.images.mermaid.id);
        await start('kroki', 'kroki', report.images.kroki.id, ['--env', 'KROKI_MERMAID_HOST=kroki-mermaid', '--env', 'KROKI_SAFE_MODE=secure', '--env', 'KROKI_COMMAND_TIMEOUT=30s']);
        const tools = await start('tools', 'offline-tools', report.images.tools.id, ['--user', '1000:1000', '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=32m',
            ...(!selectedImage ? ['--mount', `type=bind,src=${path.join(root, 'docker/offline-tools')},dst=/opt/pivot-tools,readonly`] : []),
            '--mount', `type=bind,src=${tokenFile},dst=/run/secrets/offline_tools_token,readonly`]);
        await waitReady(tools, 'http://127.0.0.1:8501/health');
        await waitReady(tools, 'http://kroki:8000/health');
        // Mermaid 的健康端点会实际渲染样例并等待 Chromium，而 Kroki 自身的健康端点不会。
        await waitReady(tools, 'http://kroki-mermaid:8002/health', 60000);
        report.containerPython = JSON.parse(await docker(['exec', tools, 'python', '-c', 'import json,importlib.metadata as m; print(json.dumps({p:m.version(p) for p in ("mcp","httpx","uvicorn")}))']));
        report.container = tools; report.readyAt = new Date().toISOString();
        const files = all ? [] : ['tests/offline-tools-live.test.js', 'tests/offline-tools-docker.test.js'];
        console.log(all ? '离线依赖已就绪，执行启用两项外部依赖的完整 Node 回归。' : '离线依赖已就绪，执行真实 FastMCP、Mermaid 和 Graphviz 集成测试。');
        exitCode = await new Promise((resolve, reject) => {
            const child = spawn(process.execPath, [path.join(__dirname, 'run_node_tests.js'), ...files], { cwd: root, windowsHide: true, stdio: 'inherit', env: { ...process.env, PIVOT_OFFLINE_TOOLS_PYTHON: python.executable, PIVOT_OFFLINE_TOOLS_CONTAINER: tools } });
            child.once('error', reject); child.once('exit', code => resolve(Number.isInteger(code) ? code : 1));
        });
        report.testExitCode = exitCode;
    } catch (error) { report.error = error.message; console.error(error.message); }
    finally {
        for (const container of containers.reverse()) {
            try {
                const owner = await docker(['inspect', '--format', '{{index .Config.Labels "pivot.test.owner"}}', container]);
                if (owner !== prefix) throw new Error('容器归属校验失败，未执行移除。');
                await docker(['rm', '--force', container], { timeout: 90000 }); report.cleanup[container] = true;
            } catch (error) { report.cleanup[container] = false; report.cleanupError = error.message; exitCode = 1; }
        }
        if (networkCreated) {
            try { await docker(['network', 'rm', network]); report.cleanup.network = true; }
            catch (error) { report.cleanup.network = false; report.cleanupError = error.message; exitCode = 1; }
        }
        if (temporary) {
            // 只移除本次已知的秘密文件及空目录，不执行递归删除或处理其他工作区目录。
            try { fs.unlinkSync(path.join(temporary, 'token')); fs.rmdirSync(temporary); report.cleanup.secret = true; }
            catch (error) { report.cleanup.secret = false; report.cleanupError = error.message; exitCode = 1; }
        }
        report.completedAt = new Date().toISOString(); report.exitCode = exitCode;
        fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
        fs.writeFileSync(path.join(root, '.tmp/offline-tools-integration-report.json'), JSON.stringify(report, null, 2));
        console.log(exitCode === 0 ? '离线集成测试完成，本次容器、网络和临时密钥已清理。' : '离线集成测试未通过，依赖和清理摘要见 .tmp/offline-tools-integration-report.json。');
    }
    return exitCode;
}
main().then(code => { process.exitCode = code; }).catch(error => { console.error(error.message); process.exitCode = 1; });
