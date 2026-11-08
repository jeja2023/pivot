'use strict';

const fs = require('node:fs/promises');

async function main() {
    let text = '';
    for await (const chunk of process.stdin) text += chunk;
    const input = JSON.parse(text);
    const mode = input.query.fault;
    if (mode === 'oom') {
        globalThis.biFaultAllocations = [];
        while (true) {
            globalThis.biFaultAllocations.push(Buffer.alloc(64 * 1024 ** 2, 0x67));
            await fs.writeFile('/output/oom-progress.json', JSON.stringify({ blocks: globalThis.biFaultAllocations.length, rss: process.memoryUsage().rss }));
        }
    }
    if (mode === 'stall') { await fs.writeFile('/output/stall-ready', '已暂停'); await new Promise(() => { setInterval(() => {}, 1000); }); }
    if (mode === 'incompatible') { process.stdout.write(JSON.stringify({ protocol: 1, engine: 'v1.5.4' })); return; }
    if (mode === 'readonly') {
        try { await fs.writeFile('/app/forbidden-write', '拒绝'); throw new Error('只读根目录允许写入'); }
        catch (error) { if (error.code !== 'EROFS' && error.code !== 'EACCES') throw error; process.stdout.write(JSON.stringify({ protocol: 2, engine: 'v1.5.4', error: { code: 'ANALYSIS_MODEL_STORAGE_PRESSURE', message: '只读文件系统演练拒绝写入。' } })); return; }
    }
    if (mode === 'diskfull') {
        const handle = await fs.open('/tmp/capacity', 'wx');
        try {
            const block = Buffer.alloc(4 * 1024 ** 2, 0x34);
            for (let index = 0; index < 20; index++) await handle.write(block);
            throw new Error('临时目录未执行容量上限');
        } catch (error) {
            if (error.code !== 'ENOSPC') throw error;
            process.stdout.write(JSON.stringify({ protocol: 2, engine: 'v1.5.4', error: { code: 'ANALYSIS_MODEL_STORAGE_PRESSURE', message: '临时目录空间不足，未登记结果。' } }));
        } finally { await handle.close(); }
    }
}

main().catch(() => { process.stdout.write(JSON.stringify({ protocol: 2, error: { code: 'ANALYSIS_MODEL_EXECUTION_FAILED', message: '故障执行器演练失败。' } })); process.exitCode = 1; });
