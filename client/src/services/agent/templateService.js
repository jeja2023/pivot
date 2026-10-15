/**
 * 工作流模板前端服务
 * 封装所有与模板相关的 API 调用
 */

(function (window) {
  'use strict';

  const API_BASE = '/api/agent';

  class TemplateService {
    /**
     * 获取模板列表
     */
    async listTemplates(params = {}) {
      const queryString = new URLSearchParams({
        page: params.page || 1,
        pageSize: params.pageSize || 12,
        category: params.category || '',
        difficulty: params.difficulty || '',
        search: params.search || '',
        sortBy: params.sortBy || 'rating_avg',
      }).toString();

      const response = await fetch(`${API_BASE}/workflow-templates?${queryString}`);
      if (!response.ok) {
        throw new Error('获取模板列表失败');
      }

      return response.json();
    }

    /**
     * 获取精选模板
     */
    async getFeaturedTemplates() {
      const response = await fetch(`${API_BASE}/workflow-templates/featured`);
      if (!response.ok) {
        throw new Error('获取精选模板失败');
      }

      return response.json();
    }

    /**
     * 搜索模板
     */
    async searchTemplates(query) {
      const response = await fetch(
        `${API_BASE}/workflow-templates/search?q=${encodeURIComponent(query)}`
      );
      if (!response.ok) {
        throw new Error('搜索模板失败');
      }

      return response.json();
    }

    /**
     * 获取分类列表
     */
    async getCategories() {
      const response = await fetch(`${API_BASE}/workflow-templates/categories`);
      if (!response.ok) {
        throw new Error('获取分类列表失败');
      }

      const result = await response.json();
      return result.data || [];
    }

    /**
     * 获取模板详情
     */
    async getTemplateById(id) {
      const response = await fetch(`${API_BASE}/workflow-templates/${id}`);
      if (!response.ok) {
        throw new Error('获取模板详情失败');
      }

      const result = await response.json();
      return result.data;
    }

    /**
     * 应用模板（创建工作流实例）
     */
    async applyTemplate(templateId, variables) {
      const response = await fetch(
        `${API_BASE}/workflow-templates/${templateId}/apply`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ variables }),
        }
      );

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || '应用模板失败');
      }

      const result = await response.json();
      return result.data;
    }

    /**
     * 评分模板
     */
    async rateTemplate(templateId, rating, comment = '') {
      const response = await fetch(
        `${API_BASE}/workflow-templates/${templateId}/rate`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ rating, comment }),
        }
      );

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || '评分失败');
      }

      return response.json();
    }

    /**
     * 获取模板评价
     */
    async getTemplateRatings(templateId, limit = 10) {
      const response = await fetch(
        `${API_BASE}/workflow-templates/${templateId}/ratings?limit=${limit}`
      );
      if (!response.ok) {
        throw new Error('获取评价失败');
      }

      const result = await response.json();
      return result.data || [];
    }

    /**
     * 创建模板（管理员）
     */
    async createTemplate(templateData) {
      const response = await fetch(`${API_BASE}/workflow-templates`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(templateData),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || '创建模板失败');
      }

      const result = await response.json();
      return result.data;
    }

    /**
     * 更新模板（管理员）
     */
    async updateTemplate(id, templateData) {
      const response = await fetch(`${API_BASE}/workflow-templates/${id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(templateData),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || '更新模板失败');
      }

      const result = await response.json();
      return result.data;
    }

    /**
     * 删除模板（管理员）
     */
    async deleteTemplate(id) {
      const response = await fetch(`${API_BASE}/workflow-templates/${id}`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || '删除模板失败');
      }

      return response.json();
    }

    /**
     * 获取工作流实例列表
     */
    async listInstances(filters = {}) {
      const queryString = new URLSearchParams(filters).toString();
      const response = await fetch(`${API_BASE}/workflow-instances?${queryString}`);
      if (!response.ok) {
        throw new Error('获取实例列表失败');
      }

      const result = await response.json();
      return result.data || [];
    }

    /**
     * 获取工作流实例详情
     */
    async getInstanceById(id) {
      const response = await fetch(`${API_BASE}/workflow-instances/${id}`);
      if (!response.ok) {
        throw new Error('获取实例详情失败');
      }

      const result = await response.json();
      return result.data;
    }

    /**
     * 更新实例状态
     */
    async updateInstanceStatus(id, status, data = {}) {
      const response = await fetch(
        `${API_BASE}/workflow-instances/${id}/status`,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ status, ...data }),
        }
      );

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || '更新状态失败');
      }

      const result = await response.json();
      return result.data;
    }

    /**
     * 删除实例
     */
    async deleteInstance(id) {
      const response = await fetch(`${API_BASE}/workflow-instances/${id}`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || '删除实例失败');
      }

      return response.json();
    }
  }

  // 暴露到全局
  window.TemplateService = new TemplateService();
})(window);
