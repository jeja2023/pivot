const { normalizePositiveInt } = require('./agent-validators');

function getPathValue(value, path = []) {
    let current = value;
    for (const part of path) {
        if (current === null || current === undefined) return undefined;
        if (Array.isArray(current) && /^\d+$/.test(part)) {
            current = current[Number(part)];
        } else if (typeof current === 'object' && Object.prototype.hasOwnProperty.call(current, part)) {
            current = current[part];
        } else {
            return undefined;
        }
    }
    return current;
}

function stringifyDagTemplateValue(value) {
    if (value === undefined || value === null) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    try {
        return JSON.stringify(value);
    } catch (e) {
        return String(value);
    }
}

function parseStructuredNodeOutput(output) {
    if (!output || typeof output !== 'object') return undefined;
    if (output.structuredContent !== undefined) return output.structuredContent;
    if (typeof output.content !== 'string') return undefined;
    const text = output.content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    try { return JSON.parse(text); } catch (e) { return undefined; }
}

function resolveDagTemplateReference(expression, context) {
    const expr = String(expression || '').trim();
    if (!expr) return undefined;
    if (expr === 'goal' || expr === 'run.goal') return context.goal;
    const parts = expr.split('.').map(part => part.trim()).filter(Boolean);
    if (!parts.length) return undefined;
    if (parts[0] === 'inputs' || parts[0] === 'input') {
        return getPathValue(context.inputs || {}, parts.slice(1));
    }
    if (parts[0] === 'run') {
        if (parts[1] === 'goal') return context.goal;
        if (parts[1] === 'inputs' || parts[1] === 'input') return getPathValue(context.inputs || {}, parts.slice(2));
    }
    if (parts[0] === 'nodes' || parts[0] === 'node') {
        const nodeId = parts[1];
        const field = parts[2] || 'output';
        if (!nodeId) return undefined;
        const state = context.states.get(nodeId) || {};
        const node = context.nodeMap.get(nodeId) || {};
        if (field === 'status') return state.status;
        if (field === 'error') return state.error || '';
        if (field === 'title') return node.title || nodeId;
        if (field === 'tool') return node.tool || '';
        if (field === 'input') return getPathValue(state.input ?? node.input ?? {}, parts.slice(3));
        if (field === 'output') {
            const path = parts.slice(3);
            const direct = getPathValue(state.output, path);
            if (direct !== undefined || !path.length) return direct;
            const structured = parseStructuredNodeOutput(state.output);
            return getPathValue(structured, path);
        }
    }
    return undefined;
}

function resolveDagInputValue(value, context) {
    if (typeof value === 'string') {
        const exact = value.match(/^\s*\{\{\s*([^{}]+?)\s*\}\}\s*$/);
        if (exact) {
            const resolved = resolveDagTemplateReference(exact[1], context);
            return resolved === undefined ? value : resolved;
        }
        return value.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (match, expression) => {
            const resolved = resolveDagTemplateReference(expression, context);
            return resolved === undefined ? match : stringifyDagTemplateValue(resolved);
        });
    }
    if (Array.isArray(value)) {
        return value.map(item => resolveDagInputValue(item, context));
    }
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveDagInputValue(item, context)]));
    }
    return value;
}

function resolveDagNodeInput(node, context) {
    const resolved = resolveDagInputValue(node.input || {}, context);
    return resolved && typeof resolved === 'object' && !Array.isArray(resolved) ? resolved : {};
}

function isEmptyDagValue(value) {
    if (value === undefined || value === null) return true;
    if (typeof value === 'string') return value.trim() === '';
    if (Array.isArray(value)) return value.length === 0;
    if (typeof value === 'object') return Object.keys(value).length === 0;
    return false;
}

function isTruthyDagValue(value) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) && value !== 0;
    if (typeof value === 'string') {
        const text = value.trim().toLowerCase();
        if (!text) return false;
        return !['false', '0', 'no', 'null', 'undefined'].includes(text);
    }
    return !isEmptyDagValue(value);
}

function dagValueToComparableText(value) {
    if (value === undefined || value === null) return '';
    if (typeof value === 'string') return value;
    return stringifyDagTemplateValue(value);
}

// 返回 1 / 0 / -1，任一侧不是有限数值时返回 null，让调用方回退到文本比较。
function compareDagNumbers(actual, expected) {
    const left = typeof actual === 'number' ? actual : Number(String(actual ?? '').trim());
    const right = typeof expected === 'number' ? expected : Number(String(expected ?? '').trim());
    if (!Number.isFinite(left) || !Number.isFinite(right)) return null;
    if (left > right) return 1;
    if (left < right) return -1;
    return 0;
}

const DAG_WHEN_OPERATOR_LABELS = {
    equals: '等于',
    not_equals: '不等于',
    contains: '包含',
    not_contains: '不包含',
    starts_with: '开头是',
    ends_with: '结尾是',
    greater_than: '大于',
    greater_or_equal: '大于等于',
    less_than: '小于',
    less_or_equal: '小于等于',
    empty: '为空',
    not_empty: '不为空',
    exists: '存在',
    not_exists: '不存在',
    is_true: '为真',
    is_false: '为假'
};

