const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = Number.parseInt(process.env.PIVOT_UPDATER_PORT || '3300', 10);
const TOKEN = String(process.env.PIVOT_UPDATER_TOKEN || '').trim();
const REPO = String(process.env.PIVOT_UPDATE_REPO || '').trim();
const BRANCH = String(process.env.PIVOT_UPDATE_BRANCH || 'main').trim();
const WORKDIR = path.resolve(process.env.PIVOT_UPDATE_WORKDIR || '/workspace/source');
const COMPOSE_FILE = path.resolve(process.env.PIVOT_UPDATE_COMPOSE_FILE || '/workspace/docker-compose.yml');
const IMAGE = String(process.env.PIVOT_UPDATE_IMAGE || 'pivot').trim();
const SERVICE = String(process.env.PIVOT_UPDATE_SERVICE || 'pivot').trim();
const BUILD_CONTEXT = path.resolve(process.env.PIVOT_UPDATE_BUILD_CONTEXT || WORKDIR);
const STATE_FILE = path.resolve(process.env.PIVOT_UPDATE_STATE_FILE || '/workspace/updater-state.json');
const DOCKER_BIN = process.env.PIVOT_DOCKER_BIN || 'docker';
const GIT_BIN = process.env.PIVOT_GIT_BIN || 'git';

let running = false;
let state = loadState();

function nowIso() {
    return new Date().toISOString();
}

function loadState() {
    try {
        return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    } catch (e) {
        return {
            status: 'idle',
            step: '等待操作',
            logs: [],
            updatedAt: nowIso()
        };
    }
}

function saveState() {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function setState(patch) {
    state = {
        ...state,
        ...patch,
        updatedAt: nowIso()
    };
    if (!Array.isArray(state.logs)) state.logs = [];
    state.logs = state.logs.slice(-300);
    saveState();
}

function log(line) {
    const text = `[${nowIso()}] ${line}`;
    state.logs = [...(state.logs || []), text].slice(-300);
    state.updatedAt = nowIso();
    saveState();
}

function redact(value) {
    return String(value || '')
        .replace(TOKEN, TOKEN ? '***' : '')
        .replace(/(https?:\/\/)([^@\s]+)@/g, '$1***@');
}

function requireAuth(req, res, next) {
    if (!TOKEN || TOKEN.length < 32) return res.status(503).json({ error: 'PIVOT_UPDATER_TOKEN 未配置或长度不足 32 位' });
    const header = req.headers.authorization || '';
    const value = header.startsWith('Bearer ') ? header.slice(7) : '';
    const a = Buffer.from(value);
    const b = Buffer.from(TOKEN);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        return res.status(401).json({ error: '未授权访问更新服务' });
    }
    next();
}

function isSafeRef(value) {
    return /^[A-Za-z0-9._/-]{1,120}$/.test(String(value || ''));
}

function run(command, args, options = {}) {
    return new Promise((resolve, reject) => {
        log(redact(`$ ${command} ${args.join(' ')}`));
        const child = spawn(command, args, {
            cwd: options.cwd || WORKDIR,
            env: { ...process.env, ...(options.env || {}) },
            shell: false
        });
        child.stdout.on('data', data => String(data).split(/\r?\n/).filter(Boolean).forEach(line => log(redact(line))));
        child.stderr.on('data', data => String(data).split(/\r?\n/).filter(Boolean).forEach(line => log(redact(line))));
        child.on('error', reject);
        child.on('close', code => {
            if (code === 0) resolve();
            else reject(new Error(`${command} ${args.join(' ')} exited with ${code}`));
        });
    });
}

async function readPackageVersion(repoDir = WORKDIR) {
    const file = path.join(repoDir, 'package.json');
    const pkg = JSON.parse(await fs.promises.readFile(file, 'utf8'));
    return String(pkg.version || '');
}

