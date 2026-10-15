/**
 * Migration: 027 - Workflow Templates System
 * Version: v0.3.0
 * Description: 创建工作流模板库系统相关表
 *
 * 包含表：
 * - agent_workflow_template_categories: 模板分类表
 * - agent_workflow_templates: 工作流模板主表
 * - agent_workflow_template_versions: 模板版本表
 * - agent_workflow_template_usage: 模板使用记录表
 * - agent_workflow_template_ratings: 模板评分表
 */

const migrationId = '202610140002_agent_workflow_templates';

async function upPg(client, { logger }) {
  logger.info(`[${migrationId}] 开始创建工作流模板系统表...`);

  // 1. 创建模板分类表
  await client.query(`
    CREATE TABLE IF NOT EXISTS agent_workflow_template_categories (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL UNIQUE,
      slug VARCHAR(100) NOT NULL UNIQUE,
      description TEXT,
      icon VARCHAR(50),
      display_order INTEGER DEFAULT 0,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_workflow_template_categories_slug
    ON agent_workflow_template_categories(slug)
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_workflow_template_categories_active_order
    ON agent_workflow_template_categories(is_active, display_order)
  `);

  // 2. 创建工作流模板主表
  await client.query(`
    CREATE TABLE IF NOT EXISTS agent_workflow_templates (
      id SERIAL PRIMARY KEY,
      name VARCHAR(200) NOT NULL,
      slug VARCHAR(200) NOT NULL UNIQUE,
      category_id INTEGER REFERENCES agent_workflow_template_categories(id) ON DELETE SET NULL,
      description TEXT,
      tags TEXT[] DEFAULT '{}',

      difficulty VARCHAR(20) DEFAULT 'beginner' CHECK (difficulty IN ('beginner', 'intermediate', 'advanced')),
      estimated_time VARCHAR(50),

      dag_spec_template JSONB NOT NULL,
      variables JSONB NOT NULL DEFAULT '[]',

      icon VARCHAR(50),
      preview_image TEXT,
      example_output TEXT,
      documentation TEXT,

      usage_count INTEGER DEFAULT 0,
      rating_avg DECIMAL(3, 2),
      rating_count INTEGER DEFAULT 0,

      is_builtin BOOLEAN DEFAULT FALSE,
      is_public BOOLEAN DEFAULT TRUE,
      is_active BOOLEAN DEFAULT TRUE,

      created_by INTEGER REFERENCES users(id) ON DELETE CASCADE,
      current_version_id INTEGER,

      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      deleted_at TIMESTAMPTZ
    )
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_workflow_templates_slug
    ON agent_workflow_templates(slug)
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_workflow_templates_category
    ON agent_workflow_templates(category_id)
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_workflow_templates_active_public
    ON agent_workflow_templates(is_active, is_public)
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_workflow_templates_created_by
    ON agent_workflow_templates(created_by)
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_workflow_templates_usage_count
    ON agent_workflow_templates(usage_count DESC)
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_workflow_templates_rating_avg
    ON agent_workflow_templates(rating_avg DESC)
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_workflow_templates_tags
    ON agent_workflow_templates USING GIN(tags)
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_workflow_templates_deleted_at
    ON agent_workflow_templates(deleted_at)
  `);

  // 3. 创建模板版本表
  await client.query(`
    CREATE TABLE IF NOT EXISTS agent_workflow_template_versions (
      id SERIAL PRIMARY KEY,
      template_id INTEGER NOT NULL REFERENCES agent_workflow_templates(id) ON DELETE CASCADE,
      version VARCHAR(20) NOT NULL,
      changelog TEXT,

      dag_spec_template JSONB NOT NULL,
      variables JSONB NOT NULL DEFAULT '[]',

      is_published BOOLEAN DEFAULT FALSE,
      published_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      published_at TIMESTAMPTZ,

      created_at TIMESTAMPTZ DEFAULT NOW(),

      UNIQUE(template_id, version)
    )
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_workflow_template_versions_template
    ON agent_workflow_template_versions(template_id)
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_workflow_template_versions_published
    ON agent_workflow_template_versions(is_published, published_at)
  `);

  // 4. 创建模板使用记录表
  await client.query(`
    CREATE TABLE IF NOT EXISTS agent_workflow_template_usage (
      id SERIAL PRIMARY KEY,
      template_id INTEGER NOT NULL REFERENCES agent_workflow_templates(id) ON DELETE CASCADE,
      workflow_id INTEGER REFERENCES agent_workflows(id) ON DELETE SET NULL,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      variables_used JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_workflow_template_usage_template
    ON agent_workflow_template_usage(template_id)
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_workflow_template_usage_workflow
    ON agent_workflow_template_usage(workflow_id)
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_workflow_template_usage_user
    ON agent_workflow_template_usage(user_id)
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_workflow_template_usage_created
    ON agent_workflow_template_usage(created_at)
  `);

  // 5. 创建模板评分表
  await client.query(`
    CREATE TABLE IF NOT EXISTS agent_workflow_template_ratings (
      id SERIAL PRIMARY KEY,
      template_id INTEGER NOT NULL REFERENCES agent_workflow_templates(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
      comment TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),

      UNIQUE(template_id, user_id)
    )
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_workflow_template_ratings_template
    ON agent_workflow_template_ratings(template_id)
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_workflow_template_ratings_user
    ON agent_workflow_template_ratings(user_id)
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_workflow_template_ratings_rating
    ON agent_workflow_template_ratings(rating)
  `);

  // 6. 添加外键约束（模板表的 current_version_id）
  await client.query(`
    ALTER TABLE agent_workflow_templates
    ADD CONSTRAINT fk_workflow_templates_current_version
    FOREIGN KEY (current_version_id)
    REFERENCES agent_workflow_template_versions(id)
    ON DELETE SET NULL
  `);

  // 7. 插入默认分类
  await client.query(`
    INSERT INTO agent_workflow_template_categories (name, slug, description, icon, display_order)
    VALUES
      ('数据分析', 'data-analysis', '数据库查询、数据处理、数据可视化等', 'chart-bar', 1),
      ('内容生成', 'content-generation', '文本生成、翻译、摘要、SEO优化等', 'file-text', 2),
      ('自动化运维', 'automation-ops', '日志分析、健康检查、备份验证等', 'server', 3),
      ('业务流程', 'business-process', '客户反馈、订单审核、合同审查等', 'briefcase', 4),
      ('其他', 'others', '其他类型的工作流模板', 'folder', 99)
    ON CONFLICT (slug) DO NOTHING
  `);

  logger.info(`[${migrationId}] 工作流模板系统表创建完成`);
}

async function downPg(client, { logger }) {
  logger.info(`[${migrationId}] 开始回滚工作流模板系统表...`);

  // 先删除外键约束
  await client.query(`
    ALTER TABLE IF EXISTS agent_workflow_templates
    DROP CONSTRAINT IF EXISTS fk_workflow_templates_current_version
  `);

  // 按依赖关系逆序删除表
  await client.query('DROP TABLE IF EXISTS agent_workflow_template_ratings CASCADE');
  await client.query('DROP TABLE IF EXISTS agent_workflow_template_usage CASCADE');
  await client.query('DROP TABLE IF EXISTS agent_workflow_template_versions CASCADE');
  await client.query('DROP TABLE IF EXISTS agent_workflow_templates CASCADE');
  await client.query('DROP TABLE IF EXISTS agent_workflow_template_categories CASCADE');

  logger.info(`[${migrationId}] 工作流模板系统表回滚完成`);
}

module.exports = {
  id: migrationId,
  description: '工作流模板库系统',
  upPg,
  downPg
};
