/**
 * 工作流模板系统类型定义
 */

declare namespace WorkflowTemplate {
  /**
   * 模板难度级别
   */
  type Difficulty = 'beginner' | 'intermediate' | 'advanced';

  /**
   * 变量类型
   */
  type VariableType = 'string' | 'number' | 'select' | 'connection_id' | 'model_id' | 'boolean';

  /**
   * 模板变量定义
   */
  interface Variable {
    /** 变量名（唯一标识符） */
    name: string;
    /** 变量类型 */
    type: VariableType;
    /** 显示标签 */
    label: string;
    /** 描述说明 */
    description?: string;
    /** 是否必填 */
    required: boolean;
    /** 默认值 */
    default?: any;
    /** 选项列表（type=select 时使用） */
    options?: Array<{ label: string; value: any }>;
    /** 验证规则 */
    validation?: {
      /** 最小值/最小长度 */
      min?: number;
      /** 最大值/最大长度 */
      max?: number;
      /** 正则表达式 */
      pattern?: string;
      /** 验证失败提示信息 */
      message?: string;
    };
  }

  /**
   * 模板定义
   */
  interface Template {
    /** 模板 ID */
    id: number;
    /** 模板名称 */
    name: string;
    /** 模板唯一标识符 */
    slug: string;
    /** 所属分类 ID */
    category_id?: number;
    /** 分类名称 */
    category_name?: string;
    /** 分类 slug */
    category_slug?: string;
    /** 描述 */
    description: string;
    /** 标签 */
    tags: string[];
    /** 难度级别 */
    difficulty: Difficulty;
    /** 预估时间 */
    estimated_time: string;
    /** 图标 */
    icon?: string;
    /** 预览图 */
    preview_image?: string;
    /** 示例输出 */
    example_output?: string;
    /** 文档说明 */
    documentation?: string;
    /** DAG 结构模板 */
    dag_spec_template: any;
    /** 变量定义列表 */
    variables: Variable[];
    /** 使用次数 */
    usage_count: number;
    /** 平均评分 */
    rating_avg: number;
    /** 评分数量 */
    rating_count: number;
    /** 是否内置模板 */
    is_builtin: boolean;
    /** 是否公开 */
    is_public: boolean;
    /** 是否启用 */
    is_active: boolean;
    /** 创建者 ID */
    created_by?: number;
    /** 创建者昵称 */
    author_nickname?: string;
    /** 当前版本 ID */
    current_version_id?: number;
    /** 当前版本号 */
    current_version?: string;
    /** 版本更新日志 */
    current_changelog?: string;
    /** 创建时间 */
    created_at: string;
    /** 更新时间 */
    updated_at: string;
    /** 用户评分（已登录用户） */
    user_rating?: {
      rating: number;
      comment: string;
    } | null;
  }

  /**
   * 模板版本
   */
  interface TemplateVersion {
    /** 版本 ID */
    id: number;
    /** 模板 ID */
    template_id: number;
    /** 版本号 */
    version: string;
    /** 更新日志 */
    changelog: string;
    /** DAG 结构快照 */
    dag_spec_template: any;
    /** 变量定义快照 */
    variables: Variable[];
    /** 是否已发布 */
    is_published: boolean;
    /** 发布者 ID */
    published_by?: number;
    /** 发布时间 */
    published_at?: string;
    /** 创建时间 */
    created_at: string;
  }

  /**
   * 模板分类
   */
  interface Category {
    /** 分类 ID */
    id: number;
    /** 分类名称 */
    name: string;
    /** 分类唯一标识符 */
    slug: string;
    /** 描述 */
    description?: string;
    /** 图标 */
    icon?: string;
    /** 显示顺序 */
    display_order: number;
    /** 是否启用 */
    is_active: boolean;
    /** 创建时间 */
    created_at: string;
    /** 更新时间 */
    updated_at: string;
  }

  /**
   * 模板使用记录
   */
  interface Usage {
    /** 记录 ID */
    id: number;
    /** 模板 ID */
    template_id: number;
    /** 创建的工作流 ID */
    workflow_id?: number;
    /** 用户 ID */
    user_id: number;
    /** 使用的变量值 */
    variables_used: Record<string, any>;
    /** 创建时间 */
    created_at: string;
  }

  /**
   * 模板评分
   */
  interface Rating {
    /** 评分 ID */
    id: number;
    /** 模板 ID */
    template_id: number;
    /** 用户 ID */
    user_id: number;
    /** 评分（1-5） */
    rating: number;
    /** 评论 */
    comment?: string;
    /** 创建时间 */
    created_at: string;
    /** 更新时间 */
    updated_at: string;
  }

  /**
   * 列表查询选项
   */
  interface ListOptions {
    /** 分类筛选 */
    category?: string;
    /** 难度筛选 */
    difficulty?: Difficulty;
    /** 搜索关键词 */
    search?: string;
    /** 排序字段 */
    sortBy?: 'usage_count' | 'rating_avg' | 'created_at' | 'updated_at';
    /** 排序方向 */
    sortOrder?: 'asc' | 'desc';
    /** 页码 */
    page?: number;
    /** 每页数量 */
    pageSize?: number;
    /** 是否包含私有模板 */
    includePrivate?: boolean;
    /** 当前用户 ID */
    userId?: number;
  }

  /**
   * 列表查询结果
   */
  interface ListResult {
    /** 模板列表 */
    templates: Template[];
    /** 分页信息 */
    pagination: {
      page: number;
      pageSize: number;
      total: number;
      totalPages: number;
    };
  }

  /**
   * 应用模板选项
   */
  interface ApplyOptions {
    /** 模板 ID */
    templateId: number;
    /** 变量值映射 */
    variables: Record<string, any>;
    /** 用户 ID */
    userId: number;
  }

  /**
   * 评分选项
   */
  interface RateOptions {
    /** 模板 ID */
    templateId: number;
    /** 评分（1-5） */
    rating: number;
    /** 评论 */
    comment?: string;
    /** 用户 ID */
    userId: number;
  }
}

export = WorkflowTemplate;
export as namespace WorkflowTemplate;
