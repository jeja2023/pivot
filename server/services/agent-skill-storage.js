'use strict';

const path = require('node:path');

// 导入、读取与备份必须定位同一持久目录，显式覆盖仅供受控内部调用。
function resolveSkillStorageRoot(env = process.env, projectRoot = path.resolve(__dirname, '../..')) {
    return path.resolve(String(env.AGENT_SKILL_ROOT || '').trim()
        || path.join(env.DATA_DIR || path.join(projectRoot, 'data'), 'agent-skills'));
}

module.exports = { resolveSkillStorageRoot };
