const { query } = require('../db/client');
const { isSuperAdmin } = require('../permissions');
const { setAppSettingAsync } = require('./app-settings');

const APP_NAMES = Object.freeze({
    mindmaps: '思维导图',
    presentations: 'PPT 制作',
    'official-writing': '公文写作',
    'data-analysis': '数据分析',
    'data-modeling': '数据建模',
    regulations: '法规查询',
    ocr: '文字识别',
    'pdf-tools': 'PDF 工具'
});
const settingKey = id => `app_enabled:${id}`;

async function getAppAvailability() {
    const ids = Object.keys(APP_NAMES);
    const rows = await query(`SELECT key, value FROM app_settings WHERE key IN (${ids.map(() => '?').join(', ')})`, ids.map(settingKey));
    const settings = new Map(rows.map(row => [row.key, row.value]));
    // 旧安装没有开关记录时保留原有入口；已写入的异常值不放开应用。
    return ids.map(id => ({ id, name: APP_NAMES[id], enabled: !settings.has(settingKey(id)) || settings.get(settingKey(id)) === 'true' }));
}

async function getAppCatalog(user) {
    const canManage = isSuperAdmin(user);
    const apps = await getAppAvailability();
    return { canManage, apps: canManage ? apps : apps.filter(app => app.enabled) };
}

async function updateAppAvailability(user, id, enabled) {
    if (!isSuperAdmin(user)) throw Object.assign(new Error('仅系统 admin 账号可以开启或关闭应用。'), { status: 403, code: 'APP_MANAGEMENT_FORBIDDEN' });
    if (!Object.hasOwn(APP_NAMES, id)) throw Object.assign(new Error('应用不存在，请刷新应用中心后重试。'), { status: 404, code: 'APP_NOT_FOUND' });
    if (typeof enabled !== 'boolean') throw Object.assign(new Error('开启状态必须为布尔值，请重新操作。'), { status: 400, code: 'INVALID_APP_ENABLED' });
    await setAppSettingAsync(settingKey(id), String(enabled), { updatedBy: user.id });
    return { id, name: APP_NAMES[id], enabled };
}

module.exports = { getAppAvailability, getAppCatalog, updateAppAvailability };
