const { clampText } = require('./agent-tool-runtime');
const { parseJsonObject } = require('./agent-validators');
const { assertTenantContext } = require('./agent-tenant-context');
const { putBuffer, readBuffer } = require('./agent-artifact-cas');

const DAG_PERSISTED_OUTPUT_MAX_CHARS = Math.max(
    120000,
    Math.min(Number.parseInt(process.env.AGENT_DAG_OUTPUT_MAX_CHARS || '8000000', 10) || 8000000, 20000000)
);

function outputLimit(options = {}) {
    const requested = Number.parseInt(options.maxChars ?? options.max_chars, 10);
    if (!Number.isSafeInteger(requested) || requested <= 0) return DAG_PERSISTED_OUTPUT_MAX_CHARS;
    return Math.min(Math.max(requested, 120000), DAG_PERSISTED_OUTPUT_MAX_CHARS);
}

function preparePersistedDagOutput(value, options = {}) {
    const maxChars = outputLimit(options);
    let text = '';
    let serialized = '';
    try {
        serialized = JSON.stringify(value);
        if (serialized === undefined) serialized = 'null';
        text = typeof value === 'string' ? value : serialized;
    } catch (error) {
        const fallback = clampText(value, maxChars);
        return { value: fallback, serialized: JSON.stringify(fallback) };
    }
    if (text.length <= maxChars) return { value, serialized };
    const payload = value?.structuredContent && typeof value.structuredContent === 'object'
        ? value.structuredContent
        : value;
    const rows = Array.isArray(payload?.rows) ? payload.rows : [];
    if (!rows.length) {
        const truncated = {
            __partial: true,
            originalChars: text.length,
            text: `${text.slice(0, maxChars)}\n...[truncated]`,
            warning: '节点完整输出超过持久化上限，恢复运行时只能使用截断预览。'
        };
        return { value: truncated, serialized: JSON.stringify(truncated), fullSerialized: serialized };
    }
    const keptRows = [];
    let used = 0;
    let oversizedRowCount = 0;
    for (const row of rows) {
        const rowText = JSON.stringify(row);
        if (rowText.length > maxChars - 2000) {
            oversizedRowCount += 1;
            continue;
        }
        if (used + rowText.length > maxChars - 2000) break;
        keptRows.push(row);
        used += rowText.length;
    }
    const truncated = {
        structuredContent: {
            ...payload,
            rows: keptRows,
            __partial: true,
            originalRowCount: rows.length,
            persistedRowCount: keptRows.length,
            oversizedRowCount
        },
        text: '节点输出过大，已按完整记录保留前 ' + keptRows.length + '/' + rows.length + ' 条。',
        warning: '恢复运行时只能使用已持久化的完整记录。'
    };
    return { value: truncated, serialized: JSON.stringify(truncated), fullSerialized: serialized };
}

function isPersistedDagOutputPartial(value) {
    return Boolean(value && typeof value === 'object' && (
        value.__partial === true || value?.structuredContent?.__partial === true
    ));
}

function attachDagOutputReference(preview, object) {
    const reference = {
        outputRef: object.ref,
        outputDigest: object.contentDigest,
        outputBytes: object.byteSize,
        outputMimeType: object.mimeType,
        outputComplete: false
    };
    if (preview && typeof preview === 'object' && !Array.isArray(preview)) return { ...preview, ...reference };
    return {
        __partial: true,
        text: typeof preview === 'string' ? preview : String(preview || ''),
        warning: '节点完整输出已保存为受控产物引用；当前仅展示预览。',
        ...reference
    };
}

async function persistDagOutput(value, { user = {}, retentionDays = 30, maxChars } = {}) {
    const prepared = preparePersistedDagOutput(value, { maxChars });
    if (!isPersistedDagOutputPartial(prepared.value)) {
        return { ...prepared, complete: true, outputRef: null };
    }
    if (!prepared.serialized || !user?.id) return { ...prepared, complete: false, outputRef: null };
    try {
        const tenant = await assertTenantContext(user);
        const object = await putBuffer({
            buffer: Buffer.from(prepared.fullSerialized || prepared.serialized, 'utf8'),
            mimeType: 'application/json; charset=utf-8',
            tenantId: tenant.tenantId,
            ownerUserId: user.id,
            kind: 'dag_output',
            retentionDays
        });
        const valueWithReference = attachDagOutputReference(prepared.value, object);
        return {
            value: valueWithReference,
            serialized: JSON.stringify(valueWithReference),
            complete: false,
            outputRef: object.ref,
            outputDigest: object.contentDigest,
            outputBytes: object.byteSize
        };
    } catch (error) {
        // 原有截断预览仍是可审计降级结果；存储不可用不能让一个已完成节点被写成成功且完整。
        const valueWithWarning = attachDagOutputReference(prepared.value, {
            ref: '', contentDigest: '', byteSize: 0, mimeType: ''
        });
        valueWithWarning.outputRef = null;
        valueWithWarning.outputStorageError = String(error?.message || '完整输出持久化失败').slice(0, 300);
        return {
            value: valueWithWarning,
            serialized: JSON.stringify(valueWithWarning),
            complete: false,
            outputRef: null,
            outputStorageError: valueWithWarning.outputStorageError
        };
    }
}

