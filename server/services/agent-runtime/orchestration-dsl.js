/**
 * 多智能体编排语言（DSL）
 * 提供声明式的多智能体协作定义
 */

/**
 * DSL 解析器
 */
class OrchestrationDSLParser {
  /**
   * 解析 DSL 定义
   */
  parse(dslCode) {
    try {
      // 移除注释
      const cleanCode = this.removeComments(dslCode);

      // 解析为 AST
      const ast = this.parseToAST(cleanCode);

      // 验证 AST
      this.validateAST(ast);

      return ast;
    } catch (error) {
      throw new Error(`DSL 解析失败: ${error.message}`);
    }
  }

  /**
   * 移除注释
   */
  removeComments(code) {
    // 移除单行注释
    code = code.replace(/\/\/.*$/gm, '');
    // 移除多行注释
    code = code.replace(/\/\*[\s\S]*?\*\//g, '');
    return code;
  }

  /**
   * 解析为 AST
   */
  parseToAST(code) {
    const lines = code.split('\n').filter(line => line.trim());
    const ast = {
      type: 'Orchestration',
      name: '',
      description: '',
      agents: [],
      workflows: [],
      triggers: []
    };

    let currentSection = null;
    let currentBlock = null;

    for (const line of lines) {
      const trimmed = line.trim();

      // 跳过空行
      if (!trimmed) continue;

      // 解析 orchestration 定义
      if (trimmed.startsWith('orchestration')) {
        const match = trimmed.match(/orchestration\s+"([^"]+)"/);
        if (match) {
          ast.name = match[1];
        }
        continue;
      }

      // 解析 description
      if (trimmed.startsWith('description')) {
        const match = trimmed.match(/description\s+"([^"]+)"/);
        if (match) {
          ast.description = match[1];
        }
        continue;
      }

      // 解析 agent 块
      if (trimmed.startsWith('agent')) {
        const match = trimmed.match(/agent\s+"([^"]+)"\s*{/);
        if (match) {
          currentSection = 'agent';
          currentBlock = {
            type: 'Agent',
            name: match[1],
            role: '',
            capabilities: [],
            model: '',
            config: {}
          };
        }
        continue;
      }

