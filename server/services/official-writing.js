// 公文写作 AI 服务：集中承载提示词组装、模式校验与审校结果解析。
// 把这部分逻辑从前端搬到后端，便于统一审计、规范库策略、敏感内容控制与日志。

// 支持的全文/审校模式标签，用于审计与提示。
const OFFICIAL_WRITING_MODE_LABELS = {
    draft: '起草正文',
    polish: '润色优化',
    rewrite_section: '全文改写',
    review: '格式与表达审校',
    selection: '选区处理',
    rewrite_stream: '逐句改写'
};

// 可流式输出的模式集合：文本类模式逐字返回即可；
// review 模式需在后端把整段输出解析为结构化 JSON 条目，必须拿到完整文本，故不在此列。
const OFFICIAL_WRITING_STREAMABLE_MODES = new Set([
    'draft',
    'polish',
    'rewrite_section',
    'selection',
    'rewrite_stream'
]);

// 选区浮动工具条动作 -> 指令。
const OFFICIAL_WRITING_SELECTION_INSTRUCTIONS = {
    polish: '对以下公文片段进行润色，使表达更规范、准确、流畅，保持原意和事实不变。',
    compress: '在保留关键信息和事实的前提下，精炼压缩以下公文片段，使其更简洁。',
    expand: '在不编造事实的前提下，对以下公文片段进行合理扩写，补充必要的表述和逻辑衔接。',
    formal: '将以下片段改写为规范、庄重、克制的公文语体，保持事实信息不变。'
};

function buildSystemPrompt(standard) {
    return [
        '你是资深公文写作助手，熟悉中文党政机关与企事业单位公文规范。',
        `当前遵循的规范库：${standard || '通用公文规范'}。`,
        '务必使用规范、准确、庄重、克制的公文语体，不编造单位、时间、数据和事实；缺失信息用【待补充】标注。',
        '严格只输出被要求的内容，不要附加解释、寒暄或额外说明。'
    ].join('\n');
}

// 根据结构化参数组装公文写作的 messages 与模式标签。
// 输出长度不再由公文模式内置默认值约束，完全交由模型配置 / 全局上下文预算决定。
// 入参字段全部为可选字符串/对象，缺失时取安全默认值。校验失败时抛出 Error（由路由转为 400）。
function buildOfficialWritingMessages(params = {}) {
    const mode = String(params.mode || '').trim();
    if (!OFFICIAL_WRITING_MODE_LABELS[mode]) {
        throw new Error(`不支持的公文写作模式：${mode || '(空)'}`);
    }
    const docType = String(params.docType || '通知').trim() || '通知';
    const standard = String(params.standard || '通用公文规范').trim() || '通用公文规范';
    const requirements = String(params.requirements || '').trim();
    const comments = String(params.comments || '').trim();
    const source = String(params.source || '').trim();
    const draft = String(params.draft || '').trim();
    const selectionText = String(params.selection?.text || '').trim();
    const baseText = selectionText || draft;

    const userLines = [];

    if (mode === 'draft') {
        userLines.push(`请基于以下材料和要求，起草一篇规范的「${docType}」，包含标题、主送机关、正文、落款单位和成文日期。`);
        userLines.push('只输出公文正文本身，不要输出任何说明。');
        if (requirements) userLines.push(`补充要求：${requirements}`);
        userLines.push('', '材料：', source || '【暂无材料，请基于文种结构生成规范初稿，未知信息用【待补充】标注】');
    } else if (mode === 'review') {
        userLines.push(`请审校以下「${docType}」的格式与表达，逐项指出问题。`);
        userLines.push('以 JSON 数组输出，数组每一项为对象，字段为：title（问题简述）、original（涉及的原文片段，可为空字符串）、suggestion（具体修改建议）。');
        userLines.push('只输出 JSON，不要输出其它内容。');
        if (requirements) userLines.push(`额外关注：${requirements}`);
        userLines.push('', '正文稿：', draft || '【暂无正文稿】');
    } else if (mode === 'selection') {
        const action = String(params.action || '').trim();
        const instruction = OFFICIAL_WRITING_SELECTION_INSTRUCTIONS[action];
        if (!instruction) throw new Error(`不支持的选区动作：${action || '(空)'}`);
        if (!selectionText) throw new Error('选区内容为空。');
        userLines.push(instruction);
        userLines.push('只输出处理后的文本，不要输出任何说明。');
        if (requirements) userLines.push(`补充要求：${requirements}`);
        userLines.push('', '待处理片段：', selectionText);
    } else if (mode === 'rewrite_stream') {
        if (!selectionText) throw new Error('待改写片段为空。');
        userLines.push('请将以下公文片段改写为更规范、准确、克制的公文语体，保持事实信息不变。');
        userLines.push('逐句改写，尽量与原文句子一一对应，只输出改写后的文本，不要输出说明。');
        if (requirements) userLines.push(`补充要求：${requirements}`);
        userLines.push('', '待改写片段：', selectionText);
    } else {
        // polish / rewrite_section
        if (!baseText) throw new Error('待处理文本为空。');
        const verb = mode === 'rewrite_section' ? '改写为规范的公文语体' : '润色优化';
        userLines.push(`请将以下「${docType}」文本${verb}，保持事实信息不变，使其更规范、准确、克制。`);
        userLines.push('只输出处理后的文本，不要输出任何说明。');
        if (requirements) userLines.push(`补充要求：${requirements}`);
        userLines.push('', '待处理文本：', baseText);
    }

    // 全文类模式（审校/润色/全文改写）携带批注作为参考；起草、选区与逐句改写不带。
    if (comments && (mode === 'review' || mode === 'polish' || mode === 'rewrite_section')) {
        userLines.push('', '相关批注（请一并参考）：', comments);
    }

    return {
        mode,
        modeLabel: OFFICIAL_WRITING_MODE_LABELS[mode],
        messages: [
            { role: 'system', content: buildSystemPrompt(standard) },
            { role: 'user', content: userLines.join('\n') }
        ]
    };
}

// 解析审校模式下模型返回的 JSON 数组；兼容包裹在代码块或带前后说明的情况。
// 仅保留结构合法的对象，并把字段规整为字符串，避免下游处理脏数据。
function parseOfficialWritingReviewItems(text) {
    if (!text) return [];
    let cleaned = String(text).replace(/```(?:json)?/gi, '').trim();
    const firstBracket = cleaned.indexOf('[');
    const lastBracket = cleaned.lastIndexOf(']');
    if (firstBracket >= 0 && lastBracket > firstBracket) {
        cleaned = cleaned.slice(firstBracket, lastBracket + 1);
    }
    let parsed;
    try {
        parsed = JSON.parse(cleaned);
    } catch (e) {
        return [];
    }
    if (!Array.isArray(parsed)) return [];
    return parsed
        .filter(item => item && typeof item === 'object' && !Array.isArray(item))
        .map(item => ({
            title: String(item.title || '').trim(),
            original: String(item.original || ''),
            suggestion: String(item.suggestion || '').trim()
        }))
        // 至少要有问题简述或修改建议才算有效条目。
        .filter(item => item.title || item.suggestion);
}

module.exports = {
    OFFICIAL_WRITING_MODE_LABELS,
    OFFICIAL_WRITING_STREAMABLE_MODES,
    OFFICIAL_WRITING_SELECTION_INSTRUCTIONS,
    buildOfficialWritingMessages,
    parseOfficialWritingReviewItems
};
