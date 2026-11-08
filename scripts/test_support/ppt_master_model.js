'use strict';

// 浏览器验收模型：提供确定操作序列，真实文件仍由完整上游引擎校验及导出。
function pptMasterModelTurn(messages) {
    const request = messages.filter(item => item.role === 'user').map(item => { try { return JSON.parse(item.content); } catch (_) { return null; } }).find(item => item?.operation);
    const assistant = messages.filter(item => item.role === 'assistant').map(item => { try { return JSON.parse(item.content); } catch (_) { return {}; } });
    if (request?.instruction?.includes('E2E_MASTER_CONFIRM') && !assistant.some(item => item.requestInput)) return { requestInput: { kind: 'clarification', question: '是否保留材料中的原始金额？', context: '将使用收入120万元、成本80万元制作单页技术验收稿。' } };
    if (!assistant.some(item => item.actions?.some(action => action.tool === 'project'))) return { message: '初始化真实上游项目。', actions: [
        { action: 'run', tool: 'project', args: ['init', 'master_e2e', '--dir', '.', '--quick-generate'] }, { action: 'list' }
    ] };
    const observations = messages.filter(item => item.role === 'user').flatMap(item => { try { const value = JSON.parse(item.content); return Array.isArray(value) ? value : []; } catch (_) { return []; } });
    const project = observations.flatMap(item => item.result?.files || []).find(item => item.path.includes('/validation/workflow.log'))?.path.split('/')[0];
    if (!project) return { actions: [{ action: 'list' }] };
    if (!assistant.some(item => item.actions?.some(action => action.tool === 'export'))) {
        const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720" lang="zh-CN" data-pptx-page-role="content"><rect id="background" x="0" y="0" width="1280" height="720" fill="#F7F9FC"/><g id="heading" data-pptx-bounds="88 60 1104 110"><text x="88" y="128" font-family="Noto Sans CJK SC" font-size="44" fill="#17324D">完整制作端到端验收</text></g><g id="evidence" data-pptx-bounds="88 220 1104 300"><text x="128" y="310" font-family="Noto Sans CJK SC" font-size="32" fill="#17324D">收入120万元，成本80万元。</text></g></svg>';
        return { message: '由真实上游检查器与导出器生成文件。', actions: [
            { action: 'write', path: project + '/svg_output/slide_01.svg', text: svg },
            { action: 'run', tool: 'check_svg', args: [project, '--quick-generate', '--stage', 'final', '--json'] },
            { action: 'run', tool: 'export', args: [project, '--quick-generate', '-o', project + '/exports/final.pptx'] }
        ] };
    }
    return { message: '交付真实文件。', complete: { path: project + '/exports/final.pptx' } };
}
module.exports = { pptMasterModelTurn };
