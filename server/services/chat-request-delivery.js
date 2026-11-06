'use strict';

const { currentRequestText } = require('./chat-request-constraints');
const { requestedPresentationFormats } = require('./task-display-title');

function requiresNonTextProcessing(prompt = '') {
    const text = currentRequestText(prompt);
    if (requestedPresentationFormats(text).length) return true;
    // 快速路径只承载纯文本分析；无法确定操作是否被否定时仍交给语义层消歧。
    return /导出|下载|保存|发送|制作|删除|移动|重命名|更新|导入|写入|执行|运行|安装|上传到|合并|拆分|转换|生成.{0,24}(?:文件|Word|PDF|Excel|PPT|docx|xlsx)|修改.{0,12}文件/iu.test(text)
        || /(?:做成|转成|输出|交付|给我|整理成).{0,24}(?:文件|文档|演示文稿|幻灯片|\b(?:word|pdf|excel|pptx?|docx|xlsx|csv|png|svg)\b)/iu.test(text)
        || /\b(?:export|download|save|send|create|generate|make|convert|delete|remove|move|rename|update|import|write|execute|run|install|upload|merge|split)\b/iu.test(text);
}

module.exports = { requiresNonTextProcessing };
