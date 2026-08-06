/* 五段式 cron 表达式解析与下次执行时间计算，用于自动化计划的分钟级调度。
   字段顺序为：分 时 日 月 周，全部按东八区本地时间求值。 */

// 各字段取值范围，顺序与 cron 表达式一致
const CRON_FIELDS = [
    { key: 'minutes', label: '分钟', min: 0, max: 59 },
    { key: 'hours', label: '小时', min: 0, max: 23 },
    { key: 'daysOfMonth', label: '日期', min: 1, max: 31 },
    { key: 'months', label: '月份', min: 1, max: 12 },
    { key: 'daysOfWeek', label: '星期', min: 0, max: 6 }
];

// 最多向前搜索一年，避免 "2月30日" 这类永不命中的表达式陷入死循环
const MAX_SEARCH_DAYS = 366;
const CRON_EXPRESSION_MAX_LENGTH = 120;

function invalidCron(message) {
    const err = new Error(message);
    err.status = 400;
    return err;
}

// 解析单个字段，支持 *、a、a-b、a/n、a-b/n 和逗号列表
function parseCronField(text, field) {
    const raw = String(text || '').trim();
    if (!raw) throw invalidCron(`cron 表达式的${field.label}字段不能为空。`);
    const values = new Set();

    raw.split(',').forEach(part => {
        const segment = part.trim();
        if (!segment) throw invalidCron(`cron 表达式的${field.label}字段存在空白项。`);

        const [rangeText, stepText] = segment.split('/');
        let step = 1;
        if (stepText !== undefined) {
            step = Number.parseInt(stepText, 10);
            if (!Number.isInteger(step) || step <= 0) {
                throw invalidCron(`cron 表达式的${field.label}字段步长必须是正整数。`);
            }
        }

        let start = field.min;
        let end = field.max;
        const rangeValue = rangeText.trim();
        if (rangeValue !== '*') {
            const bounds = rangeValue.split('-');
            if (bounds.length > 2) throw invalidCron(`cron 表达式的${field.label}字段区间格式无效。`);
            start = normalizeFieldValue(bounds[0], field);
            end = bounds.length === 2 ? normalizeFieldValue(bounds[1], field) : start;
            // 只写单值又带步长时，按 cron 惯例从该值走到字段上界
            if (bounds.length === 1 && stepText !== undefined) end = fieldParseMax(field);
            if (start > end) throw invalidCron(`cron 表达式的${field.label}字段区间起始值不能大于结束值。`);
        }

        // 星期字段允许写到 7，取值时统一折回 0，兼容 0-7 表示整周的写法
        for (let value = start; value <= end; value += step) {
            values.add(field.key === 'daysOfWeek' ? value % 7 : value);
        }
    });

    if (!values.size) throw invalidCron(`cron 表达式的${field.label}字段没有有效取值。`);
    return values;
}

// 星期字段解析上界放宽到 7，其余字段使用自身上界
function fieldParseMax(field) {
    return field.key === 'daysOfWeek' ? 7 : field.max;
}

function normalizeFieldValue(text, field) {
    const value = Number.parseInt(String(text || '').trim(), 10);
    if (!Number.isInteger(value)) throw invalidCron(`cron 表达式的${field.label}字段只支持数字。`);
    if (value < field.min || value > fieldParseMax(field)) {
        throw invalidCron(`cron 表达式的${field.label}字段取值需要在 ${field.min} 到 ${field.max} 之间。`);
    }
    return value;
}

/**
 * 解析 cron 表达式为各字段可取值集合。
 * 同时记录日期和星期是否被限定，用于还原标准 cron 的"两者都限定时取并集"语义。
 */
