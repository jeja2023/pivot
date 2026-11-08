'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);

async function postgresBin(explicit) {
    if (explicit) return path.resolve(explicit);
    if (process.platform !== 'win32') return '';
    const root = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PostgreSQL');
    const directories = await fs.readdir(root);
    for (const directory of directories.sort((a, b) => Number(b) - Number(a))) {
        const bin = path.join(root, directory, 'bin');
        try { await fs.access(path.join(bin, 'initdb.exe')); return bin; } catch (_) { /* 尝试已安装的下一个版本。 */ }
    }
    throw new Error('未找到 PostgreSQL 测试运行时，请用 --pg-bin 指定安装目录。');
}

async function withPostgresCluster(callback, options = {}) {
    const bin = await postgresBin(options.bin), extension = process.platform === 'win32' ? '.exe' : '';
    const executable = name => bin ? path.join(bin, `${name}${extension}`) : name;
    const tempBase = options.tempRoot ? await fs.realpath(await fs.mkdir(options.tempRoot, { recursive: true, mode: 0o700 }).then(() => options.tempRoot)) : await fs.realpath(os.tmpdir());
    const root = await fs.mkdtemp(path.join(tempBase, 'pivot-isolated-pg-'));
    const data = path.join(root, 'data');
    const listener = net.createServer();
    await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
    const port = listener.address().port;
    await new Promise(resolve => listener.close(resolve));
    const started = new Set();
    const run = (name, args) => name === 'pg_ctl' && process.platform === 'win32' ? new Promise((resolve, reject) => {
        // Windows 的后台 postgres 会继承管道句柄；忽略控制器标准流，按控制器退出判定就绪。
        const child = spawn(executable(name), args, { windowsHide: true, stdio: 'ignore' });
        const timeout = args.includes('stop') ? 185000 : 60000;
        const timer = setTimeout(() => { child.kill(); reject(new Error('隔离 PostgreSQL 控制器操作超时。')); }, timeout);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', code => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error(`隔离 PostgreSQL 控制器返回 ${code}。`)); });
    }) : execute(executable(name), args, { windowsHide: true, timeout: name === 'pg_ctl' && args.includes('stop') ? 185000 : 60000, maxBuffer: 2 * 1024 * 1024 });
    function owned(directory) {
        const relative = path.relative(root, path.resolve(directory));
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('集群控制目标超出本次隔离目录。');
        return path.resolve(directory);
    }
    async function start(directory = data, selectedPort = port, settings = []) {
        directory = owned(directory);
        if (!Number.isSafeInteger(selectedPort) || selectedPort < 1024 || selectedPort > 65535) throw new Error('隔离数据库端口无效。');
        const log = path.join(root, `postgres-${selectedPort}.log`);
        try { await run('pg_ctl', ['-D', directory, '-l', log, '-o', `-h 127.0.0.1 -p ${selectedPort} ${settings.map(value => `-c ${value}`).join(' ')}`, '-w', 'start']); }
        catch (error) { error.message += '\n' + (await fs.readFile(log, 'utf8').catch(() => '')).slice(-8000); throw error; }
        started.add(directory);
    }
    async function stop(directory = data) {
        directory = owned(directory);
        if (!started.has(directory)) return;
        // Real shutdown checkpoints can spend over a minute syncing thousands
        // of schema files on a busy test disk. Keep durability and wait for a
        // bounded clean stop rather than timing out before pg_ctl itself.
        await run('pg_ctl', ['-D', directory, '-m', 'fast', '-t', '180', '-w', 'stop']); started.delete(directory);
    }
    try {
        await run('initdb', ['-D', data, '-U', 'pivot_test', '--auth=trust', '--encoding=UTF8', '--no-locale', ...(options.durable ? [] : ['--no-sync'])]);
        await fs.appendFile(path.join(data, 'postgresql.conf'), "\nunix_socket_directories = ''\n");
        if (options.settings?.length) await fs.appendFile(path.join(data, 'postgresql.conf'), '\n' + options.settings.join('\n') + '\n');
        await start();
        await run('createdb', ['-h', '127.0.0.1', '-p', String(port), '-U', 'pivot_test', 'pivot_test_chain']);
        const url = `postgresql://pivot_test@127.0.0.1:${port}/pivot_test_chain`;
        try { return await callback({ root, data, port, bin, url, run, start, stop }); }
        catch (error) {
            for (const name of (await fs.readdir(root)).filter(name => /^postgres-\d+\.log$/.test(name))) error.message += '\n' + (await fs.readFile(path.join(root, name), 'utf8')).slice(-5000);
            throw error;
        }
    } finally {
        for (const directory of [...started]) await stop(directory);
        const base = path.resolve(tempBase), target = path.resolve(root);
        if (path.dirname(target) !== base || !/^pivot-isolated-pg-[A-Za-z0-9]+$/.test(path.basename(target))) throw new Error('临时测试目录边界校验失败。');
        await fs.rm(target, { recursive: true, force: true });
    }
}

async function withIsolatedPostgres(command, args, options = {}) {
    return withPostgresCluster(({ url, bin }) => new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd: options.cwd || process.cwd(), windowsHide: true,
            env: { ...process.env, DATABASE_URL: url, TEST_DATABASE_URL: url, PATH: bin ? `${bin}${path.delimiter}${process.env.PATH}` : process.env.PATH }, stdio: 'inherit' });
        child.once('error', reject); child.once('close', code => resolve(code ?? 1));
    }), options);
}

module.exports = { withIsolatedPostgres, withPostgresCluster };
