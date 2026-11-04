'use strict';

const crypto = require('crypto');
const DISCOVERY = new Set(['tools.search', 'tools.describe', 'agent.skill_search', 'agent.skill_describe', 'knowledge.list']);

function stableValue(value, depth = 0) {
    if (depth > 12) return null;
    if (Array.isArray(value)) return value.map(item => stableValue(item, depth + 1));
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
        .filter(key => !/^(?:timestamp|observed_?at|created_?at|updated_?at|duration_?ms|request_?id|trace_?id|metrics)$/i.test(key))
        .map(key => [key, stableValue(value[key], depth + 1)]));
    return value;
}

function progressFingerprint(tool, input, output) {
    if (tool === 'tools.execute') tool = String(input?.toolRef?.toolName || input?.toolName || input?.tool_name || tool);
    if (DISCOVERY.has(tool) || !output || output.isError || output.error || output.executed === false || output.discoveryRequired || output.retrieval?.status === 'blocked'
        || (Array.isArray(output) && !output.length) || (typeof output === 'object' && !Object.keys(output).length)) return '';
    if (tool === 'tools.batch_read') {
        const fingerprints = (output.results || []).map(item => progressFingerprint(item.toolName, {}, item.output)).filter(Boolean);
        return fingerprints.length ? crypto.createHash('sha256').update([...new Set(fingerprints)].sort().join('\0')).digest('hex') : '';
    }
    const rows = output.structuredContent?.rows ?? output.rows;
    if (Array.isArray(rows) && rows.length === 0) return '';
    const text = JSON.stringify(stableValue(output));
    if (!text || text === '""') return '';
    // 不把参数变化当进展；工具必须返回不同的实际结果，时间戳等易变字段不参与判定。
    return crypto.createHash('sha256').update(String(tool)).update('\0').update(text).digest('hex');
}

module.exports = { progressFingerprint };
