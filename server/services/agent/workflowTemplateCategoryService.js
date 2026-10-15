/**
 * 工作流模板分类服务
 */

const db = require('../../db/database');

class WorkflowTemplateCategoryService {
  /**
   * 获取所有分类
   */
  async getAllCategories() {
    const categories = await db('workflow_template_categories')
      .orderBy('display_order', 'asc');

    return categories;
  }

  /**
   * 获取分类详情
   */
  async getCategoryBySlug(slug) {
    const category = await db('workflow_template_categories')
      .where('slug', slug)
      .first();

    if (!category) {
      throw new Error('分类不存在');
    }

    return category;
  }

  /**
   * 创建分类
   */
  async createCategory(data) {
    const [category] = await db('workflow_template_categories')
      .insert({
        slug: data.slug,
        name: data.name,
        description: data.description,
        icon: data.icon,
        display_order: data.display_order || 999,
      })
      .returning('*');

    return category;
  }

  /**
   * 更新分类
   */
  async updateCategory(slug, data) {
    const [updated] = await db('workflow_template_categories')
      .where('slug', slug)
      .update({
        name: data.name,
        description: data.description,
        icon: data.icon,
        display_order: data.display_order,
      })
      .returning('*');

    return updated;
  }

  /**
   * 删除分类
   */
  async deleteCategory(slug) {
    // 检查是否有模板使用该分类
    const count = await db('workflow_templates')
      .where('category', slug)
      .count('* as count')
      .first();

    if (count.count > 0) {
      throw new Error('该分类下还有模板，无法删除');
    }

    const deleted = await db('workflow_template_categories')
      .where('slug', slug)
      .del();

    return deleted > 0;
  }

  /**
   * 获取分类及其模板数量
   */
  async getCategoriesWithCount() {
    const categories = await db('workflow_template_categories as c')
      .leftJoin('workflow_templates as t', 'c.slug', 't.category')
      .select(
        'c.*',
        db.raw('COUNT(t.id) as template_count')
      )
      .groupBy('c.slug', 'c.name', 'c.description', 'c.icon', 'c.display_order')
      .orderBy('c.display_order', 'asc');

    return categories;
  }
}

module.exports = new WorkflowTemplateCategoryService();
