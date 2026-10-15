/**
 * Agent 相关路由的主入口
 */

const express = require('express');
const router = express.Router();

// 子路由
const workflowTemplatesRouter = require('./workflowTemplates');
const workflowInstancesRouter = require('./workflowInstances');
const streamingRouter = require('./streaming');

// 挂载子路由
router.use('/workflow-templates', workflowTemplatesRouter);
router.use('/workflow-instances', workflowInstancesRouter);
router.use('/', streamingRouter); // 流式交互路由

module.exports = router;
