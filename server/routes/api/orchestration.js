/**
 * 编排语言 API 路由
 */

const express = require('express');
const router = express.Router();
const {
  OrchestrationDSLParser,
  OrchestrationExecutor,
  exampleDSL
} = require('../../services/agent-runtime/orchestration-dsl');
const { authMiddleware: requireAuth } = require('../../auth');

let parser = null;
let executor = null;

/**
 * 获取解析器实例
 */
function getParser() {
  if (!parser) {
    parser = new OrchestrationDSLParser();
  }
  return parser;
}

/**
 * 获取执行器实例
 */
function getExecutor() {
  if (!executor) {
    executor = new OrchestrationExecutor(null); // 运行时应该注入
  }
  return executor;
}

/**
 * 解析 DSL
 * POST /api/orchestration/parse
 */
router.post('/parse', requireAuth, async (req, res) => {
  try {
    const { dsl } = req.body;

    if (!dsl) {
      return res.status(400).json({
        success: false,
        error: 'DSL 代码不能为空'
      });
    }

    const dslParser = getParser();
    const ast = dslParser.parse(dsl);

    res.json({
      success: true,
      data: ast
    });
  } catch (error) {
    console.error('解析 DSL 失败:', error);
    res.status(400).json({
      success: false,
      error: '解析 DSL 失败',
      message: error.message
    });
  }
});

/**
 * 验证 DSL
 * POST /api/orchestration/validate
 */
router.post('/validate', requireAuth, async (req, res) => {
  try {
    const { dsl } = req.body;

    if (!dsl) {
      return res.status(400).json({
        success: false,
        error: 'DSL 代码不能为空'
      });
    }

    const dslParser = getParser();
    const ast = dslParser.parse(dsl);

    res.json({
      success: true,
      valid: true,
      message: 'DSL 验证通过',
      summary: {
        name: ast.name,
        description: ast.description,
        agentCount: ast.agents.length,
        workflowCount: ast.workflows.length,
        triggerCount: ast.triggers.length
      }
    });
  } catch (error) {
    console.error('验证 DSL 失败:', error);
    res.status(200).json({
      success: true,
      valid: false,
      message: error.message
    });
  }
});

/**
 * 执行 DSL 编排
 * POST /api/orchestration/execute
 */
router.post('/execute', requireAuth, async (req, res) => {
  try {
    const { dsl, context = {} } = req.body;

    if (!dsl) {
      return res.status(400).json({
        success: false,
        error: 'DSL 代码不能为空'
      });
    }

    const dslExecutor = getExecutor();
    const result = await dslExecutor.execute(dsl, {
      ...context,
      userId: req.user.id
    });

    // 保存执行记录
    const [execution] = await req.db('agent_orchestration_executions')
      .insert({
        user_id: req.user.id,
        orchestration_name: result.orchestration,
        dsl_code: dsl,
        context: JSON.stringify(context),
        result: JSON.stringify(result),
        status: 'completed',
        created_at: new Date(),
        completed_at: new Date()
      })
      .returning('*');

    res.json({
      success: true,
      data: {
        executionId: execution.id,
        ...result
      }
    });
  } catch (error) {
    console.error('执行 DSL 失败:', error);

    // 保存失败记录
    await req.db('agent_orchestration_executions')
      .insert({
        user_id: req.user.id,
        orchestration_name: 'unknown',
        dsl_code: req.body.dsl,
        context: JSON.stringify(req.body.context || {}),
        error: error.message,
        status: 'failed',
        created_at: new Date(),
        completed_at: new Date()
      });

    res.status(500).json({
      success: false,
      error: '执行 DSL 失败',
      message: error.message
    });
  }
});

/**
 * 保存 DSL 模板
 * POST /api/orchestration/templates
 */
router.post('/templates', requireAuth, async (req, res) => {
  try {
    const { name, description, dsl, tags = [] } = req.body;

    if (!name || !dsl) {
      return res.status(400).json({
        success: false,
        error: '名称和 DSL 代码不能为空'
      });
    }

    // 验证 DSL
    const dslParser = getParser();
    const ast = dslParser.parse(dsl);

    const [template] = await req.db('agent_orchestration_templates')
      .insert({
        user_id: req.user.id,
        name,
        description,
        dsl_code: dsl,
        tags: JSON.stringify(tags),
        metadata: JSON.stringify({
          agentCount: ast.agents.length,
          workflowCount: ast.workflows.length,
          triggerCount: ast.triggers.length
        }),
        created_at: new Date(),
        updated_at: new Date()
      })
      .returning('*');

    res.status(201).json({
      success: true,
      data: {
        ...template,
        tags: JSON.parse(template.tags),
        metadata: JSON.parse(template.metadata)
      }
    });
  } catch (error) {
    console.error('保存模板失败:', error);
    res.status(500).json({
      success: false,
      error: '保存模板失败',
      message: error.message
    });
  }
});

/**
 * 获取 DSL 模板列表
 * GET /api/orchestration/templates
 */
