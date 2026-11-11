/**
 * 交互空间服务（类似 Claude Artifacts）
 * 为 Agent 生成的内容提供独立的可视化和交互空间
 * 基于 PostgreSQL 原生异步连接池实现
 */

const { query, queryOne, execute, transaction } = require('../../db/client');
const { assertGenericArtifactAccess, assertArtifactSources } = require('../artifact-source-access');
const normalizeArtifactUser = user => user && typeof user === 'object' ? user : { id: user };
const metadataValue = value => {
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch (_) { throw Object.assign(new Error('产物元数据需要有效 JSON 对象。'), { status: 400 }); } }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Object.assign(new Error('产物元数据需要有效 JSON 对象。'), { status: 400 });
  return value;
};

/**
 * 交互空间管理器
 */
class ArtifactManager {
  constructor(db) {
    // 兼容可能传入的参数，核心查询走 client.js
    this.db = db;
  }

  async assertCanReadArtifact(artifactId, userId) {
    return this.get(artifactId, userId);
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
      throw Object.assign(new Error(`不支持的产物类型：${type}`), { status: 400 });
    }

    const user = normalizeArtifactUser(userId), metadataStr = JSON.stringify(metadataValue(metadata));
    if (typeof title !== 'string' || !title.trim() || title.length > 160 || typeof content !== 'string' || !content.trim()) throw Object.assign(new Error('请填写有效的产物标题和内容。'), { status: 400 });
    const artifact = await transaction(async trx => {
      if (runId && !await trx.queryOne('SELECT id FROM agent_runs WHERE id = ? AND user_id = ? AND deleted_at IS NULL', [runId, user.id])) throw Object.assign(new Error('任务不存在或无权创建产物。'), { status: 404 });
      if (parentId) await this.get(parentId, user);
      const created = await require('../agent-artifacts').createStandaloneArtifact(user, { title, type, content, preserveWhitespace: true }, { executor: trx });
      await trx.execute('UPDATE agent_artifacts SET description = ?, metadata = ?::jsonb, run_id = ?, parent_id = ? WHERE id = ?', [description, metadataStr, runId, parentId, created.id]);
      await trx.execute('UPDATE agent_artifact_versions SET metadata = ?::jsonb WHERE id = ?', [metadataStr, created.current_version_id]);
      return created;
    });
    return this.get(artifact.id, user);
  }

  /**
   * 更新 Artifact
   */
  async update(artifactId, userId, data = {}) {
    const user = normalizeArtifactUser(userId), current = await this.get(artifactId, user);
    if (String(current.user_id) !== String(user.id)) throw Object.assign(new Error('只有所有者可以修改产物。'), { status: 403 });
    if (current.type === 'mindmap') throw Object.assign(new Error('请通过思维导图应用保存，以保留版本与冲突保护。'), { status: 409 });
    if (String(current.type || '').startsWith('presentation')) throw Object.assign(new Error('请在 PPT 工作台修订文稿，以保留来源、页面校验和版本一致性。'), { status: 409, code: 'PRESENTATION_APP_REQUIRED' });
    if (data.title !== undefined && (typeof data.title !== 'string' || !data.title.trim() || data.title.length > 160)) throw Object.assign(new Error('产物标题应为一至一百六十个字符。'), { status: 400 });
    if (data.description !== undefined && (typeof data.description !== 'string' || data.description.length > 4000)) throw Object.assign(new Error('产物说明最多四千个字符。'), { status: 400 });
    if (data.content !== undefined && (typeof data.content !== 'string' || !data.content.trim())) throw Object.assign(new Error('产物内容不能为空。'), { status: 400 });
    const saved = await require('../agent-artifacts').createAgentArtifactVersion(artifactId, user, {
      ...data, ...(data.metadata === undefined ? {} : { metadata: metadataValue(data.metadata) }), preserveWhitespace: true
    });
    return this.formatArtifact(saved);
  }

  /**
   * 获取 Artifact
   */
  async get(artifactId, userId) {
    const artifact = await queryOne(`SELECT a.*, v.version AS current_version FROM agent_artifacts a
      LEFT JOIN agent_artifact_versions v ON v.id = a.current_version_id WHERE a.id = ?`, [artifactId]);
    await assertGenericArtifactAccess(artifact, normalizeArtifactUser(userId));
    return this.formatArtifact(artifact);
  }

  /**
   * 获取 Artifact 版本历史
   */
  async getVersions(artifactId, userId) {
    const user = normalizeArtifactUser(userId), artifact = await this.get(artifactId, user);
    if (String(artifact.user_id) !== String(user.id)) throw Object.assign(new Error('只有所有者可以读取产物历史。'), { status: 403 });
    const versions = await query('SELECT * FROM agent_artifact_versions WHERE artifact_id = ? ORDER BY version DESC', [artifactId]);
    for (const version of versions) await assertArtifactSources({ ...artifact, content: version.content }, user);
    return versions.map(version => ({ ...version, metadata: metadataValue(version.metadata || {}) }));
  }

  /**
   * 恢复到指定版本
   */
  async restoreVersion(artifactId, userId, targetVersionNum, expectedVersion) {
    const user = normalizeArtifactUser(userId), artifact = await this.get(artifactId, user);
    if (artifact.type === 'mindmap') throw Object.assign(new Error('请在思维导图应用中恢复历史版本。'), { status: 409 });
    if (!Number.isSafeInteger(Number(targetVersionNum)) || Number(targetVersionNum) < 1) throw Object.assign(new Error('请选择有效的产物历史版本。'), { status: 400 });
    const target = await queryOne('SELECT * FROM agent_artifact_versions WHERE artifact_id = ? AND version = ?', [artifactId, Number(targetVersionNum)]);
    if (!target) throw Object.assign(new Error('指定版本不存在。'), { status: 404 });
    await assertArtifactSources({ ...artifact, content: target.content }, user);
    return this.update(artifactId, user, { content: target.content, metadata: metadataValue(target.metadata || {}), expectedVersion, note: `恢复历史版本 ${targetVersionNum}` });
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

    const uId = String(normalizeArtifactUser(userId).id);
    const conditions = ["user_id = ? AND COALESCE(status, 'active') <> 'deleted' AND type NOT IN ('policy_review_report','policy_review_material')"];
    const params = [uId];

    if (type) {
      conditions.push('type = ?');
      params.push(type);
    }

    if (status && status !== 'all') {
      conditions.push("COALESCE(status, 'active') = ?");
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
    const safeLimit = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 20)), safeOffset = Math.max(0, Number.parseInt(offset, 10) || 0);
    const listParams = [...params, safeLimit, safeOffset];
    const rows = await query(`
      SELECT agent_artifacts.*, (SELECT version FROM agent_artifact_versions WHERE id = agent_artifacts.current_version_id) AS current_version FROM agent_artifacts
      WHERE ${whereClause}
      ORDER BY updated_at DESC
      LIMIT ? OFFSET ?
    `, listParams);

    const visible = [];
    for (const row of rows) {
      try { await assertGenericArtifactAccess(row, normalizeArtifactUser(userId)); visible.push(this.formatArtifact(row)); }
      catch (error) { if (![403, 404, 409].includes(error.status)) throw error; }
    }
    return {
      artifacts: visible,
      total,
      limit: safeLimit,
      offset: safeOffset
    };
  }

  /**
   * 删除 Artifact (软删除)
   */
  async delete(artifactId, userId) {
    const uId = String(normalizeArtifactUser(userId).id);
    const artifact = await queryOne(
      "SELECT * FROM agent_artifacts WHERE id = ? AND user_id = ? AND COALESCE(status, 'active') <> 'deleted'",
      [artifactId, uId]
    );

    if (!artifact) {
      throw Object.assign(new Error('产物不存在或无权删除。'), { status: 404 });
    }
    require('../policy-review/artifact-boundary').assertGenericAccess(artifact);
    if (artifact.type === 'mindmap') throw Object.assign(new Error('请在思维导图应用中删除文档，以保留冲突保护。'), { status: 409 });

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
    if (visibility !== 'public') throw Object.assign(new Error('不支持的分享范围'), { status: 400 });
    const uId = String(normalizeArtifactUser(userId).id);

    const artifact = await queryOne(
      "SELECT * FROM agent_artifacts WHERE id = ? AND user_id = ? AND COALESCE(status, 'active') <> 'deleted'",
      [artifactId, uId]
    );

    if (!artifact) {
      throw Object.assign(new Error('产物不存在或无权分享。'), { status: 404 });
    }
    require('../policy-review/artifact-boundary').assertGenericAccess(artifact);
    if (artifact.type === 'mindmap') throw Object.assign(new Error('当前思维导图仅支持本人访问。'), { status: 409 });
    await assertGenericArtifactAccess(artifact, normalizeArtifactUser(userId));
    await assertGenericArtifactAccess(artifact, null, { shared: true });
    if (expiresIn !== undefined && (!Number.isSafeInteger(Number(expiresIn)) || Number(expiresIn) < 1 || Number(expiresIn) > 31536000)) throw Object.assign(new Error('分享有效期应为一秒至一年的整数秒。'), { status: 400 });

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

    if (!share || share.visibility !== 'public') {
      throw Object.assign(new Error('分享链接不存在。'), { status: 404 });
    }

    // 检查是否过期
    const expires = share.expires_at instanceof Date ? require('../../time').getBeijingTimestamp(share.expires_at) : String(share.expires_at || '');
    if (expires && expires <= require('../../time').getBeijingTimestamp()) {
      throw Object.assign(new Error('分享链接已过期。'), { status: 404 });
    }

    const artifact = await queryOne(
      'SELECT * FROM agent_artifacts WHERE id = ?',
      [share.artifact_id]
    );

    if (!artifact || artifact.status === 'deleted' || artifact.type === 'mindmap') {
      throw Object.assign(new Error('产物不存在或已下架。'), { status: 404 });
    }
    require('../policy-review/artifact-boundary').assertGenericAccess(artifact);

    await assertGenericArtifactAccess(artifact, null, { shared: true });
    return this.formatArtifact(artifact);
  }

  /**
   * 记录交互事件
   */
  async recordInteraction(artifactId, userId, interaction) {
    await this.assertCanReadArtifact(artifactId, userId);
    return this.insertInteraction(artifactId, userId, interaction);
  }

  async recordSharedInteraction(shareId, interaction) {
    const artifact = await this.getShared(shareId);
    return this.insertInteraction(artifact.id, null, interaction);
  }

  async insertInteraction(artifactId, userId, interaction) {
    const { type, data } = interaction;
    const uId = userId ? String(normalizeArtifactUser(userId).id) : null;
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
    const checked = await this.get(artifactId, userId);
    if (String(checked.user_id) !== String(normalizeArtifactUser(userId).id)) throw Object.assign(new Error('只有所有者可以查看产物统计。'), { status: 403 });
    const uId = String(normalizeArtifactUser(userId).id);
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
    await this.assertCanReadArtifact(artifactId, userId);
    if (parentId) {
      const parent = await queryOne('SELECT id FROM agent_artifact_comments WHERE id = ? AND artifact_id = ?', [parentId, artifactId]);
      if (!parent) throw Object.assign(new Error('父评论不存在'), { status: 404 });
    }
    const uId = String(normalizeArtifactUser(userId).id);
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
  async getComments(artifactId, userId, options = {}) {
    await this.assertCanReadArtifact(artifactId, userId);
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
  async deleteComment(commentId, userId, artifactId) {
    const uId = String(normalizeArtifactUser(userId).id);
    const comment = await queryOne(
      'SELECT id, artifact_id FROM agent_artifact_comments WHERE id = ? AND user_id = ?',
      [commentId, uId]
    );

    if (!comment) {
      throw new Error('评论不存在或无权删除');
    }
    if (artifactId && String(comment.artifact_id) !== String(artifactId)) throw Object.assign(new Error('评论不属于当前产物。'), { status: 404 });
    await this.get(comment.artifact_id, userId);

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
      version: Number(artifact.current_version || artifact.version || 1),
      metadata: typeof artifact.metadata === 'string'
        ? JSON.parse(artifact.metadata || '{}')
        : (artifact.metadata || {})
    };
  }
}

module.exports = {
  ArtifactManager
};
