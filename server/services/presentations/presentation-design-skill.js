'use strict';

const { parseSkillSourceMarkdown } = require('../agent-skill-source');
const SOURCE = `---
schemaVersion: 1
id: presentation-design-zh
name: 中文演示文稿设计
version: 1.1.0
description: 根据材料规划完整演示，选择可用模板与语义布局，并检查渲染后的视觉结果。
capabilities: [document.render, conversation.read_source, model.invoke]
tools: [chat.read_source, presentation.design_info, presentation.create, presentation.export, presentation.review, presentation.relayout, presentation.review_deck]
inputs: { materials: string, audience: string, purpose: string }
outputs: { presentationId: string, pptx: string, review: object }
---

先完整读取已授权材料，明确受众、用途、每页核心信息及可核实的证据。详细事实进入讲稿或附录，不能为美观删除关键结论或编造数值。
先调用 presentation.design_info 查看可用模板与布局，再选择适合内容的设计。咨询式简报强调结论与证据，政企正式强调稳定层级，培训讲解强调步骤与案例。
比较用双栏，数值用指标或图表，过程用步骤或时间线，风险用风险与措施，责任与时限用行动页。整稿保持主题一致，避免每页堆满彩色卡片。
一次规划全部页面，使用模板提供的语义布局与槽位，不猜测坐标或不存在的工具。布局引擎以真实字体容量安排页面，必要时完整拆页并报告实际页数。先完成主体再补封面与总结，来源、数字和讲稿须能回到材料核对。
投屏正文通常不低于18pt。放不下时先调整分组、换布局或拆页，详细文字可移入讲稿，禁止静默截断或无限缩字。用户已锁定或批准的页面不能自动改动。
图片仅使用用户有权使用的受控素材引用，正文、主要图表及表格保持可编辑。没有素材时优先使用清晰的原生图表或文字结构。
生成后检查版式与渲染结果。支持图像输入的模型可通过 presentation.review 逐页视觉复核，检查截断、遮挡、可读性和焦点。未配置视觉模型时明确报告尚未视觉复核，不得声称通过。
整稿可通过presentation.review_deck登记后台检查，再用operation=status查询实际结果。排版优化生成建议，用户在工作台确认后应用，不在后台覆盖源稿；已批准页面与锁定元素保持原样。登记任务不是检查通过，原稿变化后需要重新检查。
需要调整时使用 presentation.relayout 对指定页重新排版，或根据具体问题重新提交内容。最多自动修正两轮，重测受影响页面。完成后导出真实PPTX，只有单页图片或文字大纲不算整稿交付。
`;

const parsed = parseSkillSourceMarkdown(SOURCE);
function getPresentationDesignSkill() { return { ...parsed, source: SOURCE, builtIn: true }; }
module.exports = { getPresentationDesignSkill };
