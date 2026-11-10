'use strict';
const { queryOne } = require('../db/client');
// 调用方先校验当前发布的 use 权限；只按已授权发布绑定的版本读取路径，绝不接受客户端路径。
async function readVersion(id) {
    return await queryOne('SELECT id,package_path,digest,content_digest,manifest_json,manifest_yaml,signing_envelope_id FROM agent_skill_versions WHERE id=?', [id]);
}
module.exports = { readVersion };
