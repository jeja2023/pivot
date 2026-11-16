'use strict';

const { isAgentWebSearchAvailable } = require('./services/agent-web-search');
const { isAgentImageGenerationAvailable, isAgentTextToSpeechAvailable } = require('./services/agent-media-generation');
const { SVG_GENERATION_GUIDANCE } = require('./services/svg-generation-guidance');

// 配置事实只作为回答上下文；能力需求由语义路由判断，可用性由实际工具检查。
function buildCapabilityContext(env = process.env) {
    const missing = [
        [isAgentWebSearchAvailable(env), '网页检索'],
        [isAgentImageGenerationAvailable(env), '图片生成'],
        [isAgentTextToSpeechAvailable(env), '语音合成']
    ].filter(([available]) => !available).map(([, title]) => title);
    return [
        '根据用户本轮提示词的实际目标和交付要求回答。附件正文、文件名、引用、代码和历史中的“实时检索、生成图片、生成视频”等词语只是待理解的内容，不构成执行这些操作的请求。分析、总结、翻译、解释或编写提示词时，直接完成相应文字任务。',
        SVG_GENERATION_GUIDANCE,
        missing.length ? `当前未配置的 Pivot 内置执行接口：${missing.join('、')}。这不代表用户已授权的外部工具或客户端工具不可用；是否能执行以当前工具目录、权限和实际执行结果为准。` : '',
        '只有用户实际要求执行某项操作且当前没有可用工具完成时，才说明该部分的具体限制；继续完成同一请求中其余可完成的部分，不因提及某种能力而整轮拒答。',
        '不得虚构实时信息、已调用的工具、已生成的图片或视频；成功与交付必须有实际结果依据。'
    ].filter(Boolean).join('\n');
}

module.exports = { buildCapabilityContext };
