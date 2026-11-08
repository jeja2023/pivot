'use strict';

function intent(purpose, stage = 'content') { return { purpose, takeaway: purpose, bridgeToNext: '根据前页材料安排后续行动', stage, relation: 'sequence', durationSeconds: 40 }; }
function turn(messages) {
    const system = String(messages.find(message => message.role === 'system')?.content || ''), prompt = String(messages.find(message => message.role === 'user')?.content || '');
    if (system.includes('PPT故事线调整规划器')) {
        const data = JSON.parse(prompt), slide = data.editablePages[0], heading = slide.text.find(item => item.elementId === 'title') || slide.text[0];
        return { summary: '先核对材料，再明确后续行动。', slideOrder: data.scope === 'deck' && data.instruction.includes('重排') ? [...data.slideOrder].reverse() : data.slideOrder,
            updates: [{ slideId: slide.id, reason: '明确本页要完成的行动', intent: intent('先核对材料，再落实行动', 'action'), textEdits: [{ elementId: heading.elementId, text: '先核对材料，再落实行动' }] }] };
    }
    if (prompt.includes('outline 总页数')) {
        const count = Number(prompt.match(/目标页数：(\d+)/)?.[1] || 3);
        return { title: '创建目标验收', outline: [{ section: '汇报', slides: Array.from({ length: count }, (_, index) => ({ title: ['说明当前情况', '核对原始材料', '明确后续行动'][index % 3], purpose: '形成可执行的安排', layoutHint: index === 0 ? 'design-cover' : 'design-content', keyPoints: ['根据已提供材料作出安排'], sourceRefs: [] })) }], assumptions: [], warnings: [] };
    }
    const outline = JSON.parse(prompt.match(/^大纲：(.*)$/m)?.[1] || '{}'), slides = (outline.outline || []).flatMap(section => section.slides || []);
    return { title: outline.title || '创建目标验收', slides: slides.map((slide, index) => ({ title: slide.title, layout: index === 0 ? 'cover' : 'content', points: slide.keyPoints, speakerNotes: '需要使用者核对具体材料。', sourceRefs: [], intent: intent(slide.purpose, index === 0 ? 'opening' : 'action') })), assumptions: [], warnings: [] };
}
module.exports = { turn };
