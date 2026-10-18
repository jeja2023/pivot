/**
 * 工具发现与推荐引擎
 * 基于上下文智能推荐最合适的工具
 */

const { logger } = require('../../logger');
const natural = require('natural');
const TfIdf = natural.TfIdf;

/**
 * 工具推荐引擎
 */
class ToolRecommendationEngine {
  constructor(db) {
    this.db = db;
    this.tfidf = new TfIdf();
    this.toolIndex = new Map();
    this.categoryIndex = new Map();
    this.usageStats = new Map();
    this.initialized = false;
  }

  /**
   * 初始化工具索引
   */
  async initialize() {
    if (this.initialized) return;

    logger.debug('正在初始化工具推荐引擎...');

    // 加载所有可用工具
    const tools = await this.loadAllTools();

    // 构建 TF-IDF 索引
    for (const tool of tools) {
      const document = this.buildToolDocument(tool);
      this.tfidf.addDocument(document);
      this.toolIndex.set(tool.id, tool);

      // 构建分类索引
      const category = tool.category || 'uncategorized';
      if (!this.categoryIndex.has(category)) {
        this.categoryIndex.set(category, []);
      }
      this.categoryIndex.get(category).push(tool);
    }

    // 加载使用统计
    await this.loadUsageStats();

    this.initialized = true;
    logger.debug({ count: tools.length }, '工具推荐引擎初始化完成');
  }

  /**
   * 加载所有可用工具
   */
  async loadAllTools() {
    const tools = [];

    // 从工具库加载
    const libraryTools = await this.db('tools')
      .where({ enabled: true })
      .select('*');

    for (const tool of libraryTools) {
      tools.push({
        id: tool.id,
        name: tool.name,
        description: tool.description,
        category: tool.category,
        tags: tool.tags || [],
        parameters: tool.parameters,
        examples: tool.examples || [],
        usage_count: 0,
        success_rate: 1.0,
        source: 'library'
      });
    }

    // 加载内置工具
    const builtinTools = this.getBuiltinTools();
    tools.push(...builtinTools);

    return tools;
  }

  /**
   * 获取内置工具列表
   */
  getBuiltinTools() {
    return [
      {
        id: 'read_file',
        name: '读取文件',
        description: '读取文件内容，支持文本文件和常见格式',
        category: 'file_operations',
        tags: ['文件', '读取', 'IO'],
        parameters: {
          path: { type: 'string', required: true, description: '文件路径' },
          encoding: { type: 'string', required: false, description: '编码格式' }
        },
        examples: ['读取 config.json', '查看 README.md 内容'],
        usage_count: 0,
        success_rate: 1.0,
        source: 'builtin'
      },
      {
        id: 'write_file',
        name: '写入文件',
        description: '创建或修改文件内容',
        category: 'file_operations',
        tags: ['文件', '写入', '创建', '修改'],
        parameters: {
          path: { type: 'string', required: true, description: '文件路径' },
          content: { type: 'string', required: true, description: '文件内容' }
        },
        examples: ['创建新文件 hello.txt', '修改配置文件'],
        usage_count: 0,
        success_rate: 1.0,
        source: 'builtin'
      },
      {
        id: 'search_files',
        name: '搜索文件',
        description: '在项目中搜索文件或文件内容',
        category: 'search',
        tags: ['搜索', '查找', '文件'],
        parameters: {
          pattern: { type: 'string', required: true, description: '搜索模式' },
          path: { type: 'string', required: false, description: '搜索路径' }
        },
        examples: ['找到所有 .js 文件', '搜索包含 TODO 的文件'],
        usage_count: 0,
        success_rate: 1.0,
        source: 'builtin'
      },
      {
        id: 'execute_command',
        name: '执行命令',
        description: '在终端执行 shell 命令',
        category: 'system',
        tags: ['命令', '终端', 'shell', '执行'],
        parameters: {
          command: { type: 'string', required: true, description: '要执行的命令' },
          cwd: { type: 'string', required: false, description: '工作目录' }
        },
        examples: ['运行 npm install', '执行 git status'],
        usage_count: 0,
        success_rate: 1.0,
        source: 'builtin'
      },

      {
        id: 'analyze_code',
        name: '代码分析',
        description: '分析代码质量、复杂度和潜在问题',
        category: 'code_analysis',
        tags: ['代码', '分析', '质量'],
        parameters: {
          path: { type: 'string', required: true, description: '代码路径' }
        },
        examples: ['分析 src 目录的代码质量', '检查代码复杂度'],
        usage_count: 0,
        success_rate: 1.0,
        source: 'builtin'
      }
    ];
  }