      // 解析 workflow 块
      if (trimmed.startsWith('workflow')) {
        const match = trimmed.match(/workflow\s+"([^"]+)"\s*{/);
        if (match) {
          currentSection = 'workflow';
          currentBlock = {
            type: 'Workflow',
            name: match[1],
            steps: [],
            onError: null,
            onComplete: null
          };
        }
        continue;
      }

      // 解析 trigger 块
      if (trimmed.startsWith('trigger')) {
        const match = trimmed.match(/trigger\s+"([^"]+)"\s*{/);
        if (match) {
          currentSection = 'trigger';
          currentBlock = {
            type: 'Trigger',
            name: match[1],
            event: '',
            condition: '',
            action: ''
          };
        }
        continue;
      }

      // 解析块结束
      if (trimmed === '}') {
        if (currentBlock) {
          if (currentSection === 'agent') {
            ast.agents.push(currentBlock);
          } else if (currentSection === 'workflow') {
            ast.workflows.push(currentBlock);
          } else if (currentSection === 'trigger') {
            ast.triggers.push(currentBlock);
          }
          currentBlock = null;
          currentSection = null;
        }
        continue;
      }

      // 解析块内容
      if (currentBlock) {
        this.parseBlockContent(currentBlock, trimmed);
      }
    }

    return ast;
  }

  /**
   * 解析块内容
   */
  parseBlockContent(block, line) {
    // 解析 role
    if (line.startsWith('role')) {
      const match = line.match(/role\s*=\s*"([^"]+)"/);
      if (match) {
        block.role = match[1];
      }
      return;
    }

    // 解析 capabilities
    if (line.startsWith('capabilities')) {
      const match = line.match(/capabilities\s*=\s*\[(.*)\]/);
      if (match) {
        block.capabilities = match[1]
          .split(',')
          .map(c => c.trim().replace(/"/g, ''));
      }
      return;
    }

    // 解析 model
    if (line.startsWith('model')) {
      const match = line.match(/model\s*=\s*"([^"]+)"/);
      if (match) {
        block.model = match[1];
      }
      return;
    }

    // 解析 step
    if (line.startsWith('step')) {
      const match = line.match(/step\s+"([^"]+)"\s*{/);
      if (match) {
        block.currentStep = {
          name: match[1],
          agent: '',
          input: '',
          dependsOn: [],
          parallel: false
        };
      }
      return;
    }

    // 解析 agent（在 step 中）
    if (line.startsWith('agent') && block.currentStep) {
      const match = line.match(/agent\s*=\s*"([^"]+)"/);
      if (match) {
        block.currentStep.agent = match[1];
      }
      return;
    }

    // 解析 input
    if (line.startsWith('input')) {
      const match = line.match(/input\s*=\s*"([^"]+)"/);
      if (match && block.currentStep) {
        block.currentStep.input = match[1];
      }
      return;
    }

    // 解析 dependsOn
    if (line.startsWith('dependsOn')) {
      const match = line.match(/dependsOn\s*=\s*\[(.*)\]/);
      if (match && block.currentStep) {
        block.currentStep.dependsOn = match[1]
          .split(',')
          .map(d => d.trim().replace(/"/g, ''));
      }
      return;
    }

    // 解析 parallel
    if (line.startsWith('parallel')) {
      const match = line.match(/parallel\s*=\s*(true|false)/);
      if (match && block.currentStep) {
        block.currentStep.parallel = match[1] === 'true';
      }
      return;
    }

    // 解析 event
    if (line.startsWith('event')) {
      const match = line.match(/event\s*=\s*"([^"]+)"/);
      if (match) {
        block.event = match[1];
      }
      return;
    }

    // 解析 condition
    if (line.startsWith('condition')) {
      const match = line.match(/condition\s*=\s*"([^"]+)"/);
      if (match) {
        block.condition = match[1];
      }
      return;
    }

    // 解析 action
    if (line.startsWith('action')) {
      const match = line.match(/action\s*=\s*"([^"]+)"/);
      if (match) {
        block.action = match[1];
      }
      return;
    }

    // Step 块结束
    if (line === '}' && block.currentStep) {
      block.steps.push(block.currentStep);
      delete block.currentStep;
    }
  }

  /**
   * 验证 AST
   */
  validateAST(ast) {
    if (!ast.name) {
      throw new Error('缺少 orchestration 名称');
    }

    // 验证 agents
    for (const agent of ast.agents) {
      if (!agent.name) {
        throw new Error('Agent 缺少名称');
      }
      if (!agent.role) {
        throw new Error(`Agent "${agent.name}" 缺少 role 定义`);
      }
    }

    // 验证 workflows
    for (const workflow of ast.workflows) {
      if (!workflow.name) {
        throw new Error('Workflow 缺少名称');
      }
      if (workflow.steps.length === 0) {
        throw new Error(`Workflow "${workflow.name}" 没有定义任何步骤`);
      }

      // 验证步骤引用的 agent 存在
      for (const step of workflow.steps) {
        if (step.agent) {
          const agentExists = ast.agents.some(a => a.name === step.agent);
          if (!agentExists) {
            throw new Error(
              `Workflow "${workflow.name}" 中的步骤 "${step.name}" 引用了不存在的 Agent "${step.agent}"`
            );
          }
        }
      }
    }

    return true;
  }
}

/**
 * DSL 执行器
 */
class OrchestrationExecutor {
  constructor(runtime) {
    this.runtime = runtime;
    this.parser = new OrchestrationDSLParser();
  }

  /**
   * 执行 DSL 定义的编排
   */
  async execute(dslCode, context = {}) {
    // 解析 DSL
    const ast = this.parser.parse(dslCode);

    // 初始化 agents
    const agents = await this.initializeAgents(ast.agents);

    // 执行 workflows
    const results = [];
    for (const workflow of ast.workflows) {
      const result = await this.executeWorkflow(workflow, agents, context);
      results.push(result);
    }

    return {
      orchestration: ast.name,
      results
    };
  }

  /**
   * 初始化 agents
   */
  async initializeAgents(agentDefs) {
    const agents = new Map();

    for (const def of agentDefs) {
      const agent = await this.createAgent(def);
      agents.set(def.name, agent);
    }

    return agents;
  }

  /**
   * 创建 agent
   */
  async createAgent(def) {
    return {
      name: def.name,
      role: def.role,
      capabilities: def.capabilities,
      model: def.model || 'gpt-4',
      config: def.config,

      async execute(task, context) {
        // 实际执行逻辑应该调用真实的 agent 运行时
        console.log(`Agent ${this.name} 执行任务:`, task);

        // 模拟执行
        return {
          success: true,
          output: `Agent ${this.name} 完成任务: ${task}`,
          context
        };
      }
    };
  }

