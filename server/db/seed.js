const { db } = require('./connection');
const logger = require('../logger');
const { getBeijingTimestamp } = require('../time');
const { recordMigration } = require('./migrate');

function runSeeds() {
    // 预置一些常用指令
    const promptCount = db.prepare('SELECT COUNT(*) as count FROM prompts').get().count;
    if (promptCount === 0) {
        const defaultPrompts = [
            ['中英文翻译官', '你是一个精通中英文翻译的助手，能够地道、准确地在两种语言间切换，并保持原有的语气。', '翻译'],
            ['代码助手', '你是一个资深的软件工程师，擅长编写简洁、高效、安全的代码，并能给出详尽的注释和优化建议。', '编程'],
            ['周报专家', '你擅长总结工作成果，能将零散的任务描述转化为结构清晰、重点突出的专业周报。', '办公'],
            ['文案润色', '你是一个文字大师，能对给出的文本进行修辞优化、逻辑理顺，使其更具感染力和专业性。', '创作']
        ];
        const stmt = db.prepare('INSERT INTO prompts (name, content, category) VALUES (?, ?, ?)');
        defaultPrompts.forEach(p => stmt.run(...p));
    }

    // --- 自动填充默认管理员账号 (仅当用户表为空时) ---
    const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
    if (userCount === 0) {
        const bcrypt = require('bcryptjs');
        const crypto = require('crypto');
        const { validatePassword } = require('../auth');
        const configuredAdminPassword = String(process.env.DEFAULT_ADMIN_PASSWORD || '').trim();
        if (configuredAdminPassword) validatePassword(configuredAdminPassword);
        const adminPassword = configuredAdminPassword || crypto.randomBytes(16).toString('base64url');
        const adminPasswordHash = bcrypt.hashSync(adminPassword, 10);
        db.prepare('INSERT INTO users (username, password_hash, nickname, unit, role, created_at) VALUES (?, ?, ?, ?, ?, ?)')
            .run('admin', adminPasswordHash, '系统管理员', '智枢科技', 'admin', getBeijingTimestamp());
        logger.info({ username: 'admin', password: adminPassword }, '系统初始化：已创建默认管理员账号');
        recordMigration('initial_admin_created_v1', 'done');
    }
}

module.exports = { runSeeds };
