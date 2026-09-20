'use strict';

/*
 * 自然语言持续目标只负责生成“待确认草案”。
 *
 * 本模块刻意不用模型推断权限、SQL、文件路径或渠道身份：它只识别有限的
 * 时间表达式，并把不能安全确定的字段明确返回给界面补充。确认令牌封装了完整
 * 草案，创建接口据此写入，避免浏览器在预览后悄悄替换触发器或授权范围。
 */
const crypto = require('crypto');
const { canonicalJson } = require('./canonical-json');

const DRAFT_VERSION = 1;
const DRAFT_TTL_MS = 15 * 60 * 1000;
const MAX_PROMPT_LENGTH = 2000;
const WEEKDAY_MAP = Object.freeze({
    '日': 0, '天': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6,
    sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6
});

function draftError(message, code = 'AGENT_GOAL_DRAFT_INVALID', status = 400) {
    const error = new Error(message);
    error.code = code;
    error.status = status;
    error.statusCode = status;
    return error;
}

function normalizePrompt(value) {
    const prompt = String(value || '').replace(/\s+/g, ' ').trim();
    if (prompt.length < 4) throw draftError('请用一句话说明希望 Agent 持续完成的工作。');
    if (prompt.length > MAX_PROMPT_LENGTH) throw draftError(`持续目标描述不能超过 ${MAX_PROMPT_LENGTH} 个字符。`);
    return prompt;
}

function formatTime(hour, minute = 0, period = '') {
    let safeHour = Number(hour);
    let safeMinute = Number(minute || 0);
    if (!Number.isFinite(safeHour) || safeHour < 0 || safeHour > 23 || !Number.isFinite(safeMinute) || safeMinute < 0 || safeMinute > 59) return null;
    const value = String(period || '').toLowerCase();
    if (/(?:下午|晚上|傍晚|pm)/i.test(value) && safeHour >= 1 && safeHour <= 11) safeHour += 12;
    if (/(?:中午|noon)/i.test(value) && safeHour >= 1 && safeHour <= 10) safeHour += 12;
    if (/(?:凌晨|am|上午|早上)/i.test(value) && safeHour === 12) safeHour = 0;
    return `${String(safeHour).padStart(2, '0')}:${String(safeMinute).padStart(2, '0')}`;
}

function extractTime(prompt) {
    const colon = prompt.match(/(?:^|\s|每|在|于|到)(上午|早上|中午|下午|晚上|凌晨|am|pm)?\s*(\d{1,2})\s*[:：]\s*(\d{1,2})(?:\s|$|，|。|,|;|；)/i);
    if (colon) return formatTime(colon[2], colon[3], colon[1]);
    const chinese = prompt.match(/(?:^|\s|每|在|于|到)(上午|早上|中午|下午|晚上|凌晨|am|pm)?\s*(\d{1,2})\s*(?:点|時|时)(?:\s*(\d{1,2})\s*(?:分|分钟))?/i);
    if (chinese) return formatTime(chinese[2], chinese[3], chinese[1]);
    const english = prompt.match(/\b(?:at\s*)?(\d{1,2})(?::(\d{1,2}))?\s*(am|pm)\b/i);
    if (english) return formatTime(english[1], english[2], english[3]);
    if (/\bnoon\b|中午/i.test(prompt)) return '12:00';
    if (/\bmidnight\b|午夜/i.test(prompt)) return '00:00';
    return null;
}

function extractIntervalMinutes(prompt) {
    const match = prompt.match(/(?:每隔|每\s*隔|every)\s*(\d{1,4})\s*(分钟|分|小时|小時|天|day|days|hour|hours|minute|minutes)/i)
        || prompt.match(/(?:每|every)\s*(\d{1,4})\s*(分钟|分|小时|小時|天|day|days|hour|hours|minute|minutes)(?:\s*(?:一次|执行|运行|run))?/i);
    if (!match) return null;
    const quantity = Number.parseInt(match[1], 10);
    if (!Number.isFinite(quantity) || quantity <= 0) return null;
    const unit = String(match[2]).toLowerCase();
    const multiplier = /^(?:小时|小時|hour|hours)$/.test(unit) ? 60 : /^(?:天|day|days)$/.test(unit) ? 1440 : 1;
    const minutes = quantity * multiplier;
    return minutes >= 5 && minutes <= 24 * 60 ? minutes : null;
}

