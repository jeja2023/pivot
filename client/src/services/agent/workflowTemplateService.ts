/**
 * 工作流模板前端服务
 */

import axios from '../axios';

export interface Template {
  id: number;
  name: string;
  slug: string;
  description: string;
  tags: string[];
  difficulty: 'beginner' | 'intermediate' | 'advanced';
  estimated_time: string;
  icon: string;
  preview_image: string;
  example_output: string;
  documentation: string;
  usage_count: number;
  rating_avg: number;
  rating_count: number;
  category_name: string;
  category_slug: string;
  author_nickname: string;
  is_builtin?: boolean;
  is_public?: boolean;
  is_active?: boolean;
  dag_spec_template: any;
  variables: TemplateVariable[];
  user_rating?: {
    rating: number;
    comment: string;
  } | null;
}

export interface TemplateVariable {
  name: string;
  type: 'string' | 'number' | 'select' | 'connection_id' | 'model_id' | 'boolean';
  label: string;
  description?: string;
  required: boolean;
  default?: any;
  options?: Array<{ label: string; value: any }>;
  validation?: {
    min?: number;
    max?: number;
    pattern?: string;
    message?: string;
  };
}

export interface Category {
  id: number;
  name: string;
  slug: string;
  description: string;
  icon: string;
}

export interface ListTemplatesOptions {
  category?: string;
  difficulty?: string;
  search?: string;
  sortBy?: 'usage_count' | 'rating_avg' | 'created_at';
  sortOrder?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
  includePrivate?: boolean;
}

export interface ListTemplatesResult {
  templates: Template[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
}

class WorkflowTemplateService {
  private readonly baseUrl = '/api/agent/workflow-templates';

  /**
   * 获取模板列表
   */
  async listTemplates(options: ListTemplatesOptions = {}): Promise<ListTemplatesResult> {
    const response = await axios.get(this.baseUrl, { params: options });
    return {
      templates: response.data.data,
      pagination: response.data.pagination,
    };
  }

  /**
   * 获取模板详情
   */
  async getTemplateDetail(slugOrId: string | number): Promise<Template> {
    const response = await axios.get(`${this.baseUrl}/${slugOrId}`);
    return response.data.data;
  }

  /**
   * 创建模板
   */
  async createTemplate(templateData: Partial<Template>): Promise<Template> {
    const response = await axios.post(this.baseUrl, templateData);
    return response.data.data;
  }

  /**
   * 应用模板（创建工作流）
   */
  async applyTemplate(templateId: number, variables: Record<string, any>): Promise<any> {
    const response = await axios.post(`${this.baseUrl}/${templateId}/apply`, { variables });
    return response.data.data;
  }

  /**
   * 评分模板
   */
  async rateTemplate(templateId: number, rating: number, comment?: string): Promise<any> {
    const response = await axios.post(`${this.baseUrl}/${templateId}/rate`, {
      rating,
      comment,
    });
    return response.data.data;
  }

  /**
   * 获取分类列表
   */
  async getCategories(): Promise<Category[]> {
    const response = await axios.get(`${this.baseUrl}/categories/list`);
    return response.data.data;
  }
}

export const workflowTemplateService = new WorkflowTemplateService();
