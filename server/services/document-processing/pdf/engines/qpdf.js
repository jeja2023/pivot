'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const { ensureDocumentProcessingDirs, tempRoot } = require('../../paths');

const QPDF_TIMEOUT_MS = Math.min(Math.max(Number.parseInt(process.env.DOCUMENT_QPDF_TIMEOUT_MS || '120000', 10) || 120000, 5000), 10 * 60 * 1000);
const QPDF_MAX_LOG_BYTES = 64 * 1024;
let cachedHealth = null;
let cachedAt = 0;

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

function getQpdfHealth({ refresh = false } = {}) {
    if (!refresh && cachedHealth && Date.now() - cachedAt < 60_000) return cachedHealth;
    let command = '';
    try {
        command = configuredQpdfCommand();
        const result = spawnSync(command, ['--version'], {
            shell: false,
            windowsHide: true,
            timeout: 5000,
            encoding: 'utf8'
        });
        const version = truncateLog(result.stdout || result.stderr);
        if (result.status === 0 && /^qpdf\s+/i.test(version)) {
            cachedHealth = { available: true, command, version };
        } else {
            const detail = result.error
                ? (result.error.code || result.error.message)
                : (result.stderr ? truncateLog(result.stderr) : (result.status !== null ? `退出码 ${result.status}` : '命令未响应'));
            cachedHealth = { available: false, command: '', version: '', message: `未检测到可用的 qpdf CLI（命令: ${command}，原因: ${detail}）。` };
        }
    } catch (error) {
        cachedHealth = { available: false, command: '', version: '', message: `未检测到可用的 qpdf CLI（${error.message || '配置异常'}）。` };
    }
    cachedAt = Date.now();
    return cachedHealth;
}

function requireQpdf() {
    const health = getQpdfHealth();
    if (!health.available) throw engineError('当前部署未安装 qpdf，无法处理加密 PDF、保护输出或执行 qpdf 结构优化。');
    return health;
}

function isPdfEncrypted(sourcePath) {
    const health = getQpdfHealth();
    if (!health.available) return null;
    const result = spawnSync(health.command, ['--is-encrypted', sourcePath], {
        shell: false,
        windowsHide: true,
        timeout: 10_000,
        encoding: 'utf8'
    });
    if (result.status === 0) return true;
    if (result.status === 2) return false;
    return null;
}

function runQpdf(command, args, { cwd = undefined, timeoutMs = QPDF_TIMEOUT_MS } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
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
            reject(engineError(`qpdf 无法启动：${truncateLog(error.message)}`, 'QPDF_EXECUTION_FAILED'));
        });
        child.once('close', code => {
            clearTimeout(timer);
            if (timedOut) return reject(engineError('qpdf 处理超时，未发布输出文件。', 'QPDF_TIMEOUT', 504));
            if (code !== 0) {
                const detail = truncateLog(stderr || stdout);
                const password = /password|encrypted/i.test(detail);
                return reject(engineError(password ? 'PDF 密码不正确或无权访问该加密文件。' : `qpdf 处理失败${detail ? `：${detail}` : ''}`, password ? 'PDF_PASSWORD_INVALID' : 'QPDF_EXECUTION_FAILED', password ? 400 : 422));
            }
            resolve({ stdout: truncateLog(stdout), stderr: truncateLog(stderr) });
        });
    });
}

async function makeWorkDir(userId) {
    await ensureDocumentProcessingDirs();
    return fs.promises.mkdtemp(path.join(tempRoot, `${Number.parseInt(userId, 10) || 'system'}-qpdf-`));
}

async function withQpdfWorkDir(userId, operation) {
    const directory = await makeWorkDir(userId);
    try {
        return await operation(directory);
    } finally {
        await fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
    }
}

async function writePasswordFile(directory, name, password) {
    const target = path.join(directory, `${name}-${crypto.randomUUID()}.txt`);
    // qpdf 的 --password-file 读取第一行；换行密码无法安全地通过该 CLI 传递。
    const value = String(password || '');
    if (!value || /[\r\n]/.test(value)) throw engineError('PDF 密码不能为空且不能包含换行符。', 'PDF_PASSWORD_INVALID', 400);
    await fs.promises.writeFile(target, value, { mode: 0o600 });
    return target;
}

async function decryptPdfToBuffer({ sourcePath, password, userId }) {
    const { command } = requireQpdf();
    return withQpdfWorkDir(userId, async directory => {
        const passwordFile = await writePasswordFile(directory, 'input-password', password);
        const outputPath = path.join(directory, 'decrypted.pdf');
        await runQpdf(command, [`--password-file=${passwordFile}`, '--decrypt', sourcePath, outputPath], { cwd: directory });
        return fs.promises.readFile(outputPath);
    });
}

async function optimizePdf({ sourcePath, userId, password = '', optimizeImages = false, jpegQuality = 75 }) {
    const { command } = requireQpdf();
    return withQpdfWorkDir(userId, async directory => {
        const outputPath = path.join(directory, 'optimized.pdf');
        const args = ['--object-streams=generate', '--compress-streams=y', '--recompress-flate', '--linearize'];
        if (optimizeImages) {
            args.push('--optimize-images', `--jpeg-quality=${Math.min(Math.max(Number.parseInt(jpegQuality, 10) || 75, 1), 100)}`);
        }
        if (password) args.push(`--password-file=${await writePasswordFile(directory, 'input-password', password)}`);
        args.push(sourcePath, outputPath);
        await runQpdf(command, args, { cwd: directory });
        return fs.promises.readFile(outputPath);
    });
}

async function protectPdf({ sourcePath, userId, inputPassword = '', userPassword, ownerPassword, permissions = {} }) {
    const { command } = requireQpdf();
    return withQpdfWorkDir(userId, async directory => {
        const outputPath = path.join(directory, 'protected.pdf');
        const responsePath = path.join(directory, 'encryption-options.txt');
        const safeUser = String(userPassword || '');
        const safeOwner = String(ownerPassword || '');
        if (!safeUser || !safeOwner || /[\r\n]/.test(safeUser) || /[\r\n]/.test(safeOwner)) {
            throw engineError('保护密码不能为空且不能包含换行符。', 'OUTPUT_PASSWORD_REQUIRED', 400);
        }
        const print = permissions.print === false ? 'none' : 'full';
        const modify = permissions.modify === false ? 'none' : 'all';
        await fs.promises.writeFile(responsePath, [
            '--encrypt',
            `--user-password=${safeUser}`,
            `--owner-password=${safeOwner}`,
            '--bits=256',
            `--print=${print}`,
            `--modify=${modify}`,
            '--'
        ].join('\n'), { mode: 0o600 });
        const args = [];
        if (inputPassword) args.push(`--password-file=${await writePasswordFile(directory, 'input-password', inputPassword)}`);
        args.push(`@${responsePath}`, sourcePath, outputPath);
        await runQpdf(command, args, { cwd: directory });
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