async function ensureRepository(repository = REPO, branch = BRANCH) {
    if (!repository) throw new Error('未配置 PIVOT_UPDATE_REPO');
    if (!isSafeRef(branch)) throw new Error('分支名称不安全');
    fs.mkdirSync(path.dirname(WORKDIR), { recursive: true });
    if (!fs.existsSync(path.join(WORKDIR, '.git'))) {
        if (fs.existsSync(WORKDIR) && fs.readdirSync(WORKDIR).length > 0) {
            throw new Error(`更新工作目录已存在且不是 Git 仓库: ${WORKDIR}`);
        }
        await run(GIT_BIN, ['clone', '--branch', branch, '--depth', '1', repository, WORKDIR], { cwd: path.dirname(WORKDIR) });
        return;
    }
    await run(GIT_BIN, ['remote', 'set-url', 'origin', repository]);
    await run(GIT_BIN, ['fetch', '--depth', '1', 'origin', branch]);
    await run(GIT_BIN, ['checkout', branch]);
    await run(GIT_BIN, ['reset', '--hard', `origin/${branch}`]);
}

async function checkLatest({ repository = REPO, branch = BRANCH } = {}) {
    await ensureRepository(repository, branch);
    const latestVersion = await readPackageVersion(WORKDIR);
    const revision = await new Promise(resolve => {
        const child = spawn(GIT_BIN, ['rev-parse', '--short', 'HEAD'], { cwd: WORKDIR, shell: false });
        let out = '';
        child.stdout.on('data', data => { out += String(data); });
        child.on('error', () => resolve(''));
        child.on('close', code => resolve(code === 0 ? out.trim() : ''));
    });
    return { latestVersion, branch, repository, revision };
}

async function updateFromGitBuild({ runId, repository = REPO, branch = BRANCH, currentVersion = '' } = {}) {
    if (running) throw new Error('已有更新任务正在执行');
    running = true;
    setState({
        runId: runId || `upd-${Date.now().toString(36)}`,
        status: 'running',
        step: '拉取源码',
        startedAt: nowIso(),
        finishedAt: null,
        currentVersion,
        targetVersion: '',
        error: '',
        logs: []
    });
    try {
        await ensureRepository(repository, branch);
        const targetVersion = await readPackageVersion(WORKDIR);
        const latest = await checkLatest({ repository, branch });
        setState({ step: '构建 Docker 镜像', targetVersion });
        await run(DOCKER_BIN, ['build', '--build-arg', `PIVOT_BUILD_REVISION=${latest.revision || ''}`, '-t', IMAGE, BUILD_CONTEXT], { cwd: WORKDIR });
        setState({ step: '重建 Pivot 容器' });
        await run(DOCKER_BIN, ['compose', '-f', COMPOSE_FILE, 'up', '-d', '--no-deps', '--force-recreate', SERVICE], { cwd: path.dirname(COMPOSE_FILE) });
        setState({
            status: 'success',
            step: '更新完成',
            finishedAt: nowIso(),
            targetVersion
        });
    } catch (e) {
        setState({
            status: 'failed',
            step: '更新失败',
            error: e.message,
            finishedAt: nowIso()
        });
    } finally {
        running = false;
    }
}

const app = express();
app.use(express.json({ limit: '256kb' }));
app.get('/health', (_req, res) => res.json({ ok: true, running, updatedAt: state.updatedAt || nowIso() }));
app.use(requireAuth);

app.get('/status', (_req, res) => {
    res.json({
        available: true,
        mode: 'git-build',
        repository: REPO,
        branch: BRANCH,
        workdir: WORKDIR,
        composeFile: COMPOSE_FILE,
        image: IMAGE,
        service: SERVICE,
        running,
        state
    });
});

app.post('/check', async (req, res) => {
    try {
        const latest = await checkLatest(req.body || {});
        res.json({ ...latest, state });
    } catch (e) {
        res.status(500).json({ error: e.message, state });
    }
});

app.post('/update', (req, res) => {
    if (running) return res.status(409).json({ error: '已有更新任务正在执行', state });
    const body = req.body || {};
    updateFromGitBuild(body);
    res.json({ accepted: true, runId: body.runId || state.runId, state });
});

app.listen(PORT, '0.0.0.0', () => {
    log(`Pivot updater listening on ${PORT}`);
});
