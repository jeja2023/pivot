/**
 * 交互空间服务（类似 Claude Artifacts）
 * 为 Agent 生成的内容提供独立的可视化和交互空间
 * 基于 PostgreSQL 原生异步连接池实现
 */

const { query, queryOne, execute, transaction } = require('../../db/client');

/**
 * 交互空间管理器
 */
class ArtifactManager {
  constructor(db) {
    // 兼容可能传入的参数，核心查询走 client.js
    this.db = db;
  }

  /**
   * 创建新的 Artifact
   */
  async create(userId, data) {
    const {
      title,
      description = '',
      type,
      content,
      metadata = {},
      runId = null,
      parentId = null
    } = data;

    // 验证类型
    const validTypes = [
      'html',
      'react',
      'vue',
      'markdown',
      'code',
      'chart',
      'diagram',
      'interactive'
    ];

    if (!validTypes.includes(type)) {
      throw new Error(`不支持的 Artifact 类型: ${type}`);
    }

    const metadataStr = typeof metadata === 'string' ? metadata : JSON.stringify(metadata);
    const uId = String(userId);

    const rows = await query(`
      INSERT INTO agent_artifacts (
        user_id,
        title,
        description,
        type,
        content,
        metadata,
        run_id,
        parent_id,
        version,
        status,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?::jsonb, ?, ?, 1, 'active', NOW(), NOW())
      RETURNING *
    `, [uId, title, description, type, content, metadataStr, runId || null, parentId || null]);

    const artifact = rows[0];
    return this.formatArtifact(artifact);
  }

  /**
   * 更新 Artifact
   */
  async update(artifactId, userId, data) {
    const { title, description, content, metadata } = data;
    const uId = String(userId);

    // 获取当前版本
    const current = await queryOne(
      'SELECT * FROM agent_artifacts WHERE id = ? AND user_id = ?',
      [artifactId, uId]
    );

    if (!current) {
      throw new Error('Artifact 不存在或无权修改');
    }

    // 记录版本历史并更新主记录
    return await transaction(async trx => {
      await trx.execute(`
        INSERT INTO agent_artifact_versions (
          artifact_id,
          version,
          content,
          metadata,
          created_at
        ) VALUES (?, ?, ?, ?::jsonb, ?)
      `, [
        artifactId,
        current.version,
        current.content,
        typeof current.metadata === 'string' ? current.metadata : JSON.stringify(current.metadata || {}),
        current.updated_at || new Date()
      ]);

      const newVersion = (Number(current.version) || 1) + 1;
      const newTitle = title !== undefined ? title : current.title;
      const newDesc = description !== undefined ? description : current.description;
      const newContent = content !== undefined ? content : current.content;
      const newMetadata = metadata !== undefined
        ? (typeof metadata === 'string' ? metadata : JSON.stringify(metadata))
        : (typeof current.metadata === 'string' ? current.metadata : JSON.stringify(current.metadata || {}));

      const rows = await trx.query(`
        UPDATE agent_artifacts
        SET title = ?,
            description = ?,
            content = ?,
            metadata = ?::jsonb,
            version = ?,
            updated_at = NOW()
        WHERE id = ?
        RETURNING *
      `, [newTitle, newDesc, newContent, newMetadata, newVersion, artifactId]);

      return this.formatArtifact(rows[0]);
    });
  }

  /**
   * 获取 Artifact
   */
  async get(artifactId, userId) {
    const artifact = await queryOne(
      'SELECT * FROM agent_artifacts WHERE id = ?',
      [artifactId]
    );

    if (!artifact) {
      throw new Error('Artifact 不存在');
    }

    const uId = String(userId);
    // 检查访问权限（公开或所有者）
    if (artifact.status !== 'public' && String(artifact.user_id) !== uId) {
      throw new Error('无权访问此 Artifact');
    }

    return this.formatArtifact(artifact);
  }

  /**
   * 获取 Artifact 版本历史
   */
  async getVersions(artifactId, userId) {
    const uId = String(userId);
    const artifact = await queryOne(
      'SELECT * FROM agent_artifacts WHERE id = ? AND user_id = ?',
      [artifactId, uId]
    );

    if (!artifact) {
      throw new Error('Artifact 不存在或无权访问');
    }

    const versions = await query(
      'SELECT * FROM agent_artifact_versions WHERE artifact_id = ? ORDER BY version DESC',
      [artifactId]
    );

    return versions.map(v => ({
      ...v,
      metadata: typeof v.metadata === 'string' ? JSON.parse(v.metadata || '{}') : (v.metadata || {})
    }));
  }