async function resolvePersistedDagOutput(value, { user = {} } = {}) {
    if (!isPersistedDagOutputPartial(value)) return { value, complete: true, source: 'inline' };
    const ref = String(value?.outputRef || '').trim();
    if (!ref || !user?.id) return { value, complete: false, source: 'preview' };
    try {
        const tenant = await assertTenantContext(user);
        const result = await readBuffer({ ref, tenantId: tenant.tenantId, userId: user.id });
        const text = result.buffer.toString('utf8');
        let parsed;
        try { parsed = JSON.parse(text); } catch (_) { parsed = undefined; }
        if (parsed === undefined || isPersistedDagOutputPartial(parsed)) return { value, complete: false, source: 'preview' };
        return { value: parsed, complete: true, source: 'artifact', object: result.object };
    } catch (_) {
        return { value, complete: false, source: 'preview' };
    }
}

function persistedDagOutput(value, options = {}) {
    return preparePersistedDagOutput(value, options).value;
}

function compactPreparedDagOutput(value, serialized, max = 12000) {
    const text = typeof value === 'string' ? value : String(serialized || '');
    if (!text) return '';
    return text.length > max ? `${text.slice(0, max)}\n...[truncated]` : text;
}

function parseMaybeJsonPayload(value) {
    if (!value) return value;
    if (typeof value === 'object') return value;
    if (typeof value !== 'string') return value;
    const text = value.trim();
    if (!text) return '';
    const parsed = parseJsonObject(text);
    return parsed || text;
}

function firstReadableString(...values) {
    return values
        .map(value => String(value || '').trim())
        .find(Boolean) || '';
}

function extractTextFromContentArray(content) {
    if (!Array.isArray(content)) return '';
    return content
        .map(item => {
            if (typeof item === 'string') return item;
            if (!item || typeof item !== 'object') return '';
            return firstReadableString(item.text, item.content, item.markdown);
        })
        .filter(Boolean)
        .join('\n')
        .trim();
}

function summarizeStructuredDagOutput(payload) {
    if (!payload || typeof payload !== 'object') return '';
    const structured = payload.structuredContent && typeof payload.structuredContent === 'object'
        ? payload.structuredContent
        : payload;
    if (!structured || typeof structured !== 'object') return '';
    const type = String(structured.type || '').trim();
    const markdown = String(structured.markdown || '').trim();
    if (markdown && ['pivot_table', 'pivot_report', 'format_markdown_table'].includes(type)) return markdown;
    if (type === 'pivot_chart') {
        const title = String(structured.title || '').trim();
        const points = Math.max(
            Array.isArray(structured.labels) ? structured.labels.length : 0,
            ...(Array.isArray(structured.series)
                ? structured.series.map(item => Array.isArray(item?.data) ? item.data.length : 0)
                : [0])
        );
        return `已生成图表${title ? `：${title}` : ''}${points ? `，包含 ${points} 个数据点` : ''}。`;
    }
    const rows = Array.isArray(structured.rows)
        ? structured.rows
        : Array.isArray(structured.data)
            ? structured.data
            : Array.isArray(structured.items)
                ? structured.items
                : [];
    if (rows.length) return `查询完成，返回 ${rows.length} 行数据。`;
    return '';
}

function extractReadableDagOutput(output) {
    const payload = parseMaybeJsonPayload(output);
    if (!payload) return '';
    if (typeof payload === 'string') return payload.trim();
    if (typeof payload !== 'object') return String(payload || '').trim();
    const contentText = extractTextFromContentArray(payload.content);
    return firstReadableString(
        typeof payload.content === 'string' ? payload.content : '',
        payload.text,
        payload.markdown,
        payload.answer,
        payload.message,
        payload.summary,
        summarizeStructuredDagOutput(payload),
        contentText
    );
}

module.exports = {
    persistDagOutput,
    resolvePersistedDagOutput,
    isPersistedDagOutputPartial,
    persistedDagOutput,
    compactPreparedDagOutput,
    extractReadableDagOutput
};
