/**
 * 工作流模板服务
 *
 * 功能：
 * - 模板管理（CRUD）
 * - 模板应用（变量替换）
 * - 模板评分
 * - 使用统计
 */

const { query, queryOne, transaction } = require('../../db/client');
const { getBeijingTimestamp } = require('../../time');

class WorkflowTemplateError extends Error {
    constructor(message, status = 400, code = 'TEMPLATE_ERROR') {
        super(message);
        this.name = 'WorkflowTemplateError';
        if (typeof status === 'number') {
            this.status = status;
            this.statusCode = status;
            this.code = code;
        } else {
            this.status = 400;
            this.statusCode = 400;
            this.code = status;
        }
    }
}

class WorkflowTemplateService {
    /**
     * 获取模板列表
     * @param {Object} options - 查询选项
     * @param {string} options.category - 分类 slug
     * @param {string} options.difficulty - 难度级别
     * @param {string} options.search - 搜索关键词
     * @param {string} options.sortBy - 排序字段（usage_count, rating_avg, created_at, updated_at）
     * @param {string} options.sortOrder - 排序方向（asc, desc）
     * @param {number} options.page - 页码
     * @param {number} options.pageSize - 每页数量
     * @param {number} options.limit - 每页数量（别名）
     * @param {boolean} options.includePrivate - 是否包含私有模板
     * @param {boolean} options.isBuiltin - 是否只查内置模板
     * @param {number} options.userId - 当前用户 ID
     */
    async listTemplates(options = {}) {
        const {
            category,
            difficulty,
            search,
            sortBy = 'usage_count',
            sortOrder = 'desc',
            page = 1,
            pageSize = 20,
            limit,
            includePrivate = false,
            isBuiltin,
            userId
        } = options;

        const effectivePageSize = Math.max(1, parseInt(limit || pageSize || 20, 10));
        const effectivePage = Math.max(1, parseInt(page || 1, 10));
        const offset = (effectivePage - 1) * effectivePageSize;

        const whereClauses = [
            't.is_active = TRUE',
            't.deleted_at IS NULL'
        ];
        const params = [];

        // 权限过滤
        if (!includePrivate || !userId) {
            whereClauses.push('t.is_public = TRUE');
        } else if (userId) {
            whereClauses.push('(t.is_public = TRUE OR t.created_by = ?)');
            params.push(userId);
        }

        // 内置模板过滤
        if (isBuiltin !== undefined) {
            whereClauses.push('t.is_builtin = ?');
            params.push(Boolean(isBuiltin));
        }

        // 分类过滤
        if (category) {
            whereClauses.push('c.slug = ?');
            params.push(category);
        }

        // 难度过滤
        if (difficulty) {
            whereClauses.push('t.difficulty = ?');
            params.push(difficulty);
        }

        // 搜索
        if (search) {
            whereClauses.push('(t.name ILIKE ? OR t.description ILIKE ? OR ? = ANY(t.tags))');
            const searchPattern = `%${search}%`;
            params.push(searchPattern, searchPattern, search);
        }

        const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

        // 排序
        const validSortFields = ['usage_count', 'rating_avg', 'created_at', 'updated_at'];
        const sortField = validSortFields.includes(sortBy) ? sortBy : 'usage_count';
        const direction = String(sortOrder).toLowerCase() === 'asc' ? 'ASC' : 'DESC';

        const countSql = `
            SELECT COUNT(*) AS count
            FROM agent_workflow_templates t
            LEFT JOIN agent_workflow_template_categories c ON t.category_id = c.id
            ${whereSql}
        `;
        const countResult = await queryOne(countSql, params);
        const total = parseInt(countResult?.count || 0, 10);

        const listSql = `
            SELECT
                t.id,
                t.name,
                t.slug,
                t.description,
                t.tags,
                t.difficulty,
                t.estimated_time,
                t.icon,
                t.preview_image,
                t.usage_count,
                t.rating_avg,
                t.rating_count,
                t.is_builtin,
                t.is_public,
                t.created_at,
                t.updated_at,
                c.name as category_name,
                c.slug as category_slug,
                u.username as author_username,
                u.nickname as author_nickname
            FROM agent_workflow_templates t
            LEFT JOIN agent_workflow_template_categories c ON t.category_id = c.id
            LEFT JOIN users u ON t.created_by = u.id
            ${whereSql}
            ORDER BY t.${sortField} ${direction}
            LIMIT ? OFFSET ?
        `;
        const listParams = [...params, effectivePageSize, offset];
        const templates = await query(listSql, listParams);

        return {
            templates,
            pagination: {
                page: effectivePage,
                pageSize: effectivePageSize,
                total,
                totalPages: Math.ceil(total / effectivePageSize)
            }
        };
    }