  /**
   * 恢复到指定版本
   */
  async restoreVersion(artifactId, userId, targetVersionNum) {
    const uId = String(userId);
    const artifact = await queryOne(
      'SELECT * FROM agent_artifacts WHERE id = ? AND user_id = ?',
      [artifactId, uId]
    );

    if (!artifact) {
      throw new Error('Artifact 不存在或无权修改');
    }

    const targetVersion = await queryOne(
      'SELECT * FROM agent_artifact_versions WHERE artifact_id = ? AND version = ?',
      [artifactId, Number(targetVersionNum)]
    );

    if (!targetVersion) {
      throw new Error('指定版本不存在');
    }

    return await transaction(async trx => {
      // 保存当前版本到历史表
      await trx.execute(`
        INSERT INTO agent_artifact_versions (
          artifact_id,
          version,
          content,
          metadata,
          created_at
        ) VALUES (?, ?, ?, ?::jsonb, ?)
      `, [
        artifactId,
        artifact.version,
        artifact.content,
        typeof artifact.metadata === 'string' ? artifact.metadata : JSON.stringify(artifact.metadata || {}),
        artifact.updated_at || new Date()
      ]);

      const nextVersion = (Number(artifact.version) || 1) + 1;
      const targetMetadataStr = typeof targetVersion.metadata === 'string'
        ? targetVersion.metadata
        : JSON.stringify(targetVersion.metadata || {});

      const rows = await trx.query(`
        UPDATE agent_artifacts
        SET content = ?,
            metadata = ?::jsonb,
            version = ?,
            updated_at = NOW()
        WHERE id = ?
        RETURNING *
      `, [targetVersion.content, targetMetadataStr, nextVersion, artifactId]);

      return this.formatArtifact(rows[0]);
    });
  }

  /**
   * 列出用户的 Artifacts
   */
  async list(userId, options = {}) {
    const {
      type,
      status = 'active',
      runId,
      limit = 20,
      offset = 0
    } = options;

    const uId = String(userId);
    const conditions = ['user_id = ?'];
    const params = [uId];

    if (type) {
      conditions.push('type = ?');
      params.push(type);
    }

    if (status && status !== 'all') {
      conditions.push('status = ?');
      params.push(status);
    }

    if (runId) {
      conditions.push('run_id = ?');
      params.push(runId);
    }

    const whereClause = conditions.join(' AND ');

    // 查询总数
    const countRow = await queryOne(
      `SELECT COUNT(*) as count FROM agent_artifacts WHERE ${whereClause}`,
      params
    );
    const total = Number(countRow?.count || 0);

    // 查询列表
    const listParams = [...params, Number(limit) || 20, Number(offset) || 0];
    const rows = await query(`
      SELECT * FROM agent_artifacts
      WHERE ${whereClause}
      ORDER BY updated_at DESC
      LIMIT ? OFFSET ?
    `, listParams);

    return {
      artifacts: rows.map(a => this.formatArtifact(a)),
      total,
      limit: Number(limit) || 20,
      offset: Number(offset) || 0
    };
  }

  /**
   * 删除 Artifact (软删除)
   */
  async delete(artifactId, userId) {
    const uId = String(userId);
    const artifact = await queryOne(
      'SELECT id FROM agent_artifacts WHERE id = ? AND user_id = ?',
      [artifactId, uId]
    );

    if (!artifact) {
      throw new Error('Artifact 不存在或无权删除');
    }

    await execute(
      "UPDATE agent_artifacts SET status = 'deleted', updated_at = NOW() WHERE id = ?",
      [artifactId]
    );

    return { success: true };
  }

  /**
   * 分享 Artifact
   */
  async share(artifactId, userId, options = {}) {
    const { visibility = 'public', expiresIn } = options;
    const uId = String(userId);

    const artifact = await queryOne(
      'SELECT id FROM agent_artifacts WHERE id = ? AND user_id = ?',
      [artifactId, uId]
    );

    if (!artifact) {
      throw new Error('Artifact 不存在或无权分享');
    }

    const expiresAt = expiresIn
      ? new Date(Date.now() + expiresIn * 1000)
      : null;

    const rows = await query(`
      INSERT INTO agent_artifact_shares (
        artifact_id,
        visibility,
        expires_at,
        created_at
      ) VALUES (?, ?, ?, NOW())
      RETURNING *
    `, [artifactId, visibility, expiresAt]);

    const share = rows[0];
    const shareUrl = `/artifacts/shared/${share.id}`;

    return {
      shareId: share.id,
      shareUrl,
      visibility,
      expiresAt: share.expires_at
    };
  }