function parseCronExpression(expression) {
    const text = String(expression || '').trim();
    if (!text) throw invalidCron('请填写 cron 表达式。');
    if (text.length > CRON_EXPRESSION_MAX_LENGTH) throw invalidCron('cron 表达式过长。');

    const parts = text.split(/\s+/);
    if (parts.length !== 5) throw invalidCron('cron 表达式需要 5 个字段，顺序为：分 时 日 月 周。');

    const parsed = {};
    CRON_FIELDS.forEach((field, index) => {
        parsed[field.key] = parseCronField(parts[index], field);
    });
    parsed.restrictDayOfMonth = parts[2].trim() !== '*';
    parsed.restrictDayOfWeek = parts[4].trim() !== '*';
    return parsed;
}

function isValidCronExpression(expression) {
    try {
        parseCronExpression(expression);
        return true;
    } catch (_err) {
        return false;
    }
}

// 标准 cron 语义：日期和星期同时被限定时命中任意一个即可，否则只校验被限定的那个
function matchesDay(parsed, date) {
    const dayOfMonthHit = parsed.daysOfMonth.has(date.getDate());
    const dayOfWeekHit = parsed.daysOfWeek.has(date.getDay());
    if (parsed.restrictDayOfMonth && parsed.restrictDayOfWeek) return dayOfMonthHit || dayOfWeekHit;
    if (parsed.restrictDayOfMonth) return dayOfMonthHit;
    if (parsed.restrictDayOfWeek) return dayOfWeekHit;
    return true;
}

/**
 * 计算下一次执行时间，返回 Date；一年内无法命中时返回 null。
 * 按分钟粒度推进，并在月、日、时不匹配时整体跳过，避免逐分钟空转。
 */
function computeNextCronDate(expression, from = new Date()) {
    const parsed = parseCronExpression(expression);
    const cursor = new Date(from.getTime());
    cursor.setSeconds(0, 0);
    // 从下一分钟开始找，保证不会重复命中本分钟
    cursor.setMinutes(cursor.getMinutes() + 1);

    const deadline = new Date(cursor.getTime());
    deadline.setDate(deadline.getDate() + MAX_SEARCH_DAYS);

    while (cursor <= deadline) {
        if (!parsed.months.has(cursor.getMonth() + 1)) {
            cursor.setMonth(cursor.getMonth() + 1, 1);
            cursor.setHours(0, 0, 0, 0);
            continue;
        }
        if (!matchesDay(parsed, cursor)) {
            cursor.setDate(cursor.getDate() + 1);
            cursor.setHours(0, 0, 0, 0);
            continue;
        }
        if (!parsed.hours.has(cursor.getHours())) {
            cursor.setHours(cursor.getHours() + 1, 0, 0, 0);
            continue;
        }
        if (!parsed.minutes.has(cursor.getMinutes())) {
            cursor.setMinutes(cursor.getMinutes() + 1, 0, 0);
            continue;
        }
        return cursor;
    }
    return null;
}

/** 生成中文可读的执行节奏描述，用于计划列表和表单提示 */
function describeCronExpression(expression) {
    try {
        const parsed = parseCronExpression(expression);
        const minuteText = describeField(parsed.minutes, CRON_FIELDS[0]);
        const hourText = describeField(parsed.hours, CRON_FIELDS[1]);
        const parts = [`${hourText} 时 ${minuteText} 分`];
        if (parsed.restrictDayOfMonth) parts.push(`每月 ${describeField(parsed.daysOfMonth, CRON_FIELDS[2])} 日`);
        if (parsed.restrictDayOfWeek) parts.push(`星期 ${describeField(parsed.daysOfWeek, CRON_FIELDS[4])}`);
        return parts.join('，');
    } catch (_err) {
        return '';
    }
}

function describeField(values, field) {
    if (values.size === field.max - field.min + 1) return '每';
    const list = Array.from(values).sort((a, b) => a - b);
    if (list.length > 6) return `${list.slice(0, 6).join('、')} 等 ${list.length} 个取值`;
    return list.join('、');
}

module.exports = {
    CRON_EXPRESSION_MAX_LENGTH,
    computeNextCronDate,
    describeCronExpression,
    isValidCronExpression,
    parseCronExpression
};