    /**
     * 获取模板详情
     * @param {string|number} slugOrId - 模板 slug 或 ID
     * @param {number} userId - 当前用户 ID
     */
    async getTemplateDetail(slugOrId, userId = null) {
        const isId = /^\d+$/.test(String(slugOrId).trim());
        const idVal = isId ? parseInt(slugOrId, 10) : null;
        const slugVal = String(slugOrId).trim();

        const template = await queryOne(`
            SELECT
                t.*,
                c.name as category_name,
                c.slug as category_slug,
                u.username as author_username,
                u.nickname as author_nickname,
                v.version as current_version,
                v.changelog as current_changelog
            FROM agent_workflow_templates t
            LEFT JOIN agent_workflow_template_categories c ON t.category_id = c.id
            LEFT JOIN users u ON t.created_by = u.id
            LEFT JOIN agent_workflow_template_versions v ON t.current_version_id = v.id
            WHERE (${isId ? 't.id = ?' : 't.slug = ?'})
              AND t.is_active = TRUE
              AND t.deleted_at IS NULL
        `, [isId ? idVal : slugVal]);

        if (!template) {
            throw new WorkflowTemplateError('模板不存在', 404);
        }

        // 权限检查
        if (!template.is_public && (!userId || template.created_by !== userId)) {
            throw new WorkflowTemplateError('无权访问此模板', 403);
        }

        // 获取用户评分（如果已登录）
        if (userId) {
            const userRating = await queryOne(`
                SELECT * FROM agent_workflow_template_ratings
                WHERE template_id = ? AND user_id = ?
            `, [template.id, userId]);
            template.user_rating = userRating || null;
        }

        return template;
    }

    /**
     * 创建模板
     * @param {Object} templateData - 模板数据
     * @param {number} userId - 创建者 ID
     */
    async createTemplate(templateData, userId) {
        const {
            name,
            slug,
            categoryId,
            description,
            tags = [],
            difficulty = 'beginner',
            estimatedTime,
            dagSpecTemplate,
            variables = [],
            icon,
            previewImage,
            exampleOutput,
            documentation,
            isPublic = true
        } = templateData;

        // 验证 slug 唯一性
        const existingTemplate = await queryOne(`
            SELECT id FROM agent_workflow_templates
            WHERE slug = ? AND deleted_at IS NULL
        `, [slug]);

        if (existingTemplate) {
            throw new WorkflowTemplateError('模板 slug 已存在', 400);
        }

        // 验证 DAG 结构
        this._validateDagSpec(dagSpecTemplate);

        // 验证变量定义
        this._validateVariables(variables);

        return await transaction(async (trx) => {
            const template = await trx.queryOne(`
                INSERT INTO agent_workflow_templates (
                    name, slug, category_id, description, tags, difficulty,
                    estimated_time, dag_spec_template, variables, icon,
                    preview_image, example_output, documentation, is_public, created_by
                ) VALUES (
                    ?, ?, ?, ?, ?, ?,
                    ?, ?::jsonb, ?::jsonb, ?,
                    ?, ?, ?, ?, ?
                ) RETURNING *
            `, [
                name, slug, categoryId, description, tags, difficulty,
                estimatedTime, JSON.stringify(dagSpecTemplate), JSON.stringify(variables), icon,
                previewImage, exampleOutput, documentation, isPublic, userId
            ]);

            const version = await trx.queryOne(`
                INSERT INTO agent_workflow_template_versions (
                    template_id, version, changelog, dag_spec_template, variables,
                    is_published, published_by, published_at
                ) VALUES (
                    ?, '1.0.0', 'Initial version', ?::jsonb, ?::jsonb,
                    TRUE, ?, NOW()
                ) RETURNING *
            `, [
                template.id, JSON.stringify(dagSpecTemplate), JSON.stringify(variables), userId
            ]);

            await trx.execute(`
                UPDATE agent_workflow_templates SET current_version_id = ? WHERE id = ?
            `, [version.id, template.id]);

            return { ...template, current_version_id: version.id };
        });
    }

