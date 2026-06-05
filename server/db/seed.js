const { db } = require('./connection');
const { logger } = require('../logger');
const { getBeijingTimestamp } = require('../time');
const { recordMigration } = require('./migrate');
const fs = require('fs');
const path = require('path');

function validateInitialPassword(password) {
    if (!password || password.length < 8) {
        throw new Error('默认管理员密码长度至少需要 8 位');
    }
    if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
        throw new Error('默认管理员密码必须同时包含字母和数字');
    }
}

function buildInitialAdminCredential() {
    const bcrypt = require('bcryptjs');
    const crypto = require('crypto');
    const configuredAdminPassword = String(process.env.DEFAULT_ADMIN_PASSWORD || '').trim();
    if (configuredAdminPassword) validateInitialPassword(configuredAdminPassword);
    const password = configuredAdminPassword || crypto.randomBytes(16).toString('base64url');
    return {
        configured: Boolean(configuredAdminPassword),
        password,
        passwordHash: bcrypt.hashSync(password, 10)
    };
}

function writeInitialAdminCredentialFile(password) {
    const credentialPath = path.resolve(process.env.DATA_DIR || path.join(__dirname, '../../data'), 'initial-admin-password.txt');
    fs.writeFileSync(credentialPath, `username=admin\npassword=${password}\ncreated_at=${getBeijingTimestamp()}\n`, { mode: 0o600 });
    return credentialPath;
}

function logInitialAdminCredential(credential) {
    if (credential.configured) {
        logger.info({ username: 'admin' }, '系统初始化：已使用环境变量 DEFAULT_ADMIN_PASSWORD 创建管理员账号');
        return;
    }
    const credentialPath = writeInitialAdminCredentialFile(credential.password);
    logger.warn({ username: 'admin', credentialPath }, '系统初始化：已创建随机管理员密码，请读取该一次性文件后尽快修改密码并删除文件');
}

function createInitialAdminAccount() {
    const credential = buildInitialAdminCredential();
    db.prepare('INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run('admin', credential.passwordHash, '系统管理员', '智枢科技', 'admin', 'active', getBeijingTimestamp());
    logInitialAdminCredential(credential);
    recordMigration('initial_admin_created_v1', 'done');
}

function ensureBuiltInAdminAccount() {
    const admin = db.prepare('SELECT id, role, status, deleted_at FROM users WHERE username = ?').get('admin');
    if (!admin) {
        createInitialAdminAccount();
        return;
    }

    const needsRepair = admin.role !== 'admin' || admin.status === 'disabled' || admin.deleted_at;
    if (!needsRepair) return;

    db.prepare(`
        UPDATE users
        SET role = 'admin',
            status = 'active',
            deleted_at = NULL,
            nickname = COALESCE(NULLIF(nickname, ''), '系统管理员'),
            unit = COALESCE(NULLIF(unit, ''), '智枢科技')
        WHERE id = ?
    `).run(admin.id);
    recordMigration('initial_admin_repaired_v1', 'done');
    logger.warn({ username: 'admin', userId: admin.id }, '系统初始化：已修复内置 admin 账号角色或状态');
}

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
        createInitialAdminAccount();
    } else {
        ensureBuiltInAdminAccount();
    }
}

module.exports = { runSeeds, ensureBuiltInAdminAccount, validateInitialPassword };
