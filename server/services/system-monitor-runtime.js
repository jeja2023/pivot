const { getRuntimeDiagnostics } = require('./runtime-diagnostics');
const { getQueueDiagnostics } = require('./db-write-queue');
const { getTaskQueueSnapshot } = require('../repositories/system-monitor');

async function getSystemMonitorRuntime() {
    // 复用现有探针，监控请求不新建连接池、不重置采样窗口，也不触发任务认领。
    const diagnostics = getRuntimeDiagnostics();
    const queues = Object.values(getQueueDiagnostics());
    const taskQueue = await getTaskQueueSnapshot().catch(() => ({ available: false, scope: 'organization' }));
    return {
        scope: 'instance',
        ...diagnostics,
        writeQueue: {
            pending: queues.reduce((sum, item) => sum + Number(item.pending || 0), 0),
            dropped: queues.reduce((sum, item) => sum + Number(item.dropped || 0), 0),
            capacity: queues.reduce((sum, item) => sum + Number(item.max || 0), 0),
            failedQueues: queues.filter(item => item.lastError).length
        },
        taskQueue
    };
}

module.exports = { getSystemMonitorRuntime };