    /**
     * 应用模板（创建工作流）
     * @param {number} templateId - 模板 ID
     * @param {Object} variableValues - 变量值映射
     * @param {number} userId - 用户 ID
     */
    async applyTemplate(templateId, variableValues, userId) {
        // 获取模板
        const template = await this.getTemplateDetail(templateId, userId);

        // 解析变量
        const variables = typeof template.variables === 'string'
            ? JSON.parse(template.variables)
            : (template.variables || []);
        const dagSpecTemplate = typeof template.dag_spec_template === 'string'
            ? JSON.parse(template.dag_spec_template)
            : (template.dag_spec_template || {});

        // 验证必填变量
        this._validateVariableValues(variables, variableValues);

        // 替换变量
        const dagSpec = this._replaceVariables(dagSpecTemplate, variableValues);

        // 生成工作流名称
        const workflowName = variableValues?.workflow_name || `${template.name} - ${new Date().toLocaleString('zh-CN')}`;
        const now = getBeijingTimestamp();

        const result = await transaction(async (trx) => {
            const workflow = await trx.queryOne(`
                INSERT INTO agent_workflows (user_id, name, description, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?)
                RETURNING *
            `, [userId, workflowName, `基于模板「${template.name}」创建`, now, now]);

            const version = await trx.queryOne(`
                INSERT INTO agent_workflow_versions (workflow_id, version, dag_spec, note, created_by, created_at)
                VALUES (?, 1, ?::jsonb, '从模板生成', ?, ?)
                RETURNING *
            `, [workflow.id, JSON.stringify(dagSpec), userId, now]);

            await trx.execute(`
                UPDATE agent_workflows SET current_version_id = ? WHERE id = ?
            `, [version.id, workflow.id]);

            await trx.execute(`
                INSERT INTO agent_workflow_template_usage (template_id, workflow_id, user_id, variables_used)
                VALUES (?, ?, ?, ?::jsonb)
            `, [templateId, workflow.id, userId, JSON.stringify(variableValues || {})]);

            await trx.execute(`
                UPDATE agent_workflow_templates SET usage_count = usage_count + 1 WHERE id = ?
            `, [templateId]);

            return { ...workflow, current_version_id: version.id, dag_spec: dagSpec };
        });

        return result;
    }

    /**
     * 评分模板
     * @param {number} templateId - 模板 ID
     * @param {number} rating - 评分（1-5）
     * @param {string} comment - 评论
     * @param {number} userId - 用户 ID
     */
    async rateTemplate(templateId, rating, comment, userId) {
        if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
            throw new WorkflowTemplateError('评分必须在 1-5 之间', 400);
        }

        await this.getTemplateDetail(templateId, userId);

