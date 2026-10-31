'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

const { withQpdfLease } = require('../../qpdf-workdir-lease');

const QPDF_TIMEOUT_MS = Math.min(Math.max(Number.parseInt(process.env.DOCUMENT_QPDF_TIMEOUT_MS || '120000', 10) || 120000, 5000), 10 * 60 * 1000);
const QPDF_MAX_LOG_BYTES = 64 * 1024;
let cachedHealth = null;
let cachedAt = 0;
let healthPending = null;

function engineError(message, code = 'QPDF_UNAVAILABLE', status = 503) {
    const error = new Error(message);
    error.code = code;
    error.status = status;
    return error;
}

function configuredQpdfCommand() {
    const configured = String(process.env.DOCUMENT_QPDF_PATH || '').trim();
    if (!configured) return process.platform === 'win32' ? 'qpdf.exe' : 'qpdf';
    if (!path.isAbsolute(configured)) throw engineError('DOCUMENT_QPDF_PATH 必须是 qpdf 可执行文件的绝对路径。', 'QPDF_INVALID_PATH');
    return configured;
}

function truncateLog(value) {
    return String(value || '').replace(/[\r\n]+/g, ' ').trim().slice(0, QPDF_MAX_LOG_BYTES);
}

async function getQpdfHealth({ refresh = false } = {}) {
    if (!refresh && cachedHealth && Date.now() - cachedAt < 60_000) return cachedHealth;
    if (healthPending) return healthPending;
    healthPending = (async () => {
        let command = '';
        try {
            command = configuredQpdfCommand();
            const result = await new Promise((resolve, reject) => execFile(command, ['--version'], {
                shell: false, windowsHide: true, timeout: 5000, encoding: 'utf8', maxBuffer: QPDF_MAX_LOG_BYTES
            }, (error, stdout, stderr) => error ? reject(error) : resolve(stdout || stderr)));
            const version = truncateLog(result);
            cachedHealth = /^qpdf\s+/i.test(version)
                ? { available: true, command, version }
                : { available: false, command: '', version: '', message: '未检测到可用的 qpdf CLI。' };
        } catch (error) {
            cachedHealth = { available: false, command: '', version: '', message: `未检测到可用的 qpdf CLI（${error.code || error.message || '配置异常'}）。` };
        }
        cachedAt = Date.now();
        return cachedHealth;
    })().finally(() => { healthPending = null; });
    return healthPending;
}

async function requireQpdf() {
    const health = await getQpdfHealth();
    if (!health.available) throw engineError('当前部署未安装 qpdf，无法处理加密 PDF、保护输出或执行 qpdf 结构优化。');
    return health;
}

async function isPdfEncrypted(sourcePath, { health = null, spawnProcess = spawn } = {}) {
    health = health || await getQpdfHealth();
    if (!health.available) return null;
    return new Promise(resolve => {
        let child;
        try {
            child = spawnProcess(health.command, ['--is-encrypted', sourcePath], {
                shell: false, windowsHide: true, stdio: 'ignore'
            });
        } catch (_) { resolve(null); return; }
        let settled = false;
        const finish = result => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(result);
        };
        const timer = setTimeout(() => { try { child.kill(); } catch (_) {} finish(null); }, 10_000);
        timer.unref?.();
        child.once('error', () => finish(null));
        child.once('close', code => finish(code === 0 ? true : code === 2 ? false : null));
    });
}

function runQpdf(command, args, { cwd = undefined, timeoutMs = QPDF_TIMEOUT_MS, stdinText = null, sensitiveOutput = false, signal = null } = {}) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(engineError('qpdf 临时目录租约已失效。', 'QPDF_LEASE_LOST', 503));
        const child = spawn(command, args, { cwd, shell: false, windowsHide: true, stdio: [stdinText === null ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
        let leaseLost = false;
        const abort = () => { leaseLost = true; try { child.kill(); } catch (_) {} };
        signal?.addEventListener('abort', abort, { once: true });
        if (child.stdin) {
            // 子进程可能在读取前退出；EPIPE 由 close 状态统一报告。
            child.stdin.on('error', () => {});
            child.stdin.end(stdinText);
        }
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        const append = (current, chunk) => (current.length >= QPDF_MAX_LOG_BYTES ? current : `${current}${chunk}`.slice(0, QPDF_MAX_LOG_BYTES));
        child.stdout.on('data', chunk => { stdout = append(stdout, chunk); });
        child.stderr.on('data', chunk => { stderr = append(stderr, chunk); });
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill();
        }, timeoutMs);
        child.once('error', error => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
            if (leaseLost) return reject(engineError('qpdf 临时目录租约已失效。', 'QPDF_LEASE_LOST', 503));
            reject(engineError(`qpdf 无法启动：${truncateLog(error.message)}`, 'QPDF_EXECUTION_FAILED'));
        });
        child.once('close', code => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
            if (leaseLost) return reject(engineError('qpdf 临时目录租约已失效。', 'QPDF_LEASE_LOST', 503));
            if (timedOut) return reject(engineError('qpdf 处理超时，未发布输出文件。', 'QPDF_TIMEOUT', 504));
            if (code !== 0) {
                const detail = truncateLog(stderr || stdout);
                const password = /password|encrypted/i.test(detail);
                const message = password ? 'PDF 密码不正确或无权访问该加密文件。'
                    : sensitiveOutput ? 'qpdf 处理失败，请检查 PDF 文件及处理参数。'
                        : `qpdf 处理失败${detail ? `：${detail}` : ''}`;
                return reject(engineError(message, password ? 'PDF_PASSWORD_INVALID' : 'QPDF_EXECUTION_FAILED', password ? 400 : 422));
            }
            resolve({ stdout: truncateLog(stdout), stderr: truncateLog(stderr) });
        });
    });
}

