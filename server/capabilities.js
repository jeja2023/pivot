const unsupportedCapabilities = [
    {
        code: 'image_generation',
        title: '图片生成',
        examples: ['生成图片', '画一张图', '文生图', 'AI 绘画'],
        patterns: [
            /(?:生成|画|绘制|做|出|创建)(?:一张|一个|一下|些|几张)?[^。！？\n]{0,24}(?:图片|图像|插画|海报|头像|壁纸|封面|logo|照片)/i,
            /(?:生图|文生图|图生图|ai\s*绘画|image\s*generation|generate\s+(?:an?\s+)?image|draw\s+(?:me\s+)?(?:an?\s+)?image)/i
        ]
    },
    {
        code: 'video_generation',
        title: '视频生成',
        examples: ['生成视频', '文生视频', '剪辑视频'],
        patterns: [
            /(?:生成|制作|剪辑|合成|导出)(?:一段|一个|一下)?[^。！？\n]{0,24}(?:视频|短视频|动画|影片)/i,
            /(?:文生视频|图生视频|text\s*to\s*video|generate\s+(?:a\s+)?video)/i
        ]
    },
    {
        code: 'audio_generation',
        title: '音频生成',
        examples: ['生成语音', '配音', '生成音乐'],
        patterns: [
            /(?:生成|合成|制作|朗读|配)(?:一段|一个|一下)?[^。！？\n]{0,24}(?:语音|音频|配音|音乐|歌曲|旁白)/i,
            /(?:text\s*to\s*speech|tts|generate\s+(?:an?\s+)?audio)/i
        ]
    },
    {
        code: 'realtime_web',
        title: '实时联网检索',
        examples: ['联网搜索', '查询今天新闻', '获取实时价格'],
        patterns: [
            /(?:联网|上网|实时|今天|今日|最新|刚刚|当前|现在)[^。！？\n]{0,24}(?:搜索|查询|检索|新闻|价格|股价|汇率|天气|比赛|政策|法规)/i,
            /(?:search\s+the\s+web|browse\s+the\s+web|latest\s+news|real[-\s]?time)/i
        ]
    }
];

const supportIntentPatterns = [
    /(?:怎么|如何|怎样|帮我)?(?:写|实现|设计|规划|分析|解释|优化|生成)(?:一个|一段|一下)?[^。！？\n]{0,30}(?:代码|脚本|方案|提示词|prompt|流程|接口|组件|配置)/i,
    /(?:生图|视频|音频|联网|搜索)[^。！？\n]{0,30}(?:提示词|prompt|方案|代码|接口|配置|怎么做|如何做)/i
];

function detectUnsupportedCapability(content) {
    const text = String(content || '').trim();
    if (!text) return null;

    const asksForSupportArtifact = supportIntentPatterns.some(pattern => pattern.test(text));
    if (asksForSupportArtifact) return null;

    return unsupportedCapabilities.find(capability => (
        capability.patterns.some(pattern => pattern.test(text))
    )) || null;
}

function buildCapabilityFallbackMessage(capability) {
    const examples = capability.examples.join('、');
    return [
        `当前系统还没有接入“${capability.title}”执行能力，所以我不能直接完成这类操作。`,
        '',
        `你刚才的请求属于：${examples}。`,
        '',
        '我可以继续帮你做这些可完成的部分：',
        '',
        '1. 改写成可用于专业工具的提示词。',
        '2. 设计实现方案、接口字段和工作流。',
        '3. 帮你配置或接入对应能力模型。',
        '4. 如果你提供生成结果或素材，我可以帮你分析、修改文案和整理使用说明。'
    ].join('\n');
}

module.exports = {
    detectUnsupportedCapability,
    buildCapabilityFallbackMessage
};