function extractWeekday(prompt) {
    const chinese = prompt.match(/(?:每周|每週|周|星期)\s*([一二三四五六日天])/);
    if (chinese) return WEEKDAY_MAP[chinese[1]];
    const english = prompt.match(/(?:every\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i);
    return english ? WEEKDAY_MAP[String(english[1]).toLowerCase()] : null;
}

function extractCronExpression(prompt) {
    const match = prompt.match(/\bcron\s*[:：]?\s*([^，,。;；\n]{3,120})/i);
    if (!match) return '';
    const expression = String(match[1] || '').trim();
    return expression.split(/\s+/).length === 5 ? expression : '';
}

function scheduleFromPrompt(prompt) {
    const intervalMinutes = extractIntervalMinutes(prompt);
    const timeOfDay = extractTime(prompt) || '09:00';
    const cronExpression = extractCronExpression(prompt);
    if (cronExpression) return {
        triggerSpec: { type: 'timer', frequency: 'cron', timeOfDay, dayOfWeek: 1, intervalMinutes: 60, cronExpression },
        label: `Cron：${cronExpression}`,
        confidence: 'high'
    };
    if (intervalMinutes) return {
        triggerSpec: { type: 'timer', frequency: 'interval', timeOfDay, dayOfWeek: 1, intervalMinutes, cronExpression: '' },
        label: `每隔 ${intervalMinutes >= 60 && intervalMinutes % 60 === 0 ? `${intervalMinutes / 60} 小时` : `${intervalMinutes} 分钟`}`,
        confidence: 'high'
    };
    if (/(?:工作日|每个工作日|周一至周五|周一到周五|weekdays?)/i.test(prompt)) return {
        triggerSpec: { type: 'timer', frequency: 'weekdays', timeOfDay, dayOfWeek: 1, intervalMinutes: 60, cronExpression: '' },
        label: `每个工作日 ${timeOfDay}`,
        confidence: extractTime(prompt) ? 'high' : 'medium'
    };
    const dayOfWeek = extractWeekday(prompt);
    if (dayOfWeek !== null) return {
        triggerSpec: { type: 'timer', frequency: 'weekly', timeOfDay, dayOfWeek, intervalMinutes: 60, cronExpression: '' },
        label: `每周${['日', '一', '二', '三', '四', '五', '六'][dayOfWeek]} ${timeOfDay}`,
        confidence: extractTime(prompt) ? 'high' : 'medium'
    };
    if (/(?:每天|每日|每一天|daily|every\s+day)/i.test(prompt)) return {
        triggerSpec: { type: 'timer', frequency: 'daily', timeOfDay, dayOfWeek: 1, intervalMinutes: 60, cronExpression: '' },
        label: `每天 ${timeOfDay}`,
        confidence: extractTime(prompt) ? 'high' : 'medium'
    };
    return null;
}

function titleFromPrompt(prompt) {
    const compact = prompt
        .replace(/(?:每个工作日|工作日|每天|每日|每周[一二三四五六日天]?|每隔\s*\d+\s*(?:分钟|分|小时|小時|天)|cron\s*[:：]?\s*[*\d/,\-A-Za-z]+)/gi, '')
        .replace(/(?:上午|早上|中午|下午|晚上|凌晨)?\s*\d{1,2}(?::\d{1,2}|点(?:\d{1,2}分?)?)?/g, '')
        .replace(/(?:自动|定时|按时|提醒我|通知我|发给我)/g, '')
        .replace(/^[，,、\-：:\s]+|[，,、\-：:\s]+$/g, '')
        .trim();
    return (compact || '个人自动目标').slice(0, 80);
}

function extractTriggerIntent(prompt) {
    if (/(?:web\s*hook|回调地址|外部回调)/i.test(prompt)) return 'webhook';
    if (/(?:文件变更|目录变更|新文件|文件夹变更|folder\s+change|file\s+change)/i.test(prompt)) return 'file';
    if (/(?:数据库变更|数据表变更|增量查询|watermark|水位线)/i.test(prompt)) return 'database';
    if (/(?:仅手动|手动触发|manual\s+only)/i.test(prompt)) return 'manual';
    return 'timer';
}

function baseAuthorization() {
    return {
        toolPolicy: 'builtin_only',
        toolAllowlist: [],
        approvalPolicy: 'safe_mcp_auto',
        networkPolicy: {},
        expiresAt: null
    };
}

function baseBudget() {
    return {
        maxTokenBudget: 0,
        maxRunsPerWindow: 0,
        windowSeconds: 86400,
        maxSteps: 0
    };
}

function goalInputFromPrompt(prompt) {
    const intent = extractTriggerIntent(prompt);
    const title = titleFromPrompt(prompt);
    const missingFields = [];
    const warnings = [];
    let triggerSpec;
    let scheduleLabel = '';

    if (intent === 'timer') {
        const schedule = scheduleFromPrompt(prompt);
        if (!schedule) {
            missingFields.push({ key: 'schedule', label: '执行时间或周期', hint: '例如“每个工作日 09:00”或“每隔 2 小时”。' });
            triggerSpec = { type: 'timer', frequency: 'daily', timeOfDay: '09:00', dayOfWeek: 1, intervalMinutes: 60, cronExpression: '' };
            scheduleLabel = '待补充执行周期';
        } else {
            triggerSpec = schedule.triggerSpec;
            scheduleLabel = schedule.label;
            if (schedule.confidence !== 'high') warnings.push('未识别到明确时间，暂按默认 09:00 生成；请在确认前核对。');
        }
    } else if (intent === 'webhook') {
        triggerSpec = { type: 'webhook', requireSignature: true, replayWindowSeconds: 300, inputMapping: {}, sourceAllowlist: [] };
        scheduleLabel = '收到受签名 Webhook 时触发';
        warnings.push('创建时会生成一次性 Webhook 访问令牌；请在保存后妥善保管。');
    } else if (intent === 'file') {
        triggerSpec = { type: 'file', directory: '', inputName: 'filePath', extensions: [], stableSeconds: 5, watermark: '' };
        scheduleLabel = '受控目录出现稳定写入文件时触发';
        missingFields.push({ key: 'directory', label: '受控目录', hint: '请选择已经由管理员配置为可监听的目录。' });
    } else if (intent === 'database') {
        triggerSpec = { type: 'database', connectionId: '', query: '', watermarkField: 'updated_at', watermark: '', inputName: 'rows' };
        scheduleLabel = '只读增量查询发现数据变化时触发';
        missingFields.push({ key: 'connectionId', label: '数据库连接', hint: '请选择当前账号可用的只读数据库连接。' });
        missingFields.push({ key: 'query', label: '只读水位线查询', hint: '查询必须包含 {{watermark}}，且只能读取数据。' });
    } else {
        triggerSpec = { type: 'manual' };
        scheduleLabel = '仅在用户手动运行时执行';
    }

    const deliveryHint = /(?:发给我|通知我|推送|发送到|send\s+(?:me|to))/i.test(prompt)
        ? { mode: 'inbox', requiresChannelSelection: true, label: '任务完成后通知我（默认进入待办中心）' }
        : { mode: 'inbox', requiresChannelSelection: false, label: '结果进入待办中心' };
    if (deliveryHint.requiresChannelSelection) warnings.push('外部消息渠道需要在通知设置中完成绑定；未绑定时结果仍会进入待办中心。');

    return {
        title,
        goal: prompt,
        triggerSpec,
        authorizationSpec: baseAuthorization(),
        budgetSpec: baseBudget(),
        cooldownSeconds: 300,
        maxFailures: 5,
        status: 'active',
        scheduleLabel,
        deliveryHint,
        missingFields,
        warnings
    };
}

function draftSecret(options = {}) {
    const value = String(options.secret || process.env.AGENT_GOAL_DRAFT_SECRET || process.env.DATA_ENCRYPTION_KEY || process.env.JWT_SECRET || '').trim();
    if (!value) throw draftError('服务端未配置目标草案签名密钥，无法安全确认持续目标。', 'AGENT_GOAL_DRAFT_SIGNING_UNAVAILABLE', 503);
    return value;
}

function encode(value) {
    return Buffer.from(canonicalJson(value), 'utf8').toString('base64url');
}

function sign(encoded, secret) {
    return crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
}

function safeEqual(left, right) {
    const a = Buffer.from(String(left || ''));
    const b = Buffer.from(String(right || ''));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function createGoalDraft(user, text, options = {}) {
    if (!user?.id) throw draftError('当前账号无效，无法生成持续目标草案。', 'AGENT_GOAL_DRAFT_USER_REQUIRED', 401);
    const prompt = normalizePrompt(text);
    const parsed = goalInputFromPrompt(prompt);
    const canConfirm = parsed.missingFields.length === 0;
    const now = Number(options.now || Date.now());
    const expiresAt = new Date(now + DRAFT_TTL_MS).toISOString();
    const goalInput = {
        title: parsed.title,
        goal: parsed.goal,
        triggerSpec: parsed.triggerSpec,
        authorizationSpec: parsed.authorizationSpec,
        budgetSpec: parsed.budgetSpec,
        cooldownSeconds: parsed.cooldownSeconds,
        maxFailures: parsed.maxFailures,
        status: parsed.status
    };
    let confirmationToken = null;
    if (canConfirm) {
        const payload = { v: DRAFT_VERSION, userId: Number(user.id), expiresAt, goalInput };
        const encoded = encode(payload);
        confirmationToken = `${encoded}.${sign(encoded, draftSecret(options))}`;
    }
    return {
        draft: {
            version: DRAFT_VERSION,
            title: parsed.title,
            goal: parsed.goal,
            triggerSpec: parsed.triggerSpec,
            authorizationSpec: parsed.authorizationSpec,
            budgetSpec: parsed.budgetSpec,
            cooldownSeconds: parsed.cooldownSeconds,
            maxFailures: parsed.maxFailures,
            scheduleLabel: parsed.scheduleLabel,
            deliveryHint: parsed.deliveryHint,
            missingFields: parsed.missingFields,
            warnings: parsed.warnings,
            canConfirm,
            expiresAt
        },
        confirmationToken
    };
}

function confirmedGoalDraftInput(user, token, options = {}) {
    const parts = String(token || '').split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) throw draftError('持续目标草案确认凭据无效，请重新生成草案。', 'AGENT_GOAL_DRAFT_TOKEN_INVALID', 409);
    const [encoded, signature] = parts;
    if (!safeEqual(signature, sign(encoded, draftSecret(options)))) throw draftError('持续目标草案已变更或确认凭据无效，请重新生成草案。', 'AGENT_GOAL_DRAFT_TOKEN_INVALID', 409);
    let payload;
    try { payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); }
    catch (_) { throw draftError('持续目标草案确认凭据无效，请重新生成草案。', 'AGENT_GOAL_DRAFT_TOKEN_INVALID', 409); }
    if (payload?.v !== DRAFT_VERSION || Number(payload.userId) !== Number(user?.id)) throw draftError('该持续目标草案不属于当前账号。', 'AGENT_GOAL_DRAFT_SCOPE_DENIED', 403);
    if (!payload.expiresAt || new Date(payload.expiresAt).getTime() <= Number(options.now || Date.now())) throw draftError('持续目标草案已过期，请重新生成并确认。', 'AGENT_GOAL_DRAFT_TOKEN_EXPIRED', 409);
    if (!payload.goalInput || typeof payload.goalInput !== 'object' || Array.isArray(payload.goalInput)) throw draftError('持续目标草案内容无效，请重新生成。', 'AGENT_GOAL_DRAFT_TOKEN_INVALID', 409);
    return payload.goalInput;
}

// 草案的目标、触发源、工具授权与预算保持签名不可变。用户在确认页可显式选择的
// 模型策略、时区、结果保留期和已拥有的投递渠道是独立的展示项，按白名单合并。
function mergeConfirmedGoalDraftOverrides(goalInput, overrides = {}) {
    const raw = overrides && typeof overrides === 'object' && !Array.isArray(overrides) ? overrides : {};
    const authorization = raw.authorizationSpec && typeof raw.authorizationSpec === 'object' ? raw.authorizationSpec : {};
    const allowed = {};
    for (const key of ['modelId', 'modelRouter', 'timezone', 'deliveryBindingIds', 'resultRetentionDays']) {
        if (Object.prototype.hasOwnProperty.call(authorization, key)) allowed[key] = authorization[key];
    }
    return {
        ...goalInput,
        authorizationSpec: { ...(goalInput.authorizationSpec || {}), ...allowed }
    };
}

module.exports = {
    DRAFT_TTL_MS,
    confirmedGoalDraftInput,
    mergeConfirmedGoalDraftOverrides,
    createGoalDraft,
    extractIntervalMinutes,
    extractTime,
    scheduleFromPrompt
};
