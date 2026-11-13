'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);
const compiler = process.env.PIVOT_TEST_NSIS_COMPILER;

test('实际 NSIS 安装检查只阻断目标目录进程，保留同名外部进程并安全处理引号和查询失败', { skip: process.platform !== 'win32' || !compiler, timeout: 240000 }, async t => {
    const tempBase = await fs.realpath(os.tmpdir());
    const root = await fs.mkdtemp(path.join(tempBase, 'pivot-nsis-guard-'));
    const target = path.join(root, "install'quoted"), sibling = `${target}-extra`;
    const children = [];
    const escape = value => value.replaceAll('$', '$$').replaceAll('"', '$\\"');
    async function start(directory, exitAfterMs = 0) {
        const file = path.join(directory, 'guard-probe.exe');
        try { await fs.access(file); }
        catch (error) { if (error.code !== 'ENOENT') throw error; await fs.copyFile(process.execPath, file); }
        const lifetime = exitAfterMs ? `setTimeout(()=>process.exit(0),${exitAfterMs})` : 'setInterval(()=>{},1000)';
        const child = spawn(file, ['-e', `process.stdout.write("ready");${lifetime}`], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        children.push(child);
        await new Promise((resolve, reject) => { child.once('error', reject); child.stdout.once('data', resolve); });
        return child;
    }
    async function stop(child) {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const ended = new Promise(resolve => child.once('exit', resolve)); child.kill(); await ended;
    }
    const installer = path.join(root, 'guard.exe'), source = path.join(root, 'guard.nsi');
    const invoke = async (environment = process.env, executable = installer, args = ['/S']) => {
        try { await execute(executable, args, { env: environment, windowsHide: true, timeout: 45000 }); return 0; }
        catch (error) { if (typeof error.code === 'number') return error.code; throw error; }
    };
    try {
        await fs.mkdir(target); await fs.mkdir(sibling);
        const guard = path.resolve(__dirname, '../desktop/installer-process-guard.nsh');
        await fs.writeFile(source, ['Unicode true', 'SilentInstall silent', 'RequestExecutionLevel user', '!define APP_EXECUTABLE_FILENAME "Pivot.exe"', `OutFile "${escape(installer)}"`, `InstallDir "${escape(target)}"`, `!include "${escape(guard)}"`,
            'Section', '!insertmacro customCheckAppRunning', 'SetOutPath "$INSTDIR"', 'FileOpen $1 "$INSTDIR\\accepted.txt" w', 'FileWrite $1 "passed"', 'FileClose $1', 'SectionEnd'].join('\n'));
        await execute(compiler, [source], { windowsHide: true, timeout: 45000 });
        const outside = await start(sibling);
        assert.equal(await invoke(), 0); assert.equal(outside.exitCode, null);
        const marker = path.join(target, 'accepted.txt'); assert.equal(await fs.readFile(marker, 'utf8'), 'passed');
        await fs.writeFile(marker, 'retained');
        const inside = await start(target);
        assert.equal(await invoke(), 1); assert.equal(inside.exitCode, null); assert.equal(outside.exitCode, null);
        assert.equal(await fs.readFile(marker, 'utf8'), 'retained');
        await stop(inside);
        const exiting = await start(target, 3000);
        assert.equal(await invoke(process.env, installer, ['/S', '--updated']), 0);
        assert.equal(exiting.exitCode, 0);
        assert.equal(outside.exitCode, null);
        assert.equal(await invoke({ ...process.env, SystemRoot: path.join(root, 'missing-system'), PSModulePath: path.join(root, 'missing-modules') }), 0);
        assert.equal(outside.exitCode, null); assert.equal(await fs.readFile(marker, 'utf8'), 'passed');
        const invalidInstaller = path.join(root, 'guard-invalid.exe');
        const invalidSource = path.join(root, 'guard-invalid.nsi');
        const script = await fs.readFile(source, 'utf8');
        await fs.writeFile(invalidSource, script.replace(escape(installer), escape(invalidInstaller)).replace(`InstallDir "${escape(target)}"`, `InstallDir "${escape(marker)}"`));
        await execute(compiler, [invalidSource], { windowsHide: true, timeout: 45000 });
        assert.equal(await invoke(process.env, invalidInstaller), 1);
        assert.equal(outside.exitCode, null); assert.equal(await fs.readFile(marker, 'utf8'), 'passed');
        const failedQueryGuard = path.join(root, 'failed-query.nsh');
        const failedQueryInstaller = path.join(root, 'guard-query-failed.exe');
        const failedQuerySource = path.join(root, 'guard-query-failed.nsi');
        const guardText = await fs.readFile(guard, 'utf8');
        assert.match(guardText, /CreateToolhelp32Snapshot\(i 2, i 0\)/);
        await fs.writeFile(failedQueryGuard, guardText.replace('CreateToolhelp32Snapshot(i 2, i 0)', 'CreateToolhelp32Snapshot(i 0x40000000, i 0)'));
        await fs.writeFile(failedQuerySource, script.replace(escape(installer), escape(failedQueryInstaller)).replace(escape(guard), escape(failedQueryGuard)));
        await execute(compiler, [failedQuerySource], { windowsHide: true, timeout: 45000 });
        await fs.writeFile(marker, 'retained');
        assert.equal(await invoke(process.env, failedQueryInstaller), 1);
        assert.equal(outside.exitCode, null); assert.equal(await fs.readFile(marker, 'utf8'), 'retained');
        assert.equal(await invoke(), 0); assert.equal(outside.exitCode, null);
        t.diagnostic(JSON.stringify({ quotedPath: true, siblingPrefixAndSameNamePreserved: true, runningTargetRejectedWithoutTermination: true, updateWaitsForNaturalExit: true, missingCimModulesSupported: true, nonDirectoryTargetClosed: true, queryFailureClosed: true, retryAfterTargetExit: true }));
    } finally {
        for (const child of children) await stop(child);
        assert.equal(path.dirname(root), tempBase); assert.match(path.basename(root), /^pivot-nsis-guard-[A-Za-z0-9]+$/);
        await fs.rm(root, { recursive: true, force: true });
    }
});
