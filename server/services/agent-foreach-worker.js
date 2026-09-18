/*
 * workflow.foreach 单次执行 Worker。
 *
 * 本文件由控制面放入独立沙箱进程执行：从标准输入读取一份有界 JSON 请求，
 * 向标准输出写回一份有界 JSON 结果。表达式环境不暴露 require、进程和网络 API。
 */
const vm = require('vm');
const { isMainThread, parentPort, Worker, workerData } = require('worker_threads');

const MAX_ITEMS = 1000;
const MAX_CODE_CHARS = 32000;
const MAX_VARS_BYTES = 256 * 1024;
const MAX_ITEM_OUTPUT_CHARS = 200000;
const MAX_TOTAL_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_ITEM_TIMEOUT_MS = 1000;

function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
}

function normalizeRequest(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Worker 请求必须是对象。');
    if (input.approvedByControlPlane !== true) {
        const error = new Error('工作流循环 Worker 缺少控制面批准。');
        error.code = 'AGENT_FOREACH_APPROVAL_REQUIRED';
        throw error;
    }
    const items = Array.isArray(input.items) ? input.items.slice(0, MAX_ITEMS) : [];
    const code = String(input.code || 'return item;').slice(0, MAX_CODE_CHARS);
    if (!code.trim()) throw new Error('循环节点代码不能为空。');
    const vars = input.vars && typeof input.vars === 'object' && !Array.isArray(input.vars) ? input.vars : {};
    if (Buffer.byteLength(JSON.stringify(vars), 'utf8') > MAX_VARS_BYTES) throw new Error('循环节点变量超过 256KB 限制。');
    return {
        items,
        code,
        vars,
        concurrency: Math.max(1, Math.min(Number.parseInt(input.concurrency, 10) || 4, 20)),
        stopOnError: input.stopOnError !== false,
        retryLimit: Math.max(0, Math.min(Number.parseInt(input.retryLimit, 10) || 0, 3)),
        itemTimeoutMs: Math.max(50, Math.min(Number.parseInt(input.itemTimeoutMs, 10) || DEFAULT_ITEM_TIMEOUT_MS, 5000))
    };
}

function executeItemInVm(request) {
    // 只注入 JSON 原语；去掉 VM 全局对象原型，避免 this.constructor.constructor 取得宿主构造器。
    const context = vm.createContext(Object.assign(Object.create(null), {
        __pivotItemJson: String(request.itemJson ?? JSON.stringify(request.items?.[0])),
        __pivotVarsJson: String(request.varsJson ?? JSON.stringify(request.vars || {})),
        __pivotIndex: Number(request.index)
    }));
    const script = new vm.Script(`(function () {
        Object.setPrototypeOf(globalThis, null);
        globalThis.constructor = Object;
        const item = JSON.parse(__pivotItemJson);
        const vars = JSON.parse(__pivotVarsJson);
        const index = __pivotIndex;
        ${request.code}\n
    })()`);
    let value;
    try {
        value = script.runInContext(context, { timeout: request.itemTimeoutMs });
    } catch (error) {
        if (/Script execution timed out/i.test(String(error?.message || ''))) {
            error.code = 'AGENT_FOREACH_ITEM_TIMEOUT';
            error.category = 'timeout';
            error.retryable = true;
        }
        throw error;
    }
    const serialized = JSON.stringify(value === undefined ? null : value);
    const outputBytes = Buffer.byteLength(serialized || 'null', 'utf8');
    if (outputBytes > MAX_ITEM_OUTPUT_CHARS) {
        const error = new Error(`第 ${request.index + 1} 项输出超过 ${MAX_ITEM_OUTPUT_CHARS} 字节限制。`);
        error.code = 'AGENT_FOREACH_ITEM_OUTPUT_LIMIT';
        error.retryable = false;
        throw error;
    }
    return { serialized: serialized || 'null', outputBytes };
}

