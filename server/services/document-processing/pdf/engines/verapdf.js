'use strict';

const { spawnSync, spawn } = require('child_process');
const path = require('path');

const MAX_REPORT_BYTES = 1024 * 1024;
let cachedHealth = null;
let cachedAt = 0;

function commandForVeraPdf() {
    const configured = String(process.env.DOCUMENT_VERAPDF_PATH || '').trim();
    if (!configured) return process.platform === 'win32' ? 'verapdf.bat' : 'verapdf';
    if (!path.isAbsolute(configured)) throw new Error('DOCUMENT_VERAPDF_PATH 必须是 veraPDF 可执行文件的绝对路径。');
    return configured;
}

function commandInvocation(command, args) {
    if (process.platform !== 'win32' || path.extname(command).toLowerCase() !== '.bat') return { command, args };
    // Windows 不能安全地由 Node 直接 exec .bat。复用官方批处理文件中的 JVM
    // 启动契约，避免 shell 解释输入路径或 PDF 参数。
    const base = path.dirname(command);
    const repository = path.join(base, 'bin');
    return {
        command: 'java.exe',
        args: [
            '-classpath', `${path.join(base, 'etc')};${path.join(repository, '*')}`,
            '-Dfile.encoding=UTF8',
            '-XX:+IgnoreUnrecognizedVMOptions',
            '-Dapp.name=VeraPDF validation CLI',
            `-Dapp.repo=${repository}`,
            `-Dapp.home=${base}`,
            `-Dbasedir=${base}`,
            '--add-exports=java.base/sun.security.pkcs=ALL-UNNAMED',
            'org.verapdf.apps.GreenfieldCliWrapper',
            ...args
        ]
    };
}

function getVeraPdfHealth({ refresh = false } = {}) {
    if (!refresh && cachedHealth && Date.now() - cachedAt < 60_000) return cachedHealth;
    let command = '';
    try {
        command = commandForVeraPdf();
        const invocation = commandInvocation(command, ['--version']);
        const result = spawnSync(invocation.command, invocation.args, { shell: false, windowsHide: true, timeout: 5000, encoding: 'utf8' });
        const version = String(result.stdout || result.stderr || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 300);
        if (result.status === 0 && version) {
            cachedHealth = { available: true, command, version };
        } else {
            const detail = result.error
                ? (result.error.code || result.error.message)
                : (result.stderr ? String(result.stderr).slice(0, 200) : (result.status !== null ? `退出码 ${result.status}` : '命令未响应'));
            cachedHealth = { available: false, command: '', version: '', message: `未检测到可用的 veraPDF CLI（命令: ${invocation.command}，原因: ${detail}）。` };
        }
    } catch (error) {
        cachedHealth = { available: false, command: '', version: '', message: `未检测到可用的 veraPDF CLI（${error.message || '配置异常'}）。` };
    }
    cachedAt = Date.now();
    return cachedHealth;
}

function runVeraPdf(command, args) {
    return new Promise((resolve, reject) => {
        const invocation = commandInvocation(command, args);
        const child = spawn(invocation.command, invocation.args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', chunk => { if (stdout.length < MAX_REPORT_BYTES) stdout = `${stdout}${chunk}`.slice(0, MAX_REPORT_BYTES); });
        child.stderr.on('data', chunk => { if (stderr.length < MAX_REPORT_BYTES) stderr = `${stderr}${chunk}`.slice(0, MAX_REPORT_BYTES); });
        child.once('error', error => reject(error));
        child.once('close', code => {
            // veraPDF 会以非零退出码表示非合规；报告仍然是有效验收证据。
            if (!stdout.trim() && code !== 0) return reject(new Error(String(stderr || 'veraPDF 无法生成验证报告。').slice(0, 500)));
            resolve({ report: stdout, diagnostics: stderr, exitCode: code });
        });
    });
}

async function validatePdfA({ sourcePath, flavour = '0' }) {
    const health = getVeraPdfHealth();
    if (!health.available) {
        const error = new Error('当前部署未安装 veraPDF，无法验证 PDF/A 合规性。');
        error.code = 'VERAPDF_UNAVAILABLE';
        error.status = 503;
        throw error;
    }
    const allowedFlavours = new Set(['0', '1a', '1b', '2a', '2b', '2u', '3a', '3b', '3u', '4', '4e', '4f']);
    const selected = allowedFlavours.has(String(flavour || '0').toLowerCase()) ? String(flavour || '0').toLowerCase() : '0';
    const result = await runVeraPdf(health.command, ['--format', 'xml', '--flavour', selected, sourcePath]);
    const compliant = /<validationReport\b[^>]*\bisCompliant="true"/i.test(result.report);
    return { ...result, flavour: selected, compliant, engine: health.version };
}

module.exports = { getVeraPdfHealth, validatePdfA };
