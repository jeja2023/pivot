'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');

function option(name, fallback) { const index = process.argv.indexOf(name); return index < 0 ? fallback : process.argv[index + 1]; }
const runtime = option('--runtime', 'development_process');
if (!['development_process', 'docker'].includes(runtime)) throw new Error('执行模式只能是 development_process 或 docker。');
const image = option('--image', process.env.DATA_ANALYSIS_MODEL_WORKER_IMAGE || '');
if (runtime === 'docker' && !/^(?:sha256:[a-f0-9]{64}|[\w./:+-]+@sha256:[a-f0-9]{64})$/.test(image)) throw new Error('容器验证必须用 --image 指定已安装的执行器镜像摘要。');
const child = spawn(process.execPath, [path.join(__dirname, 'run_node_tests.js'), 'tests/bi-modeling-capacity.test.js'], { cwd: path.resolve(__dirname, '..'), windowsHide: true, stdio: 'inherit', env: { ...process.env,
    PIVOT_BI_CAPACITY_FROZEN: 'true', PIVOT_BI_CAPACITY_TIERS: option('--tiers', 'standard,large'), PIVOT_BI_CAPACITY_SAMPLES: option('--samples', '3'), PIVOT_BI_CAPACITY_RUNTIME: runtime,
    DATA_ANALYSIS_MODEL_WORKER_IMAGE: image, PIVOT_BI_CAPACITY_REPORT: path.resolve(option('--report', 'output/bi-modeling-capacity.json')) } });
child.once('error', error => { process.stderr.write(`容量验证启动失败：${error.message}\n`); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
