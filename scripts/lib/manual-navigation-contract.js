'use strict';

function describesRemovedTaskWorkspace(text) {
    // 只识别旧入口名称，不能把“任务运行时先等待完成”等正常状态说明误判成导航。
    return /(?:[“「《]|\*\*|`)任务运行(?:[”」》]|\*\*|`)|(?:打开|进入|点击|切换到)\s*任务运行(?:工作区|页面|页|入口|标签)|任务运行(?:工作区|页面|入口)|^#{1,6}\s*任务运行\s*$/m.test(text);
}
module.exports = { describesRemovedTaskWorkspace };