// 求值节点 when 规则：source 从模板上下文取值，再按 operator 与 value 比较。
// 返回 { matched, source, operator, expected, actual, reason }，供运行时决定是否跳过节点。
function evaluateDagWhen(when, context) {
    if (!when || typeof when !== 'object') return { matched: true, skipped: false };
    const source = String(when.source || '').trim();
    const operator = String(when.operator || 'equals').trim();
    const expected = when.value;
    if (!source) return { matched: true, skipped: false };
    const actual = resolveDagTemplateReference(source, context);
    const actualText = dagValueToComparableText(actual);
    const expectedText = dagValueToComparableText(expected);
    let matched = false;
    switch (operator) {
        case 'equals':
            matched = compareDagNumbers(actual, expected) === 0 || actualText === expectedText;
            break;
        case 'not_equals':
            matched = !(compareDagNumbers(actual, expected) === 0 || actualText === expectedText);
            break;
        case 'contains':
            matched = actualText.includes(expectedText);
            break;
        case 'not_contains':
            matched = !actualText.includes(expectedText);
            break;
        case 'starts_with':
            matched = actualText.startsWith(expectedText);
            break;
        case 'ends_with':
            matched = actualText.endsWith(expectedText);
            break;
        case 'greater_than':
            matched = compareDagNumbers(actual, expected) === 1;
            break;
        case 'greater_or_equal':
            matched = [0, 1].includes(compareDagNumbers(actual, expected));
            break;
        case 'less_than':
            matched = compareDagNumbers(actual, expected) === -1;
            break;
        case 'less_or_equal':
            matched = [0, -1].includes(compareDagNumbers(actual, expected));
            break;
        case 'empty':
            matched = isEmptyDagValue(actual);
            break;
        case 'not_empty':
            matched = !isEmptyDagValue(actual);
            break;
        case 'exists':
            matched = actual !== undefined;
            break;
        case 'not_exists':
            matched = actual === undefined;
            break;
        case 'is_true':
            matched = isTruthyDagValue(actual);
            break;
        case 'is_false':
            matched = !isTruthyDagValue(actual);
            break;
        default:
            matched = true;
            break;
    }
    const operatorLabel = DAG_WHEN_OPERATOR_LABELS[operator] || operator;
    const needsExpected = !['empty', 'not_empty', 'exists', 'not_exists', 'is_true', 'is_false'].includes(operator);
    return {
        matched,
        skipped: !matched,
        source,
        operator,
        operatorLabel,
        expected: needsExpected ? expected : undefined,
        actual: clampDagWhenPreview(actual),
        reason: matched
            ? ''
            : `条件不满足：${source} ${operatorLabel}${needsExpected ? ` ${expectedText}` : ''}（实际值：${clampDagWhenPreview(actualText) || '空'}）`
    };
}

function clampDagWhenPreview(value, max = 200) {
    const text = typeof value === 'string' ? value : stringifyDagTemplateValue(value);
    if (!text) return '';
    return text.length > max ? `${text.slice(0, max)}...` : text;
}

// 依赖状态是否满足节点的 condition 门禁（success/failure/always）。
function dagConditionSatisfied(condition, dependencyStatuses = []) {
    const mode = ['always', 'success', 'failure'].includes(String(condition || 'success'))
        ? String(condition || 'success')
        : 'success';
    if (mode === 'always') return true;
    if (!dependencyStatuses.length) return true;
    if (mode === 'failure') return dependencyStatuses.some(status => ['error', 'continued_error'].includes(status));
    return dependencyStatuses.every(status => ['completed', 'continued_error'].includes(status));
}

function normalizeDagNodePolicy(node, run, defaultToolTimeoutMs) {
    const defaultTimeout = normalizePositiveInt(
        run.tool_timeout_ms,
        defaultToolTimeoutMs,
        30000,
        10 * 60 * 1000
    );
    return {
        retryLimit: normalizePositiveInt(node.retryLimit ?? node.retry_limit, 0, 0, 5),
        timeoutMs: normalizePositiveInt(node.timeoutMs ?? node.timeout_ms, 0, 0, 10 * 60 * 1000) || defaultTimeout,
        onError: ['skip_dependents', 'continue', 'stop'].includes(String(node.onError || node.on_error || 'skip_dependents'))
            ? String(node.onError || node.on_error || 'skip_dependents')
            : 'skip_dependents'
    };
}

module.exports = {
    DAG_WHEN_OPERATOR_LABELS,
    dagConditionSatisfied,
    evaluateDagWhen,
    getPathValue,
    normalizeDagNodePolicy,
    resolveDagInputValue,
    resolveDagNodeInput,
    resolveDagTemplateReference,
    stringifyDagTemplateValue
};