  /**
   * 构建工具文档（用于 TF-IDF）
   */
  buildToolDocument(tool) {
    const parts = [
      tool.name,
      tool.description,
      ...(tool.tags || []),
      ...(tool.examples || [])
    ];
    return parts.join(' ');
  }

  /**
   * 加载使用统计
   */
  async loadUsageStats() {
    const stats = await this.db('tool_usage_stats')
      .select('tool_id', 'usage_count', 'success_count', 'failure_count')
      .where('created_at', '>', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));

    for (const stat of stats) {
      const totalCalls = stat.usage_count;
      const successRate = totalCalls > 0
        ? stat.success_count / totalCalls
        : 1.0;

      this.usageStats.set(stat.tool_id, {
        usageCount: stat.usage_count,
        successRate
      });

      // 更新工具索引中的统计信息
      const tool = this.toolIndex.get(stat.tool_id);
      if (tool) {
        tool.usage_count = stat.usage_count;
        tool.success_rate = successRate;
      }
    }
  }

  /**
   * 推荐工具
   * @param {Object} context - 上下文信息
   * @param {string} context.task - 任务描述
   * @param {string} context.intent - 用户意图
   * @param {Array} context.entities - 提取的实体
   * @param {number} limit - 返回的推荐数量
   * @returns {Array} 推荐的工具列表
   */
  async recommend(context, limit = 5) {
    if (!this.initialized) {
      await this.initialize();
    }

    const { task, intent, entities = [] } = context;

    // 1. 基于任务描述的语义相似度匹配
    const semanticMatches = this.findSemanticMatches(task, limit * 2);

    // 2. 基于意图的规则匹配
    const intentMatches = this.findIntentMatches(intent);

    // 3. 基于实体的匹配
    const entityMatches = this.findEntityMatches(entities);

    // 4. 合并和评分
    const scoreMap = new Map();

    for (const match of semanticMatches) {
      scoreMap.set(match.tool.id, {
        tool: match.tool,
        score: match.score * 0.4, // 语义相似度权重 40%
        reasons: ['语义匹配']
      });
    }

    for (const match of intentMatches) {
      const existing = scoreMap.get(match.tool.id);
      if (existing) {
        existing.score += match.score * 0.3; // 意图匹配权重 30%
        existing.reasons.push('意图匹配');
      } else {
        scoreMap.set(match.tool.id, {
          tool: match.tool,
          score: match.score * 0.3,
          reasons: ['意图匹配']
        });
      }
    }

    for (const match of entityMatches) {
      const existing = scoreMap.get(match.tool.id);
      if (existing) {
        existing.score += match.score * 0.2; // 实体匹配权重 20%
        existing.reasons.push('实体匹配');
      } else {
        scoreMap.set(match.tool.id, {
          tool: match.tool,
          score: match.score * 0.2,
          reasons: ['实体匹配']
        });
      }
    }

    // 5. 考虑使用统计（热门度和成功率）
    for (const [toolId, recommendation] of scoreMap) {
      const stats = this.usageStats.get(toolId);
      if (stats) {
        // 热门度加成（最高 10%）
        const popularityBonus = Math.min(0.1, stats.usageCount / 1000 * 0.1);
        // 成功率加成（最高 10%）
        const successBonus = stats.successRate * 0.1;
        recommendation.score += popularityBonus + successBonus;
      }
    }

    // 6. 排序并返回前 N 个
    const sortedRecommendations = Array.from(scoreMap.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return sortedRecommendations.map(rec => ({
      tool: {
        id: rec.tool.id,
        name: rec.tool.name,
        description: rec.tool.description,
        category: rec.tool.category,
        parameters: rec.tool.parameters,
        examples: rec.tool.examples
      },
      score: rec.score,
      confidence: this.calculateConfidence(rec.score),
      reasons: rec.reasons,
      usageStats: {
        usageCount: rec.tool.usage_count,
        successRate: rec.tool.success_rate
      }
    }));
  }

  /**
   * 基于语义相似度查找工具
   */
  findSemanticMatches(query, limit) {
    const matches = [];

    this.tfidf.tfidfs(query, (i, score) => {
      const tools = Array.from(this.toolIndex.values());
      if (i < tools.length && score > 0) {
        matches.push({
          tool: tools[i],
          score: score
        });
      }
    });

    // 归一化分数
    const maxScore = Math.max(...matches.map(m => m.score), 1);
    return matches
      .map(m => ({ ...m, score: m.score / maxScore }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /**
   * 基于意图查找工具
   */
  findIntentMatches(intent) {
    const intentMap = {
      'read': ['read_file', 'search_files'],
      'write': ['write_file'],
      'search': ['search_files'],
      'execute': ['execute_command'],
      'analyze': ['analyze_code'],
      'create': ['write_file'],
      'modify': ['write_file'],
      'find': ['search_files']
    };

    const matches = [];
    const toolIds = intentMap[intent] || [];

    for (const toolId of toolIds) {
      const tool = this.toolIndex.get(toolId);
      if (tool) {
        matches.push({
          tool,
          score: 1.0
        });
      }
    }

    return matches;
  }

  /**
   * 基于实体查找工具
   */
  findEntityMatches(entities) {
    const matches = [];
    const entityTypes = new Set(entities.map(e => e.type));

    for (const tool of this.toolIndex.values()) {
      let matchScore = 0;

      // 检查工具标签是否与实体类型匹配
      if (tool.tags) {
        for (const tag of tool.tags) {
          if (entityTypes.has(tag) ||
              entities.some(e => e.value.includes(tag))) {
            matchScore += 0.3;
          }
        }
      }

      // 检查工具参数是否与实体匹配
      if (tool.parameters) {
        for (const entity of entities) {
          if (tool.parameters[entity.type] ||
              Object.values(tool.parameters).some(p =>
                p.description && p.description.includes(entity.value))) {
            matchScore += 0.2;
          }
        }
      }

      if (matchScore > 0) {
        matches.push({
          tool,
          score: Math.min(matchScore, 1.0)
        });
      }
    }

    return matches.sort((a, b) => b.score - a.score);
  }

  /**
   * 计算置信度
   */
  calculateConfidence(score) {
    if (score >= 0.8) return 'high';
    if (score >= 0.5) return 'medium';
    return 'low';
  }

  /**
   * 记录工具使用
   */
  async recordUsage(toolId, success = true) {
    const now = new Date();
    const stats = this.usageStats.get(toolId) || {
      usageCount: 0,
      successRate: 1.0
    };

    stats.usageCount++;

    // 更新数据库
    const existing = await this.db('tool_usage_stats')
      .where({ tool_id: toolId })
      .where('created_at', '>', new Date(Date.now() - 24 * 60 * 60 * 1000))
      .first();

    if (existing) {
      await this.db('tool_usage_stats')
        .where({ id: existing.id })
        .update({
          usage_count: this.db.raw('usage_count + 1'),
          success_count: success ? this.db.raw('success_count + 1') : this.db.raw('success_count'),
          failure_count: success ? this.db.raw('failure_count') : this.db.raw('failure_count + 1'),
          updated_at: now
        });
    } else {
      await this.db('tool_usage_stats').insert({
        tool_id: toolId,
        usage_count: 1,
        success_count: success ? 1 : 0,
        failure_count: success ? 0 : 1,
        created_at: now,
        updated_at: now
      });
    }

    this.usageStats.set(toolId, stats);
  }
}

module.exports = {
  ToolRecommendationEngine
};