  /**
   * 执行 workflow
   */
  async executeWorkflow(workflow, agents, context) {
    console.log(`开始执行 Workflow: ${workflow.name}`);

    const stepResults = new Map();
    const executionContext = { ...context };

    // 构建依赖图
    const graph = this.buildDependencyGraph(workflow.steps);

    // 拓扑排序
    const executionOrder = this.topologicalSort(graph);

    // 按顺序执行步骤
    for (const stepName of executionOrder) {
      const step = workflow.steps.find(s => s.name === stepName);

      if (!step) continue;

      // 检查依赖是否完成
      const dependenciesMet = step.dependsOn.every(dep =>
        stepResults.has(dep) && stepResults.get(dep).success
      );

      if (!dependenciesMet) {
        throw new Error(`步骤 "${step.name}" 的依赖未满足`);
      }

      // 收集依赖结果
      const dependencyResults = {};
      for (const dep of step.dependsOn) {
        dependencyResults[dep] = stepResults.get(dep);
      }

      // 执行步骤
      const agent = agents.get(step.agent);
      if (!agent) {
        throw new Error(`步骤 "${step.name}" 引用的 Agent "${step.agent}" 不存在`);
      }

      const result = await agent.execute(step.input, {
        ...executionContext,
        dependencies: dependencyResults
      });

      stepResults.set(step.name, result);

      // 更新上下文
      if (result.context) {
        Object.assign(executionContext, result.context);
      }
    }

    return {
      workflow: workflow.name,
      steps: Array.from(stepResults.entries()).map(([name, result]) => ({
        step: name,
        ...result
      })),
      context: executionContext
    };
  }

  /**
   * 构建依赖图
   */
  buildDependencyGraph(steps) {
    const graph = new Map();

    for (const step of steps) {
      graph.set(step.name, step.dependsOn || []);
    }

    return graph;
  }

  /**
   * 拓扑排序
   */
  topologicalSort(graph) {
    const result = [];
    const visited = new Set();
    const visiting = new Set();

    const visitNode = (node) => {
      if (visited.has(node)) return;
      if (visiting.has(node)) {
        throw new Error('检测到循环依赖');
      }

      visiting.add(node);

      const dependencies = graph.get(node) || [];
      for (const dep of dependencies) {
        visitNode(dep);
      }

      visiting.delete(node);
      visited.add(node);
      result.push(node);
    };

    for (const node of graph.keys()) {
      visitNode(node);
    }

    return result;
  }
}

/**
 * DSL 示例
 */
const exampleDSL = `
// 定义多智能体编排
orchestration "代码审查流程"

description "自动化代码审查流程，包括静态分析、安全扫描和人工审查"

// 定义 Agent
agent "静态分析师" {
  role = "代码静态分析"
  capabilities = ["code_analysis", "linting", "complexity_check"]
  model = "gpt-4"
}

agent "安全专家" {
  role = "安全漏洞扫描"
  capabilities = ["security_scan", "vulnerability_detection"]
  model = "gpt-4"
}

agent "代码审查员" {
  role = "代码质量评审"
  capabilities = ["code_review", "best_practices_check"]
  model = "gpt-4"
}

agent "报告生成器" {
  role = "生成审查报告"
  capabilities = ["report_generation", "summary"]
  model = "gpt-3.5-turbo"
}

// 定义 Workflow
workflow "代码审查" {
  step "静态分析" {
    agent = "静态分析师"
    input = "分析提交的代码变更"
    dependsOn = []
  }

  step "安全扫描" {
    agent = "安全专家"
    input = "扫描安全漏洞"
    dependsOn = []
    parallel = true
  }

  step "代码审查" {
    agent = "代码审查员"
    input = "基于静态分析和安全扫描结果进行审查"
    dependsOn = ["静态分析", "安全扫描"]
  }

  step "生成报告" {
    agent = "报告生成器"
    input = "汇总所有审查结果"
    dependsOn = ["代码审查"]
  }
}

// 定义触发器
trigger "PR创建触发" {
  event = "pull_request.created"
  condition = "pr.target_branch == 'main'"
  action = "执行代码审查"
}
`;

module.exports = {
  OrchestrationDSLParser,
  OrchestrationExecutor,
  exampleDSL
};