router.get('/templates', requireAuth, async (req, res) => {
  try {
    const { tag, limit = 20, offset = 0 } = req.query;
    const userId = req.user.id;

    let query = req.db('agent_orchestration_templates')
      .where(function() {
        this.where({ user_id: userId })
            .orWhere({ is_public: true });
      })
      .orderBy('created_at', 'desc')
      .limit(parseInt(limit))
      .offset(parseInt(offset));

    const templates = await query;

    // 解析 JSON 字段
    const parsedTemplates = templates.map(t => ({
      ...t,
      tags: JSON.parse(t.tags || '[]'),
      metadata: JSON.parse(t.metadata || '{}')
    }));

    // 如果指定了标签，过滤模板
    let filtered = parsedTemplates;
    if (tag) {
      filtered = parsedTemplates.filter(t =>
        t.tags.includes(tag)
      );
    }

    const countQuery = req.db('agent_orchestration_templates')
      .where(function() {
        this.where({ user_id: userId })
            .orWhere({ is_public: true });
      })
      .count('* as count');

    const [{ count }] = await countQuery;

    res.json({
      success: true,
      data: filtered,
      pagination: {
        total: parseInt(count),
        limit: parseInt(limit),
        offset: parseInt(offset)
      }
    });
  } catch (error) {
    console.error('获取模板列表失败:', error);
    res.status(500).json({
      success: false,
      error: '获取模板列表失败',
      message: error.message
    });
  }
});

/**
 * 获取模板详情
 * GET /api/orchestration/templates/:id
 */
router.get('/templates/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const template = await req.db('agent_orchestration_templates')
      .where({ id })
      .first();

    if (!template) {
      return res.status(404).json({
        success: false,
        error: '模板不存在'
      });
    }

    // 检查权限
    if (!template.is_public && template.user_id !== req.user.id) {
      return res.status(403).json({
        success: false,
        error: '无权访问此模板'
      });
    }

    res.json({
      success: true,
      data: {
        ...template,
        tags: JSON.parse(template.tags || '[]'),
        metadata: JSON.parse(template.metadata || '{}')
      }
    });
  } catch (error) {
    console.error('获取模板详情失败:', error);
    res.status(500).json({
      success: false,
      error: '获取模板详情失败',
      message: error.message
    });
  }
});

/**
 * 更新模板
 * PUT /api/orchestration/templates/:id
 */
router.put('/templates/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, dsl, tags } = req.body;

    const template = await req.db('agent_orchestration_templates')
      .where({ id, user_id: req.user.id })
      .first();

    if (!template) {
      return res.status(404).json({
        success: false,
        error: '模板不存在或无权修改'
      });
    }

    // 如果更新了 DSL，验证它
    if (dsl) {
      const dslParser = getParser();
      const ast = dslParser.parse(dsl);

      // 更新元数据
      template.metadata = JSON.stringify({
        agentCount: ast.agents.length,
        workflowCount: ast.workflows.length,
        triggerCount: ast.triggers.length
      });
    }

    const updates = {
      updated_at: new Date()
    };

    if (name !== undefined) updates.name = name;
    if (description !== undefined) updates.description = description;
    if (dsl !== undefined) {
      updates.dsl_code = dsl;
      updates.metadata = template.metadata;
    }
    if (tags !== undefined) updates.tags = JSON.stringify(tags);

    const [updated] = await req.db('agent_orchestration_templates')
      .where({ id })
      .update(updates)
      .returning('*');

    res.json({
      success: true,
      data: {
        ...updated,
        tags: JSON.parse(updated.tags || '[]'),
        metadata: JSON.parse(updated.metadata || '{}')
      }
    });
  } catch (error) {
    console.error('更新模板失败:', error);
    res.status(500).json({
      success: false,
      error: '更新模板失败',
      message: error.message
    });
  }
});

/**
 * 删除模板
 * DELETE /api/orchestration/templates/:id
 */
router.delete('/templates/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const template = await req.db('agent_orchestration_templates')
      .where({ id, user_id: req.user.id })
      .first();

    if (!template) {
      return res.status(404).json({
        success: false,
        error: '模板不存在或无权删除'
      });
    }

    await req.db('agent_orchestration_templates')
      .where({ id })
      .delete();

    res.json({
      success: true,
      message: '模板已删除'
    });
  } catch (error) {
    console.error('删除模板失败:', error);
    res.status(500).json({
      success: false,
      error: '删除模板失败',
      message: error.message
    });
  }
});

/**
 * 获取执行历史
 * GET /api/orchestration/executions
 */
router.get('/executions', requireAuth, async (req, res) => {
  try {
    const { status, limit = 20, offset = 0 } = req.query;
    const userId = req.user.id;

    let query = req.db('agent_orchestration_executions')
      .where({ user_id: userId })
      .orderBy('created_at', 'desc')
      .limit(parseInt(limit))
      .offset(parseInt(offset));

    if (status) {
      query = query.where({ status });
    }

    const executions = await query;

    // 解析 JSON 字段
    const parsedExecutions = executions.map(e => ({
      ...e,
      context: JSON.parse(e.context || '{}'),
      result: e.result ? JSON.parse(e.result) : null
    }));

    const countQuery = req.db('agent_orchestration_executions')
      .where({ user_id: userId })
      .count('* as count');

    if (status) countQuery.where({ status });

    const [{ count }] = await countQuery;

    res.json({
      success: true,
      data: parsedExecutions,
      pagination: {
        total: parseInt(count),
        limit: parseInt(limit),
        offset: parseInt(offset)
      }
    });
  } catch (error) {
    console.error('获取执行历史失败:', error);
    res.status(500).json({
      success: false,
      error: '获取执行历史失败',
      message: error.message
    });
  }
});

/**
 * 获取示例 DSL
 * GET /api/orchestration/example
 */
router.get('/example', (req, res) => {
  res.json({
    success: true,
    data: {
      dsl: exampleDSL,
      description: '代码审查流程示例'
    }
  });
});

module.exports = router;
