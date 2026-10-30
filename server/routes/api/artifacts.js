/**
 * Artifacts 交互空间 API 路由
 * 提供 RESTful 产物管理、多版本协同、安全分享与讨论端点
 */

const express = require('express');
const router = express.Router();
const { ArtifactManager } = require('../../services/agent-runtime/artifact-manager');
const { authMiddleware: requireAuth } = require('../../auth');

const artifactManager = new ArtifactManager();

/**
 * 创建 Artifact
 * POST /api/artifacts
 */
router.post('/', requireAuth, async (req, res) => {
  try {
    const { title, description, type, content, metadata, runId, parentId } = req.body;

    if (!title || !type || content === undefined || content === null) {
      return res.status(400).json({
        success: false,
        error: '标题、类型和内容不能为空'
      });
    }

    const artifact = await artifactManager.create(req.user.id, {
      title,
      description,
      type,
      content,
      metadata,
      runId,
      parentId
    });

    res.status(201).json({
      success: true,
      data: artifact
    });
  } catch (error) {
    console.error('创建 Artifact 失败:', error);
    res.status(500).json({
      success: false,
      error: '创建 Artifact 失败'
    });
  }
});

/**
 * 获取用户的 Artifacts 列表
 * GET /api/artifacts
 */
router.get('/', requireAuth, async (req, res) => {
  try {
    const { type, status, runId, limit, offset } = req.query;

    const result = await artifactManager.list(req.user.id, {
      type,
      status,
      runId,
      limit: parseInt(limit, 10) || 20,
      offset: parseInt(offset, 10) || 0
    });

    res.json({
      success: true,
      data: result.artifacts,
      pagination: {
        total: result.total,
        limit: result.limit,
        offset: result.offset
      }
    });
  } catch (error) {
    console.error('获取 Artifacts 列表失败:', error);
    res.status(500).json({
      success: false,
      error: '获取 Artifacts 列表失败'
    });
  }
});

/**
 * 获取分享的 Artifact (公开免密或凭证访问)
 * GET /api/artifacts/shared/:shareId
 * 注意：必须在 GET /:id 之前注册以避免路由冲突
 */
router.get('/shared/:shareId', async (req, res) => {
  try {
    const { shareId } = req.params;
    const artifact = await artifactManager.getShared(shareId);

    // 记录匿名查看交互
    await artifactManager.recordSharedInteraction(shareId, {
      type: 'shared_view',
      data: { shareId, timestamp: new Date() }
    }).catch(() => {});

    res.json({
      success: true,
      data: artifact
    });
  } catch (error) {
    console.error('获取分享 Artifact 失败:', error);
    const msg = error.message || '';
    const status = (msg.includes('不存在') || msg.includes('过期')) ? 404 : 500;
    res.status(status).json({
      success: false,
      error: status === 404 ? '分享链接不存在或已过期' : '获取分享 Artifact 失败'
    });
  }
});

/**
 * 获取 Artifact 详情
 * GET /api/artifacts/:id
 */
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const artifact = await artifactManager.get(id, req.user.id);

    // 记录查看事件
    await artifactManager.recordInteraction(id, req.user.id, {
      type: 'view',
      data: { timestamp: new Date() }
    }).catch(() => {});

    res.json({
      success: true,
      data: artifact
    });
  } catch (error) {
    console.error('获取 Artifact 失败:', error);
    const msg = error.message || '';
    res.status(msg.includes('不存在') ? 404 : 500).json({
      success: false,
      error: msg.includes('不存在') ? 'Artifact 不存在或无权访问' : '获取 Artifact 失败'
    });
  }
});

/**
 * 更新 Artifact
 * PUT /api/artifacts/:id
 */
router.put('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { title, description, content, metadata } = req.body;

    const artifact = await artifactManager.update(id, req.user.id, {
      title,
      description,
      content,
      metadata
    });

    res.json({
      success: true,
      data: artifact
    });
  } catch (error) {
    console.error('更新 Artifact 失败:', error);
    res.status(500).json({
      success: false,
      error: '更新 Artifact 失败'
    });
  }
});

/**
 * 删除 Artifact
 * DELETE /api/artifacts/:id
 */
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    await artifactManager.delete(id, req.user.id);

    res.json({
      success: true,
      message: 'Artifact 已删除'
    });
  } catch (error) {
    console.error('删除 Artifact 失败:', error);
    res.status(500).json({
      success: false,
      error: '删除 Artifact 失败'
    });
  }
});