function executeItem(request, item, index) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const thread = new Worker(__filename, {
            workerData: {
                mode: 'item',
                itemJson: JSON.stringify(cloneJson(item)),
                varsJson: JSON.stringify(cloneJson(request.vars)),
                index,
                code: request.code,
                itemTimeoutMs: request.itemTimeoutMs
            },
            resourceLimits: { maxOldGenerationSizeMb: 128, stackSizeMb: 4 }
        });
        const finish = (error, result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (error) reject(error);
            else resolve(result);
        };
        const timer = setTimeout(() => {
            const error = new Error(`第 ${index + 1} 项执行超过 ${request.itemTimeoutMs}ms 限时。`);
            error.code = 'AGENT_FOREACH_ITEM_TIMEOUT';
            error.category = 'timeout';
            error.retryable = true;
            thread.terminate().catch(() => {});
            finish(error);
        }, request.itemTimeoutMs + 50);
        thread.once('message', message => {
            if (message?.ok) {
                try { finish(null, { value: JSON.parse(message.serialized), outputBytes: message.outputBytes }); }
                catch (error) { finish(error); }
            } else {
                const error = new Error(message?.error?.message || '循环项执行失败。');
                error.code = message?.error?.code || 'AGENT_FOREACH_ITEM_FAILED';
                error.retryable = message?.error?.retryable !== false;
                finish(error);
            }
            thread.terminate().catch(() => {});
        });
        thread.once('error', error => finish(error));
        thread.once('exit', code => {
            if (!settled && code !== 0) finish(Object.assign(new Error('循环项 Worker 异常退出。'), { code: 'AGENT_FOREACH_ITEM_WORKER_EXIT' }));
        });
    });
}

async function execute(request) {
    const results = [];
    const errors = [];
    let cursor = 0;
    let stopped = false;
    let retryCount = 0;
    let outputBytes = 0;
    let active = 0;
    let maxActive = 0;
    async function worker() {
        while (!stopped) {
            const index = cursor++;
            if (index >= request.items.length) return;
            active += 1;
            maxActive = Math.max(maxActive, active);
            let attempt = 0;
            let value;
            let valueBytes = 0;
            let lastError;
            while (attempt <= request.retryLimit) {
                try {
                    const itemResult = await executeItem(request, request.items[index], index);
                    if (outputBytes + itemResult.outputBytes > MAX_TOTAL_OUTPUT_BYTES) {
                        const error = new Error(`循环节点累计输出超过 ${MAX_TOTAL_OUTPUT_BYTES} 字节限制。`);
                        error.code = 'AGENT_FOREACH_TOTAL_OUTPUT_LIMIT';
                        error.retryable = false;
                        throw error;
                    }
                    value = itemResult.value;
                    valueBytes = itemResult.outputBytes;
                    lastError = null;
                    break;
                } catch (error) {
                    lastError = error;
                    attempt += 1;
                    if (error?.retryable === false) break;
                }
            }
            if (lastError) {
                errors.push({ index, code: lastError.code || 'AGENT_FOREACH_ITEM_FAILED', error: String(lastError.message || lastError).slice(0, 1000), attempts: attempt });
                retryCount += Math.max(0, attempt - 1);
                if (request.stopOnError) stopped = true;
                active -= 1;
                continue;
            }
            results[index] = value;
            outputBytes += valueBytes;
            retryCount += Math.max(0, attempt);
            active -= 1;
        }
    }
    await Promise.all(Array.from({ length: Math.min(request.concurrency, Math.max(request.items.length, 1)) }, () => worker()));
    const compactResults = results.filter((_, index) => !errors.some(error => error.index === index));
    return {
        items: compactResults,
        count: compactResults.length,
        inputCount: request.items.length,
        errors: errors.sort((a, b) => a.index - b.index),
        stoppedOnError: stopped,
        audit: {
            completedCount: compactResults.length,
            failedCount: errors.length,
            retryCount,
            requestedConcurrency: request.concurrency,
            maxConcurrency: maxActive,
            itemTimeoutMs: request.itemTimeoutMs,
            maxItemOutputBytes: MAX_ITEM_OUTPUT_CHARS,
            maxTotalOutputBytes: MAX_TOTAL_OUTPUT_BYTES,
            outputBytes
        }
    };
}

if (!isMainThread) {
    try {
        const request = normalizeRequest({
            items: [JSON.parse(workerData.itemJson)],
            vars: JSON.parse(workerData.varsJson),
            code: workerData.code,
            itemTimeoutMs: workerData.itemTimeoutMs,
            approvedByControlPlane: true
        });
        const result = executeItemInVm({ ...request, index: workerData.index, itemJson: workerData.itemJson, varsJson: workerData.varsJson });
        parentPort.postMessage({ ok: true, ...result });
    } catch (error) {
        parentPort.postMessage({ ok: false, error: { code: error.code || 'AGENT_FOREACH_ITEM_FAILED', message: String(error.message || error), retryable: error.retryable !== false } });
    }
} else {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { input += chunk; });
    process.stdin.on('end', async () => {
        try {
            const request = normalizeRequest(JSON.parse(input || '{}'));
            process.stdout.write(JSON.stringify({ ok: true, result: await execute(request) }));
        } catch (error) {
            process.stdout.write(JSON.stringify({ ok: false, error: { code: error.code || 'AGENT_FOREACH_WORKER_FAILED', message: String(error.message || error) } }));
            process.exitCode = 1;
        }
    });
}
