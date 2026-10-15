/**
 * Artifacts 多模态产物交互空间类型定义
 */

declare namespace Artifacts {
  /**
   * 产物内容类型
   */
  type ArtifactType =
    | 'html'
    | 'react'
    | 'vue'
    | 'markdown'
    | 'code'
    | 'chart'
    | 'diagram'
    | 'interactive';

  /**
   * 产物生命周期状态
   */
  type ArtifactStatus = 'active' | 'archived' | 'deleted' | 'public';

  /**
   * 分享可见性
   */
  type ShareVisibility = 'public' | 'private' | 'team';

  /**
   * 交互事件类型
   */
  type InteractionType =
    | 'view'
    | 'edit'
    | 'download'
    | 'share'
    | 'copy'
    | 'comment'
    | 'restore'
    | 'shared_view';

  /**
   * 产物核心实体
   */
  interface Artifact {
    /** 产物唯一 UUID */
    id: string;
    /** 所属用户 ID (字符串化 BIGINT 或 UUID) */
    user_id: string;
    /** 标题 */
    title: string;
    /** 详细描述或摘要 */
    description?: string;
    /** 产物模态类型 */
    type: ArtifactType;
    /** 原始内容（HTML代码、Markdown源码、代码文本等） */
    content: string;
    /** 扩展元数据 (JSONB) */
    metadata?: Record<string, any>;
    /** 关联的智能体运行任务 ID */
    run_id?: string | null;
    /** 派生源父级产物 ID */
    parent_id?: string | null;
    /** 当前版本序号 (从 1 递增) */
    version: number;
    /** 状态 */
    status: ArtifactStatus;
    /** 创建时间 */
    created_at: string;
    /** 更新时间 */
    updated_at: string;
  }

  /**
   * 产物历史版本
   */
  interface ArtifactVersion {
    /** 历史记录唯一 UUID */
    id: string;
    /** 关联产物 ID */
    artifact_id: string;
    /** 版本序号 */
    version: number;
    /** 当时版本的内容快照 */
    content: string;
    /** 当时版本的元数据快照 */
    metadata?: Record<string, any>;
    /** 归档时间 */
    created_at: string;
  }

  /**
   * 产物分享链接记录
   */
  interface ArtifactShare {
    /** 分享凭证 UUID (用于 /artifacts/shared/:shareId) */
    id: string;
    /** 关联产物 ID */
    artifact_id: string;
    /** 可见度设置 */
    visibility: ShareVisibility;
    /** 过期时间 (null 为永不过期) */
    expires_at?: string | null;
    /** 创建时间 */
    created_at: string;
  }

  /**
   * 交互审计日志
   */
  interface ArtifactInteraction {
    /** 日志 UUID */
    id: string;
    /** 产物 ID */
    artifact_id: string;
    /** 交互发起人 ID */
    user_id?: string | null;
    /** 交互类型 */
    interaction_type: InteractionType;
    /** 交互上下文附带数据 */
    interaction_data?: Record<string, any>;
    /** 发生时间 */
    created_at: string;
  }

  /**
   * 产物讨论与批注
   */
  interface ArtifactComment {
    /** 评论 UUID */
    id: string;
    /** 关联产物 ID */
    artifact_id: string;
    /** 评论作者用户 ID */
    user_id: string;
    /** 父评论 ID (线程回复) */
    parent_id?: string | null;
    /** 评论正文 */
    content: string;
    /** 创建时间 */
    created_at: string;
    /** 修改时间 */
    updated_at: string;
    /** 作者用户名 */
    username?: string;
    /** 作者昵称 */
    nickname?: string;
  }

  /**
   * 创建产物 DTO
   */
  interface CreateArtifactDTO {
    title: string;
    type: ArtifactType;
    content: string;
    description?: string;
    metadata?: Record<string, any>;
    runId?: string;
    parentId?: string;
  }

  /**
   * 更新产物 DTO
   */
  interface UpdateArtifactDTO {
    title?: string;
    description?: string;
    content?: string;
    metadata?: Record<string, any>;
  }

  /**
   * 渲染器配置项
   */
  interface RendererOptions {
    showToolbar?: boolean;
    theme?: 'light' | 'dark' | 'auto';
    sandboxPermissions?: string;
    onCopy?: (content: string) => void;
    onDownload?: (artifact: Artifact) => void;
  }

  /**
   * 交互统计结果
   */
  interface InteractionStats {
    totalViews: number;
    interactions: Array<{
      type: InteractionType;
      count: number;
    }>;
  }
}

export = Artifacts;
