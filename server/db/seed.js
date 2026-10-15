/**
 * server/db/seed.js
 * 数据库初始数据填充（PostgreSQL）
 *
 * 主数据库仅支持 PostgreSQL。
 */
const { logger } = require('../logger');
const { getBeijingTimestamp } = require('../time');
const fs = require('fs');
const path = require('path');
const { getPasswordValidationMessage } = require('../password-policy');

function validateInitialPassword(password) {
    const message = getPasswordValidationMessage(password);
    if (message) throw new Error(`默认管理员${message}`);
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
    const credentialDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, '../../data'));
    fs.mkdirSync(credentialDir, { recursive: true, mode: 0o700 });
    const credentialPath = path.resolve(
        credentialDir,
        'initial-admin-password.txt'
    );
    fs.writeFileSync(
        credentialPath,
        `username=admin\npassword=${password}\ncreated_at=${getBeijingTimestamp()}\n`,
        { mode: 0o600 }
    );
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

// PostgreSQL seed ──────────────────────────────────────────────────────────

async function runSeedsPg() {
    const { transaction } = require('./client');

    await transaction(async (trx) => {
        // 启动可能由多个实例同时触发；事务级 advisory lock 让默认数据只会有一个实例执行。
        await trx.execute("SELECT pg_advisory_xact_lock(hashtext(?))", ['pivot.initial_seed']);

        async function createInitialAdminAccount() {
            const credential = buildInitialAdminCredential();
            await trx.execute(
                'INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
                ['admin', credential.passwordHash, '系统管理员', '智枢科技', 'admin', 'active', getBeijingTimestamp()]
            );
            logInitialAdminCredential(credential);
        }

        async function ensureBuiltInAdminAccount() {
            const admin = await trx.queryOne('SELECT id, role, status, deleted_at FROM users WHERE username = $1', ['admin']);
            if (!admin) { await createInitialAdminAccount(); return; }
            const needsRepair = admin.role !== 'admin' || admin.status === 'disabled' || admin.deleted_at;
            if (!needsRepair) return;
            await trx.execute(`
                UPDATE users SET role = 'admin', status = 'active', deleted_at = NULL,
                    nickname = COALESCE(NULLIF(nickname, ''), '系统管理员'),
                    unit = COALESCE(NULLIF(unit, ''), '智枢科技')
                WHERE id = $1
            `, [admin.id]);
            logger.warn({ username: 'admin', userId: admin.id }, '[PG] 已修复内置 admin 账号');
        }

        const promptRow = await trx.queryOne('SELECT COUNT(*) AS count FROM prompts');
        if (Number(promptRow?.count) === 0) {
            const defaultPrompts = [
                ['中英文翻译官', '你是一个精通中英文翻译的助手，能够地道、准确地在两种语言间切换，并保持原有的语气。', '翻译', 'role', 'chat,agent,workflow', '适合需要固定翻译角色的对话、任务和工作流节点。'],
                ['代码助手', '你是一个资深的软件工程师，擅长编写简洁、高效、安全的代码，并能给出详尽的注释和优化建议。', '编程', 'role', 'chat,agent,workflow', '用于代码审阅、实现建议和工程说明。'],
                ['周报专家', '你擅长总结工作成果，能将零散的任务描述转化为结构清晰、重点突出的专业周报。', '办公', 'output', 'chat,agent,workflow', '规定输出为清晰、可复用的周报结构。'],
                ['文案润色', '你是一个文字编辑专家，能对给出的文本进行修辞优化、逻辑理顺，使其更具感染力和专业性。', '创作', 'method', 'chat,agent,workflow', '适合把写作风格和润色标准沉淀为规范。']
            ];
            for (const p of defaultPrompts) {
                await trx.execute(
                    'INSERT INTO prompts (name, content, category, type, target_surfaces, description) VALUES (?, ?, ?, ?, ?, ?)',
                    p
                );
            }
        }

        const userRow = await trx.queryOne('SELECT COUNT(*) AS count FROM users');
        if (Number(userRow?.count) === 0) await createInitialAdminAccount();
        else await ensureBuiltInAdminAccount();

        // 导入工作流模板种子数据（仅当表已存在时）
        const tableExists = await trx.queryOne(`
            SELECT EXISTS (
                SELECT FROM information_schema.tables
                WHERE table_schema = 'public'
                AND table_name = 'agent_workflow_templates'
            ) as exists
        `);

        if (tableExists?.exists) {
            logger.info('开始导入内置工作流模板...');
            const workflowTemplateSeed = require('./seeds/003-workflow-templates');

            // 创建一个 knex 兼容的包装器
            const knexWrapper = (tableName) => ({
                select: (...fields) => ({
                    then: async (resolve) => {
                        const fieldList = fields.length > 0 ? fields.join(', ') : '*';
                        const rows = await trx.query(`SELECT ${fieldList} FROM ${tableName}`);
                        resolve(rows);
                    }
                }),
                where: (keyOrConditions, value) => ({
                    first: () => ({
                        then: async (resolve) => {
                            let keys, values;
                            if (typeof keyOrConditions === 'string') {
                                // where('field', value) 语法
                                keys = [keyOrConditions];
                                values = [value];
                            } else {
                                // where({ field: value }) 语法
                                keys = Object.keys(keyOrConditions);
                                values = keys.map(k => keyOrConditions[k]);
                            }
                            const whereClause = keys.map((k, i) => `${k} = $${i + 1}`).join(' AND ');
                            const row = await trx.queryOne(`SELECT * FROM ${tableName} WHERE ${whereClause}`, values);
                            resolve(row);
                        }
                    }),
                    update: (updateData) => ({
                        then: async (resolve) => {
                            let whereKeys, whereValues;
                            if (typeof keyOrConditions === 'string') {
                                whereKeys = [keyOrConditions];
                                whereValues = [value];
                            } else {
                                whereKeys = Object.keys(keyOrConditions);
                                whereValues = whereKeys.map(k => keyOrConditions[k]);
                            }

                            const updateKeys = Object.keys(updateData);
                            const setClause = updateKeys.map((k, i) => `${k} = $${i + 1}`).join(', ');
                            const whereClause = whereKeys.map((k, i) => `${k} = $${updateKeys.length + i + 1}`).join(' AND ');

                            const values = [
                                ...updateKeys.map(k => {
                                    const val = updateData[k];
                                    if (val === null || val === undefined) return null;
                                    if (Array.isArray(val)) return val;
                                    if (typeof val === 'object') return JSON.stringify(val);
                                    return val;
                                }),
                                ...whereValues
                            ];

                            await trx.query(
                                `UPDATE ${tableName} SET ${setClause} WHERE ${whereClause}`,
                                values
                            );
                            resolve();
                        }
                    })
                }),
                insert: (data) => ({
                    returning: (fields) => ({
                        then: async (resolve) => {
                            const keys = Object.keys(data);
                            const placeholders = keys.map((k, i) => `$${i + 1}`).join(', ');
                            const fieldList = Array.isArray(fields) ? fields.join(', ') : fields;
                            const values = keys.map(k => {
                                const val = data[k];
                                if (val === null || val === undefined) return null;
                                // PostgreSQL 数组：保持为 JavaScript 数组，pg 驱动会自动转换
                                if (Array.isArray(val)) return val;
                                if (typeof val === 'object') return JSON.stringify(val);
                                return val;
                            });
                            const row = await trx.queryOne(
                                `INSERT INTO ${tableName} (${keys.join(', ')}) VALUES (${placeholders}) RETURNING ${fieldList}`,
                                values
                            );
                            resolve([row]);
                        }
                    })
                }),
                update: (data) => ({
                    returning: (fields) => ({
                        then: async (resolve) => {
                            const keys = Object.keys(data);
                            const setClause = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
                            const values = keys.map(k => {
                                const val = data[k];
                                if (val === null || val === undefined) return null;
                                if (Array.isArray(val)) return val;
                                if (typeof val === 'object') return JSON.stringify(val);
                                return val;
                            });
                            const fieldList = Array.isArray(fields) ? fields.join(', ') : fields;
                            const row = await trx.queryOne(
                                `UPDATE ${tableName} SET ${setClause} RETURNING ${fieldList}`,
                                values
                            );
                            resolve([row]);
                        }
                    }),
                    where: (keyOrConditions, value) => ({
                        update: (additionalData) => ({
                            then: async (resolve) => {
                                const mergedData = { ...data, ...additionalData };
                                const updateKeys = Object.keys(mergedData);
                                const setClause = updateKeys.map((k, i) => `${k} = $${i + 1}`).join(', ');

                                let whereKeys, whereValues;
                                if (typeof keyOrConditions === 'string') {
                                    whereKeys = [keyOrConditions];
                                    whereValues = [value];
                                } else {
                                    whereKeys = Object.keys(keyOrConditions);
                                    whereValues = whereKeys.map(k => keyOrConditions[k]);
                                }

                                const whereClause = whereKeys.map((k, i) => `${k} = $${updateKeys.length + i + 1}`).join(' AND ');
                                const values = [
                                    ...updateKeys.map(k => {
                                        const val = mergedData[k];
                                        if (val === null || val === undefined) return null;
                                        if (Array.isArray(val)) return val;
                                        if (typeof val === 'object') return JSON.stringify(val);
                                        return val;
                                    }),
                                    ...whereValues
                                ];

                                await trx.query(
                                    `UPDATE ${tableName} SET ${setClause} WHERE ${whereClause}`,
                                    values
                                );
                                resolve();
                            }
                        }),
                        then: async (resolve) => {
                            const updateKeys = Object.keys(data);
                            const setClause = updateKeys.map((k, i) => `${k} = $${i + 1}`).join(', ');

                            let whereKeys, whereValues;
                            if (typeof keyOrConditions === 'string') {
                                whereKeys = [keyOrConditions];
                                whereValues = [value];
                            } else {
                                whereKeys = Object.keys(keyOrConditions);
                                whereValues = whereKeys.map(k => keyOrConditions[k]);
                            }

                            const whereClause = whereKeys.map((k, i) => `${k} = $${updateKeys.length + i + 1}`).join(' AND ');
                            const values = [
                                ...updateKeys.map(k => typeof data[k] === 'object' ? JSON.stringify(data[k]) : data[k]),
                                ...whereValues
                            ];

                            await trx.query(
                                `UPDATE ${tableName} SET ${setClause} WHERE ${whereClause}`,
                                values
                            );
                            resolve();
                        }
                    })
                })
            });

            try {
                await workflowTemplateSeed.seed(knexWrapper);
                logger.info('✅ 内置工作流模板导入完成');
            } catch (error) {
                logger.error({ error: error.message }, '❌ 工作流模板导入失败');
            }
        } else {
            logger.info('⏭️  agent_workflow_templates 表尚未创建，跳过工作流模板种子导入');
        }
    });
}

async function ensureBuiltInAdminAccount() {
    const { transaction } = require('./client');
    await transaction(async trx => {
        const admin = await trx.queryOne('SELECT id, role, status, deleted_at FROM users WHERE username = $1', ['admin']);
        if (!admin) {
            const credential = buildInitialAdminCredential();
            await trx.execute(
                'INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
                ['admin', credential.passwordHash, '系统管理员', '智枢科技', 'admin', 'active', getBeijingTimestamp()]
            );
            logInitialAdminCredential(credential);
            return;
        }
        if (admin.role === 'admin' && admin.status !== 'disabled' && !admin.deleted_at) return;
        await trx.execute(`
            UPDATE users SET role = 'admin', status = 'active', deleted_at = NULL,
                nickname = COALESCE(NULLIF(nickname, ''), '系统管理员'),
                unit = COALESCE(NULLIF(unit, ''), '智枢科技')
            WHERE id = $1
        `, [admin.id]);
        logger.warn({ username: 'admin', userId: admin.id }, '[PG] 已修复内置 admin 账号角色或状态');
    });
}

module.exports = {
    runSeedsPg,
    ensureBuiltInAdminAccount,
    validateInitialPassword
};