        return await transaction(async (trx) => {
            const existingRating = await trx.queryOne(`
                SELECT id FROM agent_workflow_template_ratings
                WHERE template_id = ? AND user_id = ?
            `, [templateId, userId]);

            if (existingRating) {
                await trx.execute(`
                    UPDATE agent_workflow_template_ratings
                    SET rating = ?, comment = ?, updated_at = NOW()
                    WHERE template_id = ? AND user_id = ?
                `, [rating, comment, templateId, userId]);
            } else {
                await trx.execute(`
                    INSERT INTO agent_workflow_template_ratings (template_id, user_id, rating, comment)
                    VALUES (?, ?, ?, ?)
                `, [templateId, userId, rating, comment]);
            }

            const stats = await trx.queryOne(`
                SELECT COALESCE(AVG(rating), 0) as avg, COUNT(*) as count
                FROM agent_workflow_template_ratings
                WHERE template_id = ?
            `, [templateId]);

            const ratingAvg = parseFloat(stats.avg || 0).toFixed(2);
            const ratingCount = parseInt(stats.count || 0, 10);

            await trx.execute(`
                UPDATE agent_workflow_templates
                SET rating_avg = ?, rating_count = ?
                WHERE id = ?
            `, [ratingAvg, ratingCount, templateId]);

            return {
                rating,
                comment,
                template_avg: ratingAvg,
                template_count: ratingCount
            };
        });
    }

    /**
     * 获取模板分类列表
     */
    async listCategories() {
        return await query(`
            SELECT * FROM agent_workflow_template_categories
            WHERE is_active = TRUE
            ORDER BY display_order ASC
        `);
    }

    // ============ 私有方法 ============

    /**
     * 验证 DAG 结构
     */
    _validateDagSpec(dagSpec) {
        if (!dagSpec || typeof dagSpec !== 'object') {
            throw new WorkflowTemplateError('DAG 结构无效', 400);
        }

        if (!dagSpec.nodes || !Array.isArray(dagSpec.nodes) || dagSpec.nodes.length === 0) {
            throw new WorkflowTemplateError('DAG 必须包含至少一个节点', 400);
        }

        return true;
    }

    /**
     * 验证变量定义
     */
    _validateVariables(variables) {
        if (!Array.isArray(variables)) {
            throw new WorkflowTemplateError('变量定义必须是数组', 400);
        }

        const validTypes = ['string', 'number', 'select', 'connection_id', 'model_id', 'boolean'];

        for (const variable of variables) {
            if (!variable.name || typeof variable.name !== 'string') {
                throw new WorkflowTemplateError('变量必须包含有效的 name 字段', 400);
            }

            if (!variable.type || !validTypes.includes(variable.type)) {
                throw new WorkflowTemplateError(`变量 ${variable.name} 的类型无效`, 400);
            }
        }

        return true;
    }

    /**
     * 验证变量值
     */
    _validateVariableValues(variables, values) {
        for (const variable of variables) {
            const value = values[variable.name];

            if (variable.required && (value === undefined || value === null || value === '')) {
                throw new WorkflowTemplateError(`变量 ${variable.label || variable.name} 是必填项`, 400);
            }

            if (value !== undefined && value !== null) {
                switch (variable.type) {
                    case 'number':
                        if (isNaN(value)) {
                            throw new WorkflowTemplateError(`变量 ${variable.label || variable.name} 必须是数字`, 400);
                        }
                        break;
                    case 'select':
                        if (variable.options && !variable.options.some(opt => opt.value === value)) {
                            throw new WorkflowTemplateError(`变量 ${variable.label || variable.name} 的值无效`, 400);
                        }
                        break;
                }

                if (variable.validation) {
                    const { min, max, pattern } = variable.validation;

                    if (variable.type === 'number') {
                        if (min !== undefined && value < min) {
                            throw new WorkflowTemplateError(`变量 ${variable.label || variable.name} 不能小于 ${min}`, 400);
                        }
                        if (max !== undefined && value > max) {
                            throw new WorkflowTemplateError(`变量 ${variable.label || variable.name} 不能大于 ${max}`, 400);
                        }
                    } else if (variable.type === 'string') {
                        if (min !== undefined && value.length < min) {
                            throw new WorkflowTemplateError(`变量 ${variable.label || variable.name} 长度不能小于 ${min}`, 400);
                        }
                        if (max !== undefined && value.length > max) {
                            throw new WorkflowTemplateError(`变量 ${variable.label || variable.name} 长度不能大于 ${max}`, 400);
                        }
                        if (pattern && !new RegExp(pattern).test(value)) {
                            throw new WorkflowTemplateError(
                                variable.validation.message || `变量 ${variable.label || variable.name} 格式不正确`,
                                400
                            );
                        }
                    }
                }
            }
        }

        return true;
    }

    /**
     * 替换变量
     */
    _replaceVariables(obj, values) {
        const replaceString = (str) => {
            if (typeof str !== 'string') return str;

            return str.replace(/\{\{var\.([^}|]+)(\|([^}]+))?\}\}/g, (match, path, _, defaultValue) => {
                const keys = path.split('.');
                let value = values;

                for (const key of keys) {
                    value = value?.[key];
                }

                if (value === undefined || value === null) {
                    return defaultValue || '';
                }

                return String(value);
            });
        };

        const replaceRecursive = (obj) => {
            if (typeof obj === 'string') {
                return replaceString(obj);
            } else if (Array.isArray(obj)) {
                return obj.map(item => replaceRecursive(item));
            } else if (obj !== null && typeof obj === 'object') {
                const result = {};
                for (const [key, value] of Object.entries(obj)) {
                    result[key] = replaceRecursive(value);
                }
                return result;
            } else {
                return obj;
            }
        };

        return replaceRecursive(obj);
    }
}

module.exports = {
    WorkflowTemplateService: new WorkflowTemplateService(),
    WorkflowTemplateError
};