/**
 * 获取 Artifact 版本历史
 * GET /api/artifacts/:id/versions
 */
router.get('/:id/versions', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const versions = await artifactManager.getVersions(id, req.user.id);

    res.json({
      success: true,
      data: versions
    });
  } catch (error) {
    console.error('获取版本历史失败:', error);
    res.status(500).json({
      success: false,
      error: '获取版本历史失败'
    });
  }
});

/**
 * 恢复到指定版本
 * POST /api/artifacts/:id/restore
 */
router.post('/:id/restore', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { version } = req.body;

    if (!version) {
      return res.status(400).json({
        success: false,
        error: '版本号不能为空'
      });
    }

    const artifact = await artifactManager.restoreVersion(id, req.user.id, version);

    res.json({
      success: true,
      data: artifact
    });
  } catch (error) {
    console.error('恢复版本失败:', error);
    res.status(500).json({
      success: false,
      error: '恢复版本失败'
    });
  }
});

/**
 * 分享 Artifact
 * POST /api/artifacts/:id/share
 */
router.post('/:id/share', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { visibility = 'public', expiresIn } = req.body;
    if (visibility !== 'public') return res.status(400).json({ success: false, error: '不支持的分享范围' });

    const share = await artifactManager.share(id, req.user.id, {
      visibility,
      expiresIn
    });

    res.json({
      success: true,
      data: share
    });
  } catch (error) {
    console.error('分享 Artifact 失败:', error);
    res.status(500).json({
      success: false,
      error: '分享 Artifact 失败'
    });
  }
});

/**
 * 记录交互事件
 * POST /api/artifacts/:id/interact
 */
router.post('/:id/interact', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { type, data } = req.body;

    if (!type) {
      return res.status(400).json({
        success: false,
        error: '交互类型不能为空'
      });
    }

    await artifactManager.recordInteraction(id, req.user.id, { type, data });

    res.json({
      success: true,
      message: '交互已记录'
    });
  } catch (error) {
    console.error('记录交互失败:', error);
    res.status(error.status === 404 ? 404 : 500).json({
      success: false,
      error: error.status === 404 ? 'Artifact 不存在或无权访问' : '记录交互失败'
    });
  }
});

/**
 * 获取交互统计
 * GET /api/artifacts/:id/stats
 */
router.get('/:id/stats', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const stats = await artifactManager.getInteractionStats(id, req.user.id);

    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    console.error('获取交互统计失败:', error);
    res.status(500).json({
      success: false,
      error: '获取交互统计失败'
    });
  }
});

/**
 * 添加评论
 * POST /api/artifacts/:id/comments
 */
router.post('/:id/comments', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { content, parentId } = req.body;

    if (!content || !content.trim()) {
      return res.status(400).json({
        success: false,
        error: '评论内容不能为空'
      });
    }

    const comment = await artifactManager.addComment(id, req.user.id, {
      content: content.trim(),
      parentId: parentId || null
    });

    res.status(201).json({
      success: true,
      data: comment
    });
  } catch (error) {
    console.error('添加评论失败:', error);
    res.status(error.status === 404 ? 404 : 500).json({
      success: false,
      error: error.status === 404 ? 'Artifact 或父评论不存在或无权访问' : '添加评论失败'
    });
  }
});

/**
 * 获取评论列表
 * GET /api/artifacts/:id/comments
 */
router.get('/:id/comments', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { limit = 50, offset = 0 } = req.query;

    const result = await artifactManager.getComments(id, req.user.id, {
      limit: parseInt(limit, 10) || 50,
      offset: parseInt(offset, 10) || 0
    });

    res.json({
      success: true,
      data: result.comments,
      pagination: {
        total: result.total,
        limit: result.limit,
        offset: result.offset
      }
    });
  } catch (error) {
    console.error('获取评论列表失败:', error);
    res.status(error.status === 404 ? 404 : 500).json({
      success: false,
      error: error.status === 404 ? 'Artifact 不存在或无权访问' : '获取评论列表失败'
    });
  }
});

/**
 * 删除评论
 * DELETE /api/artifacts/:id/comments/:commentId
 */
router.delete('/:id/comments/:commentId', requireAuth, async (req, res) => {
  try {
    const { commentId } = req.params;
    await artifactManager.deleteComment(commentId, req.user.id);

    res.json({
      success: true,
      message: '评论已删除'
    });
  } catch (error) {
    console.error('删除评论失败:', error);
    res.status(500).json({
      success: false,
      error: '删除评论失败'
    });
  }
});

module.exports = router;