async function withQpdfWorkDir(userId, operation) {
    return withQpdfLease(operation);
}

async function writePasswordFile(directory, name, password) {
    const target = path.join(directory, `${name}-${crypto.randomUUID()}.txt`);
    // qpdf 的 --password-file 读取第一行；换行密码无法安全地通过该 CLI 传递。
    await fs.promises.writeFile(target, normalizePassword(password), { mode: 0o600 });
    return target;
}

function normalizePassword(password) {
    const value = String(password || '');
    if (!value || /[\r\n]/.test(value)) throw engineError('PDF 密码不能为空且不能包含换行符。', 'PDF_PASSWORD_INVALID', 400);
    return value;
}

async function decryptPdfToBuffer({ sourcePath, password, userId }) {
    const { command } = await requireQpdf();
    return withQpdfWorkDir(userId, async (directory, signal) => {
        const outputPath = path.join(directory, 'decrypted.pdf');
        await runQpdf(command, ['--password-file=-', '--decrypt', sourcePath, outputPath], { cwd: directory, stdinText: `${normalizePassword(password)}\n`, sensitiveOutput: true, signal });
        return fs.promises.readFile(outputPath);
    });
}

async function optimizePdf({ sourcePath, userId, password = '', optimizeImages = false, jpegQuality = 75 }) {
    const { command } = await requireQpdf();
    return withQpdfWorkDir(userId, async (directory, signal) => {
        const outputPath = path.join(directory, 'optimized.pdf');
        const args = ['--object-streams=generate', '--compress-streams=y', '--recompress-flate', '--linearize'];
        if (optimizeImages) {
            args.push('--optimize-images', `--jpeg-quality=${Math.min(Math.max(Number.parseInt(jpegQuality, 10) || 75, 1), 100)}`);
        }
        if (password) args.push('--password-file=-');
        args.push(sourcePath, outputPath);
        await runQpdf(command, args, { cwd: directory, stdinText: password ? `${normalizePassword(password)}\n` : null, sensitiveOutput: Boolean(password), signal });
        return fs.promises.readFile(outputPath);
    });
}

async function protectPdf({ sourcePath, userId, inputPassword = '', userPassword, ownerPassword, permissions = {} }) {
    const { command } = await requireQpdf();
    return withQpdfWorkDir(userId, async (directory, signal) => {
        const outputPath = path.join(directory, 'protected.pdf');
        const safeUser = String(userPassword || '');
        const safeOwner = String(ownerPassword || '');
        if (!safeUser || !safeOwner || /[\r\n]/.test(safeUser) || /[\r\n]/.test(safeOwner)) {
            throw engineError('保护密码不能为空且不能包含换行符。', 'OUTPUT_PASSWORD_REQUIRED', 400);
        }
        const print = permissions.print === false ? 'none' : 'full';
        const modify = permissions.modify === false ? 'none' : 'all';
        // qpdf 的加密参数为位置参数；hex-bytes 可安全传递以 -- 开头的密码，
        // 响应参数从 stdin 读取，避免输出密码写入临时文件或进程命令行。
        const response = [
            '--password-mode=hex-bytes',
            '--encrypt',
            Buffer.from(safeUser, 'utf8').toString('hex'),
            Buffer.from(safeOwner, 'utf8').toString('hex'),
            '256',
            `--print=${print}`,
            `--modify=${modify}`,
            '--'
        ].join('\n') + '\n';
        const args = [];
        // stdin 已用于选项；对已加密输入，qpdf 仍需单独的受限密码文件。
        if (inputPassword) args.push(`--password-file=${await writePasswordFile(directory, 'input-password', Buffer.from(normalizePassword(inputPassword), 'utf8').toString('hex'))}`);
        args.push('@-', sourcePath, outputPath);
        await runQpdf(command, args, { cwd: directory, stdinText: response, sensitiveOutput: true, signal });
        return fs.promises.readFile(outputPath);
    });
}

module.exports = {
    decryptPdfToBuffer,
    getQpdfHealth,
    isPdfEncrypted,
    optimizePdf,
    protectPdf,
    requireQpdf
};