  /**
   * 获取分享的 Artifact
   */
  async getShared(shareId) {
    const share = await queryOne(
      'SELECT * FROM agent_artifact_shares WHERE id = ?',
      [shareId]
    );

    if (!share) {
      throw new Error('分享链接不存在');
    }

    // 检查是否过期
    if (share.expires_at && new Date(share.expires_at) < new Date()) {
      throw new Error('分享链接已过期');
    }

    const artifact = await queryOne(
      'SELECT * FROM agent_artifacts WHERE id = ?',
      [share.artifact_id]
    );

    if (!artifact || artifact.status === 'deleted') {
      throw new Error('Artifact 不存在或已下架');
    }

    return this.formatArtifact(artifact);
  }

  /**
   * 记录交互事件
   */
  async recordInteraction(artifactId, userId, interaction) {
    const { type, data } = interaction;
    const uId = userId ? String(userId) : null;
    const dataStr = typeof data === 'string' ? data : JSON.stringify(data || {});

    await execute(`
      INSERT INTO agent_artifact_interactions (
        artifact_id,
        user_id,
        interaction_type,
        interaction_data,
        created_at
      ) VALUES (?, ?, ?, ?::jsonb, NOW())
    `, [artifactId, uId, type, dataStr]);
  }

  /**
   * 获取交互统计
   */
  async getInteractionStats(artifactId, userId) {
    const uId = String(userId);
    const artifact = await queryOne(
      'SELECT id FROM agent_artifacts WHERE id = ? AND user_id = ?',
      [artifactId, uId]
    );

    if (!artifact) {
      throw new Error('Artifact 不存在或无权访问');
    }

    const interactions = await query(`
      SELECT interaction_type, COUNT(*) as count
      FROM agent_artifact_interactions
      WHERE artifact_id = ?
      GROUP BY interaction_type
    `, [artifactId]);

    const viewRow = await queryOne(`
      SELECT COUNT(*) as count
      FROM agent_artifact_interactions
      WHERE artifact_id = ? AND interaction_type = 'view'
    `, [artifactId]);

    return {
      totalViews: Number(viewRow?.count || 0),
      interactions: interactions.map(i => ({
        type: i.interaction_type,
        count: Number(i.count)
      }))
    };
  }

  /**
   * 添加评论
   */
  async addComment(artifactId, userId, { content, parentId = null }) {
    const uId = String(userId);
    const rows = await query(`
      INSERT INTO agent_artifact_comments (
        artifact_id,
        user_id,
        parent_id,
        content,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, NOW(), NOW())
      RETURNING *
    `, [artifactId, uId, parentId || null, content]);

    return rows[0];
  }

  /**
   * 获取评论列表
   */
  async getComments(artifactId, options = {}) {
    const { limit = 50, offset = 0 } = options;

    const countRow = await queryOne(
      'SELECT COUNT(*) as count FROM agent_artifact_comments WHERE artifact_id = ?',
      [artifactId]
    );
    const total = Number(countRow?.count || 0);

    const comments = await query(`
      SELECT 
        c.*,
        u.username,
        u.nickname
      FROM agent_artifact_comments c
      LEFT JOIN users u ON u.id::TEXT = c.user_id
      WHERE c.artifact_id = ?
      ORDER BY c.created_at ASC
      LIMIT ? OFFSET ?
    `, [artifactId, Number(limit) || 50, Number(offset) || 0]);

    return {
      comments,
      total,
      limit: Number(limit) || 50,
      offset: Number(offset) || 0
    };
  }

  /**
   * 删除评论
   */
  async deleteComment(commentId, userId) {
    const uId = String(userId);
    const comment = await queryOne(
      'SELECT id FROM agent_artifact_comments WHERE id = ? AND user_id = ?',
      [commentId, uId]
    );

    if (!comment) {
      throw new Error('评论不存在或无权删除');
    }

    await execute(
      'DELETE FROM agent_artifact_comments WHERE id = ?',
      [commentId]
    );

    return { success: true };
  }

  /**
   * 格式化 Artifact 数据
   */
  formatArtifact(artifact) {
    if (!artifact) return null;
    return {
      ...artifact,
      metadata: typeof artifact.metadata === 'string'
        ? JSON.parse(artifact.metadata || '{}')
        : (artifact.metadata || {})
    };
  }
}

module.exports = {
  ArtifactManager
};
