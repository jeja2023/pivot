/**
 * 工作流实例服务
 * 管理基于模板实例化的工作流及模板应用记录
 * 基于 PostgreSQL 原生异步连接池
 */

const { query, queryOne } = require('../../db/client');
const { workflowTemplateService } = require('./workflowTemplateService');

class WorkflowInstanceService {
  /**
   * 基于模板创建工作流实例
   */
  async createInstance(data) {
    const { template_id, variables = {}, created_by, name } = data;
    return await workflowTemplateService.applyTemplate(template_id, variables, created_by, name);
  }

  /**
   * 获取模板应用实例列表
   */
  async listInstances(filters = {}) {
    const { template_id, user_id, page = 1, pageSize = 10 } = filters;
    const limit = Number(pageSize) || 10;
    const offset = ((Number(page) || 1) - 1) * limit;

    const conditions = ['1 = 1'];
    const params = [];

    if (template_id) {
      conditions.push('u.template_id = ?');
      params.push(template_id);
    }

    if (user_id) {
      conditions.push('u.user_id = ?');
      params.push(user_id);
    }

    const whereClause = conditions.join(' AND ');

    const countRow = await queryOne(
      `SELECT COUNT(*) as count FROM agent_workflow_template_usage u WHERE ${whereClause}`,
      params
    );

    const listParams = [...params, limit, offset];
    const rows = await query(`
      SELECT 
        u.*,
        t.name as template_name,
        t.slug as template_slug,
        w.name as workflow_name,
        usr.username,
        usr.nickname
      FROM agent_workflow_template_usage u
      LEFT JOIN agent_workflow_templates t ON t.id = u.template_id
      LEFT JOIN agent_workflows w ON w.id = u.workflow_id
      LEFT JOIN users usr ON usr.id = u.user_id
      WHERE ${whereClause}
      ORDER BY u.created_at DESC
      LIMIT ? OFFSET ?
    `, listParams);

    return {
      instances: rows,
      total: parseInt(countRow?.count || 0, 10),
      page: Number(page) || 1,
      pageSize: limit
    };
  }

  /**
   * 获取单条实例详情
   */
  async getInstance(id) {
    return await queryOne(`
      SELECT 
        u.*,
        t.name as template_name,
        t.slug as template_slug,
        w.name as workflow_name,
        w.dag_spec,
        usr.username,
        usr.nickname
      FROM agent_workflow_template_usage u
      LEFT JOIN agent_workflow_templates t ON t.id = u.template_id
      LEFT JOIN agent_workflows w ON w.id = u.workflow_id
      LEFT JOIN users usr ON usr.id = u.user_id
      WHERE u.id = ?
    `, [id]);
  }
}

const workflowInstanceService = new WorkflowInstanceService();

module.exports = {
  WorkflowInstanceService,
  workflowInstanceService
};
