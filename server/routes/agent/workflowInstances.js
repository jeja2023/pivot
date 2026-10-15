/**
 * 工作流实例路由
 */

const express = require('express');
const router = express.Router();
const workflowInstanceService = require('../../services/agent/workflowInstanceService');
const { authenticateToken } = require('../../middleware/auth');

/**
 * @route   GET /api/agent/workflow-instances
 * @desc    获取工作流实例列表
 * @access  Private
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const filters = {
      status: req.query.status,
      created_by: req.query.created_by || req.user.id,
      template_id: req.query.template_id,
    };

    const instances = await workflowInstanceService.listInstances(filters);

    res.json({
      success: true,
      data: instances,
    });
  } catch (error) {
    console.error('获取实例列表失败:', error);
    res.status(500).json({
      success: false,
      message: '获取实例列表失败',
      error: error.message,
    });
  }
});

/**
 * @route   GET /api/agent/workflow-instances/:id
 * @desc    获取工作流实例详情
 * @access  Private
 */
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const instance = await workflowInstanceService.getInstanceById(req.params.id);

    res.json({
      success: true,
      data: instance,
    });
  } catch (error) {
    console.error('获取实例详情失败:', error);
    res.status(404).json({
      success: false,
      message: error.message || '获取实例详情失败',
    });
  }
});

/**
 * @route   POST /api/agent/workflow-instances
 * @desc    创建工作流实例
 * @access  Private
 */
router.post('/', authenticateToken, async (req, res) => {
  try {
    const instanceData = {
      ...req.body,
      created_by: req.user.id,
    };

    const instance = await workflowInstanceService.createInstance(instanceData);

    res.status(201).json({
      success: true,
      data: instance,
    });
  } catch (error) {
    console.error('创建实例失败:', error);
    res.status(500).json({
      success: false,
      message: '创建实例失败',
      error: error.message,
    });
  }
});

/**
 * @route   PUT /api/agent/workflow-instances/:id/status
 * @desc    更新工作流实例状态
 * @access  Private
 */
router.put('/:id/status', authenticateToken, async (req, res) => {
  try {
    const { status, execution_result, error_message } = req.body;

    const data = {
      execution_result,
      error_message,
    };

    if (status === 'running') {
      data.started_at = new Date();
    } else if (status === 'completed' || status === 'failed') {
      data.completed_at = new Date();
    }

    const updated = await workflowInstanceService.updateInstanceStatus(
      req.params.id,
      status,
      data
    );

    res.json({
      success: true,
      data: updated,
    });
  } catch (error) {
    console.error('更新实例状态失败:', error);
    res.status(500).json({
      success: false,
      message: '更新实例状态失败',
      error: error.message,
    });
  }
});

/**
 * @route   DELETE /api/agent/workflow-instances/:id
 * @desc    删除工作流实例
 * @access  Private
 */
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const deleted = await workflowInstanceService.deleteInstance(req.params.id);

    if (!deleted) {
      return res.status(404).json({
        success: false,
        message: '实例不存在',
      });
    }

    res.json({
      success: true,
      message: '实例已删除',
    });
  } catch (error) {
    console.error('删除实例失败:', error);
    res.status(500).json({
      success: false,
      message: '删除实例失败',
      error: error.message,
    });
  }
});

module.exports = router;
