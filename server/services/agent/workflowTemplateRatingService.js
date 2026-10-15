/**
 * 工作流模板评分服务
 * 基于 PostgreSQL 原生异步连接池
 */

const { query, queryOne, execute } = require('../../db/client');

class WorkflowTemplateRatingService {
  /**
   * 添加或更新评分
   */
  async addRating(data) {
    const { template_id, user_id, rating, comment = '' } = data;

    const existing = await queryOne(
      'SELECT id FROM agent_workflow_template_ratings WHERE template_id = ? AND user_id = ?',
      [template_id, user_id]
    );

    let result;
    if (existing) {
      const rows = await query(`
        UPDATE agent_workflow_template_ratings
        SET rating = ?,
            comment = ?,
            created_at = NOW()
        WHERE id = ?
        RETURNING *
      `, [rating, comment, existing.id]);
      result = rows[0];
    } else {
      const rows = await query(`
        INSERT INTO agent_workflow_template_ratings (template_id, user_id, rating, comment, created_at)
        VALUES (?, ?, ?, ?, NOW())
        RETURNING *
      `, [template_id, user_id, rating, comment]);
      result = rows[0];
    }

    await this.updateTemplateRatingStats(template_id);
    return result;
  }

  /**
   * 更新模板的评分统计
   */
  async updateTemplateRatingStats(templateId) {
    const stats = await queryOne(`
      SELECT 
        COUNT(*) as count,
        AVG(rating) as avg
      FROM agent_workflow_template_ratings
      WHERE template_id = ?
    `, [templateId]);

    const count = parseInt(stats?.count || 0, 10);
    const avg = stats?.avg ? parseFloat(stats.avg).toFixed(2) : 5.0;

    await execute(`
      UPDATE agent_workflow_templates
      SET rating_count = ?,
          rating_avg = ?,
          updated_at = NOW()
      WHERE id = ?
    `, [count, avg, templateId]);
  }

  /**
   * 获取模板评分列表
   */
  async getTemplateRatings(templateId, options = {}) {
    const { page = 1, pageSize = 10 } = options;
    const limit = Number(pageSize) || 10;
    const offset = ((Number(page) || 1) - 1) * limit;

    const countRow = await queryOne(
      'SELECT COUNT(*) as count FROM agent_workflow_template_ratings WHERE template_id = ?',
      [templateId]
    );

    const rows = await query(`
      SELECT 
        r.*,
        u.username,
        u.nickname
      FROM agent_workflow_template_ratings r
      LEFT JOIN users u ON u.id = r.user_id
      WHERE r.template_id = ?
      ORDER BY r.created_at DESC
      LIMIT ? OFFSET ?
    `, [templateId, limit, offset]);

    return {
      ratings: rows,
      total: parseInt(countRow?.count || 0, 10),
      page: Number(page) || 1,
      pageSize: limit
    };
  }
}

const workflowTemplateRatingService = new WorkflowTemplateRatingService();

module.exports = {
  WorkflowTemplateRatingService,
  workflowTemplateRatingService
};
