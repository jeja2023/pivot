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

async function withIsolatedPostgres(command, args, options = {}) {
    const bin = await postgresBin(options.bin), extension = process.platform === 'win32' ? '.exe' : '';
    const executable = name => bin ? path.join(bin, `${name}${extension}`) : name;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pivot-isolated-pg-'));
    const data = path.join(root, 'data');
    const listener = net.createServer();
    await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
    const port = listener.address().port;
    await new Promise(resolve => listener.close(resolve));
    let started = false;
    const run = (name, args) => execute(executable(name), args, { windowsHide: true, timeout: 60000, maxBuffer: 2 * 1024 * 1024 });
    try {
        await run('initdb', ['-D', data, '-U', 'pivot_test', '--auth=trust', '--encoding=UTF8', '--no-locale', '--no-sync']);
        await run('pg_ctl', ['-D', data, '-l', path.join(root, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port}`, '-w', 'start']); started = true;
        await run('createdb', ['-h', '127.0.0.1', '-p', String(port), '-U', 'pivot_test', 'pivot_test_chain']);
        const url = `postgresql://pivot_test@127.0.0.1:${port}/pivot_test_chain`;
        return await new Promise((resolve, reject) => {
            const child = spawn(command, args, { cwd: options.cwd || process.cwd(), windowsHide: true,
                env: { ...process.env, DATABASE_URL: url, TEST_DATABASE_URL: url, PATH: bin ? `${bin}${path.delimiter}${process.env.PATH}` : process.env.PATH }, stdio: 'inherit' });
            child.once('error', reject); child.once('close', code => resolve(code ?? 1));
        });
    } finally {
        if (started) await run('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']);
        const base = path.resolve(os.tmpdir()), target = path.resolve(root);
        if (path.dirname(target) !== base || !/^pivot-isolated-pg-[A-Za-z0-9]+$/.test(path.basename(target))) throw new Error('临时测试目录边界校验失败。');
        await fs.rm(target, { recursive: true, force: true });
    }
}

module.exports = { withIsolatedPostgres };
