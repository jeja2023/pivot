'use strict';

// PPT Master 风格只定义表达方式。示例内容用于展示如何应用风格。
const examples = {
    'academic-research': ['研究结果', '分组教学提高了任务完成率', 'chart', '#205A8C', ['对照组', '分组教学'], [62, 84]],
    'consulting-decision': ['决策建议', '先在高需求区域试点', 'split', '#156A61', ['优先投向成熟区域', '需求明确，现有团队可直接承接', '试点达到目标后再扩展', '以完成率和单位成本判断']],
    'creative-pitch': ['创意提案', '把等候时间变成体验', 'hero', '#66358C', ['让等候者即时了解进度，也能在离开前收到提醒']],
    'duty-manual': ['操作说明', '现场异常处理流程', 'flow', '#174B68', ['停止操作', '记录现象', '通知负责人']],
    'incident-postmortem': ['事件复盘', '服务中断与恢复', 'flow', '#93451C', ['09:10 · 发现异常', '09:25 · 确认原因', '09:40 · 恢复服务']],
    'investor-pitch': ['项目路演', '从试点验证到规模增长', 'metrics', '#4E469A', [['3 个', '已落地试点'], ['82%', '试点留存率'], ['6 个月', '下一阶段周期']]],
    'mbb-consulting': ['管理分析', '差距主要来自转化环节', 'chart', '#284A76', ['访问环节', '体验环节', '转化环节'], [18, 26, 56]],
    'narrative-keynote': ['主题演讲', '每一次协作都从信任开始', 'hero', '#164862', ['一个团队如何把分散的经验变成共同的方法']],
    'operating-review': ['经营复盘', '客户留存稳步改善', 'chart', '#286951', ['第一季度', '第二季度', '第三季度'], [64, 72, 81]],
    'product-launch': ['产品发布', '把分散的消息收进一个工作台', 'hero', '#254F9A', ['一个入口查看进展、补齐材料和交付成果']],
    'science-explainer': ['科普讲解', '水滴为什么会出现在杯壁？', 'flow', '#176D89', ['空气含有水汽', '水汽遇冷', '在杯壁凝结']],
    'solution-proposal': ['实施方案', '以小范围试点验证新流程', 'split', '#305F45', ['现状 · 多次重复录入', '信息分散且交接耗时', '方案 · 先接通一条流程', '以处理时间和返工率评估']],
    'technical-deepdive': ['技术详解', '数据从采集到服务的路径', 'flow', '#385775', ['采集与校验', '清洗与聚合', '查询与交付']],
    'workshop-teaching': ['培训研讨', '用一次练习掌握反馈方法', 'flow', '#8B4D27', ['观察一个案例', '小组实操', '复盘与反馈']]
};

function buildStyleExample(id) {
    const example = examples[id.replace(/^master-style-/, '')];
    if (!example) return null;
    const [label, title, layout, accent, items, data] = example;
    const elements = [];
    const text = (value, x, y, width, height, fontSize, color, fontWeight = 400) => {
        elements.push({ type: 'text', x, y, width, height, content: { text: value },
            style: { fontSize, color, fontWeight, fontFamily: 'Noto Sans SC', verticalAlign: 'middle', padding: 0 } });
    };
    const rect = (x, y, width, height, fill) => elements.push({ type: 'shape', shapeType: 'rect', x, y, width, height, style: { fill, strokeWidth: 0 } });
    const hero = layout === 'hero', ink = hero ? '#FFFFFF' : '#172639';
    const background = hero ? accent : '#FFFFFF';
    text(label, 80, 58, 1120, 38, 24, hero ? '#FFFFFF' : accent, 700);
    text(title, 80, hero ? 207 : 110, 1100, hero ? 185 : 111, hero ? 68 : 48, ink, 700);

    if (hero) {
        rect(80, 414, 110, 4, ink);
        text(items[0], 80, 447, 1110, 90, 32, ink);
    } else if (layout === 'chart') {
        const barWidth = 120, spacing = 336, left = 175, base = 565;
        rect(94, base, 1092, 2, '#D1DBE5');
        data.forEach((value, index) => {
            const x = left + index * spacing;
            const height = value * 3.3;
            rect(x, base - height, barWidth, height, accent);
            text(String(value) + '%', x, base - height - 47, 178, 42, 28, accent, 700);
            text(items[index], x, base + 14, 235, 50, 26, ink);
        });
    } else if (layout === 'split') {
        for (let index = 0; index < 2; index++) {
            const x = 80 + index * 585;
            rect(x, 268, 520, 4, accent);
            text(items[index * 2], x, 298, 515, 107, 36, ink, 700);
            text(items[index * 2 + 1], x, 426, 515, 120, 27, ink);
        }
    } else {
        items.forEach((item, index) => {
            const x = 80 + index * 380;
            rect(x, 306, 345, 3, accent);
            if (layout === 'metrics') {
                text(item[0], x, 333, 345, 103, 59, accent, 700);
                text(item[1], x, 449, 345, 86, 26, ink);
            } else {
                text(String(index + 1).padStart(2, '0'), x, 333, 345, 73, 42, accent, 700);
                text(item, x, 434, 345, 120, 29, ink, 700);
            }
        });
    }

    return { title, aspectRatio: '16:9', slides: [{ type: 'content', background: { fill: background }, elements }] };
}

module.exports = { buildStyleExample };
