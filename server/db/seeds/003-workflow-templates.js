/**
 * Seed: 工作流模板
 * 导入内置模板到数据库
 */

const fs = require('fs');
const path = require('path');
const { logger } = require('../../logger');

exports.seed = async function (knex) {
    logger.debug('开始同步内置工作流模板...');

    // 1. 获取分类映射
    const categories = await knex('agent_workflow_template_categories')
        .select('id', 'slug');

    const categoryMap = {};
    categories.forEach(cat => {
        categoryMap[cat.slug] = cat.id;
    });

    // 2. 读取模板文件
    const templatesDir = path.join(__dirname, 'workflow-templates');

    if (!fs.existsSync(templatesDir)) {
        logger.debug('内置工作流模板目录不存在，跳过同步');
        return;
    }

    const templateFiles = fs.readdirSync(templatesDir).filter(f => f.endsWith('.json'));

    logger.debug({ count: templateFiles.length }, '扫描到内置工作流模板文件');

    // 3. 导入模板
    for (const file of templateFiles) {
        const filePath = path.join(templatesDir, file);
        const templateData = JSON.parse(fs.readFileSync(filePath, 'utf8'));

        try {
            // 获取分类 ID（先获取，以便在更新和插入时都能使用）
            const categorySlug = templateData.category || templateData.category_slug;
            const categoryId = categoryMap[categorySlug];
            if (!categoryId) {
                logger.warn({ category: categorySlug, template: templateData.slug }, '内置工作流模板分类不存在，跳过导入');
                continue;
            }

            // 检查模板是否已存在
            const existingTemplate = await knex('agent_workflow_templates')
                .where('slug', templateData.slug)
                .first();

            if (existingTemplate) {
                // 更新现有模板
                await knex('agent_workflow_templates')
                    .where('slug', templateData.slug)
                    .update({
                        name: templateData.name,
                        category_id: categoryId,
                        description: templateData.description,
                        tags: templateData.tags || [],
                        difficulty: templateData.difficulty || 'beginner',
                        estimated_time: templateData.estimatedTime || templateData.estimated_time || '未知',
                        icon: templateData.icon || null,
                        preview_image: templateData.previewImage || templateData.preview_image || null,
                        example_output: templateData.exampleOutput || templateData.example_output || null,
                        documentation: templateData.documentation || null,
                        dag_spec_template: JSON.stringify(templateData.dag || {}),
                        variables: JSON.stringify(templateData.variables || []),
                        updated_at: new Date()
                    });
                logger.debug({ template: templateData.name, id: existingTemplate.id }, '内置工作流模板已更新');
                continue;
            }

            // 插入模板（先不设置 current_version_id）
            const [template] = await knex('agent_workflow_templates')
                .insert({
                    name: templateData.name,
                    slug: templateData.slug,
                    category_id: categoryId,
                    created_by: null,
                    description: templateData.description,
                    tags: templateData.tags || [],
                    difficulty: templateData.difficulty || 'beginner',
                    estimated_time: templateData.estimatedTime || '未知',
                    icon: templateData.icon || null,
                    preview_image: templateData.previewImage || null,
                    example_output: templateData.exampleOutput || null,
                    documentation: templateData.documentation || null,
                    dag_spec_template: JSON.stringify(templateData.dag || {}),
                    variables: JSON.stringify(templateData.variables || []),
                    is_builtin: templateData.is_builtin !== false,
                    is_public: templateData.is_public !== false,
                    is_active: true,
                    created_at: new Date(),
                    updated_at: new Date()
                })
                .returning('*');

            logger.debug({ template: templateData.name, id: template?.id }, '内置工作流模板已导入');
        } catch (error) {
            logger.error({ err: error, template: templateData.name }, '导入内置工作流模板失败');
        }
    }

    logger.debug('内置工作流模板同步完成');
};
