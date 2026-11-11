/**
 * Artifacts 交互空间 API 路由
 * 提供 RESTful 产物管理、多版本协同、安全分享与讨论端点
 */

const express = require('express');
const router = express.Router();
const { ArtifactManager } = require('../../services/agent-runtime/artifact-manager');
const { authMiddleware: requireAuth } = require('../../auth');

const artifactManager = new ArtifactManager();
const { logger } = require('../../logger');
router.use((_req, res, next) => { res.setHeader('Cache-Control', 'private, no-store'); next(); });
function sendArtifactError(res, error, fallback) {
  const requested = Number(error.status || error.statusCode);
  const status = [400, 401, 403, 404, 409, 413, 429].includes(requested) ? requested : 500;
  if (status >= 500) logger.error({ code: error.code || 'ARTIFACT_REQUEST_FAILED' }, fallback);
  return res.status(status).json({ success: false, error: status < 500 ? error.message : fallback, ...(status < 500 && error.code ? { code: error.code } : {}) });
}

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

    const artifact = await artifactManager.create(req.user, {
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
    return sendArtifactError(res, error, '创建 Artifact 失败');
  }
});

/**
 * 获取用户的 Artifacts 列表
 * GET /api/artifacts
 */
router.get('/', requireAuth, async (req, res) => {
  try {
    const { type, status, runId, limit, offset } = req.query;

    const result = await artifactManager.list(req.user, {
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
    return sendArtifactError(res, error, '获取 Artifacts 列表失败');
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
    return sendArtifactError(res, error, '获取分享 Artifact 失败');
  }
});

/**
 * 获取 Artifact 详情
 * GET /api/artifacts/:id
 */
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const artifact = await artifactManager.get(id, req.user);

    // 记录查看事件
    await artifactManager.recordInteraction(id, req.user, {
      type: 'view',
      data: { timestamp: new Date() }
    }).catch(() => {});

    res.json({
      success: true,
      data: artifact
    });
  } catch (error) {
    return sendArtifactError(res, error, '获取 Artifact 失败');
  }
});

/**
 * 更新 Artifact
 * PUT /api/artifacts/:id
 */
router.put('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { title, description, content, metadata, expectedVersion } = req.body;

    const artifact = await artifactManager.update(id, req.user, {
      title,
      description,
      content,
      metadata,
      expectedVersion
    });

    res.json({
      success: true,
      data: artifact
    });
  } catch (error) {
    return sendArtifactError(res, error, '更新 Artifact 失败');
  }
});

/**
 * 删除 Artifact
 * DELETE /api/artifacts/:id
 */
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    await artifactManager.delete(id, req.user);

    res.json({
      success: true,
      message: 'Artifact 已删除'
    });
  } catch (error) {
    return sendArtifactError(res, error, '删除 Artifact 失败');
  }
});

/**
 * 获取 Artifact 版本历史
 * GET /api/artifacts/:id/versions
 */
router.get('/:id/versions', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const versions = await artifactManager.getVersions(id, req.user);

    res.json({
      success: true,
      data: versions
    });
  } catch (error) {
    return sendArtifactError(res, error, '获取版本历史失败');
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

    const artifact = await artifactManager.restoreVersion(id, req.user, version, req.body.expectedVersion);

    res.json({
      success: true,
      data: artifact
    });
  } catch (error) {
    return sendArtifactError(res, error, '恢复版本失败');
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

    const share = await artifactManager.share(id, req.user, {
      visibility,
      expiresIn
    });

    res.json({
      success: true,
      data: share
    });
  } catch (error) {
    return sendArtifactError(res, error, '分享 Artifact 失败');
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

    await artifactManager.recordInteraction(id, req.user, { type, data });

    res.json({
      success: true,
      message: '交互已记录'
    });
  } catch (error) {
    return sendArtifactError(res, error, '记录交互失败');
  }
});

/**
 * 获取交互统计
 * GET /api/artifacts/:id/stats
 */
router.get('/:id/stats', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const stats = await artifactManager.getInteractionStats(id, req.user);

    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    return sendArtifactError(res, error, '获取交互统计失败');
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

    if (typeof content !== 'string' || !content.trim() || content.length > 16000) {
      return res.status(400).json({
        success: false,
        error: '评论内容不能为空'
      });
    }

    const comment = await artifactManager.addComment(id, req.user, {
      content: content.trim(),
      parentId: parentId || null
    });

    res.status(201).json({
      success: true,
      data: comment
    });
  } catch (error) {
    return sendArtifactError(res, error, '添加评论失败');
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

    const result = await artifactManager.getComments(id, req.user, {
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
    return sendArtifactError(res, error, '获取评论列表失败');
  }
});

/**
 * 删除评论
 * DELETE /api/artifacts/:id/comments/:commentId
 */
router.delete('/:id/comments/:commentId', requireAuth, async (req, res) => {
  try {
    const { commentId } = req.params;
    await artifactManager.deleteComment(commentId, req.user, req.params.id);

    res.json({
      success: true,
      message: '评论已删除'
    });
  } catch (error) {
    return sendArtifactError(res, error, '删除评论失败');
  }
});

module.exports = router;
