#!/usr/bin/env node

/**
 * Pivot v0.3.0 验证脚本
 * 验证工作流模板库系统的完整性
 */

const fs = require('fs');
const path = require('path');

// 颜色输出
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function success(message) {
  log(`✓ ${message}`, 'green');
}

function error(message) {
  log(`✗ ${message}`, 'red');
}

function warning(message) {
  log(`⚠ ${message}`, 'yellow');
}

function info(message) {
  log(`ℹ ${message}`, 'blue');
}

// 验证结果统计
const results = {
  passed: 0,
  failed: 0,
  warnings: 0,
};

// 验证文件存在
function checkFileExists(filePath, description) {
  const fullPath = path.join(__dirname, '..', filePath);
  if (fs.existsSync(fullPath)) {
    success(`${description}: ${filePath}`);
    results.passed++;
    return true;
  } else {
    error(`${description}缺失: ${filePath}`);
    results.failed++;
    return false;
  }
}

// 验证 JSON 文件
function checkJsonFile(filePath, description) {
  const fullPath = path.join(__dirname, '..', filePath);
  if (!fs.existsSync(fullPath)) {
    error(`${description}缺失: ${filePath}`);
    results.failed++;
    return false;
  }

  try {
    const content = fs.readFileSync(fullPath, 'utf8');
    JSON.parse(content);
    success(`${description}: ${filePath}`);
    results.passed++;
    return true;
  } catch (err) {
    error(`${description} JSON 格式错误: ${filePath} - ${err.message}`);
    results.failed++;
    return false;
  }
}

// 验证模板文件结构
function checkTemplateStructure(filePath) {
  const fullPath = path.join(__dirname, '..', filePath);
  try {
    const content = fs.readFileSync(fullPath, 'utf8');
    const template = JSON.parse(content);

    // 检查必需字段
    const requiredFields = [
      'slug',
      'name',
      'description',
      'category',
      'difficulty',
      'dag',
      'variables',
    ];

    const missingFields = requiredFields.filter(
      (field) => !(field in template)
    );

    if (missingFields.length > 0) {
      error(
        `模板 ${filePath} 缺少必需字段: ${missingFields.join(', ')}`
      );
      results.failed++;
      return false;
    }

    // 检查 DAG 结构
    if (!template.dag.nodes || !Array.isArray(template.dag.nodes)) {
      error(`模板 ${filePath} DAG 节点格式错误`);
      results.failed++;
      return false;
    }

    // 检查 variables 结构
    if (!Array.isArray(template.variables)) {
      error(`模板 ${filePath} 变量格式错误`);
      results.failed++;
      return false;
    }

    success(`模板结构验证通过: ${filePath}`);
    results.passed++;
    return true;
  } catch (err) {
    error(`模板验证失败: ${filePath} - ${err.message}`);
    results.failed++;
    return false;
  }
}

// 主验证流程
async function main() {
  console.log('\n=========================================');
  console.log('  Pivot v0.3.0 系统验证');
  console.log('=========================================\n');

  // 1. 数据库迁移文件
  info('1. 检查数据库迁移文件...');
  const migrationFiles = [
    ['server/db/migrations/agent-workflow-templates.js', '模板系统迁移'],
    ['server/db/migrations/agent-streaming-events.js', '实时流式事件迁移'],
    ['server/db/migrations/agent-evaluation.js', '评测系统迁移'],
    ['server/db/migrations/agent-tool-usage-stats.js', '工具统计迁移'],
    ['server/db/migrations/agent-enhanced-planning.js', '增强规划迁移'],
    ['server/db/migrations/agent-artifacts.js', '多模态产物迁移'],
    ['server/db/migrations/agent-orchestration-dsl.js', '编排语言迁移']
  ];
  migrationFiles.forEach(([file, desc]) => checkFileExists(file, desc));
  console.log('');

  // 2. 种子数据文件
  info('2. 检查种子数据文件...');
  checkFileExists(
    'server/db/seeds/003-workflow-templates.js',
    '种子数据脚本'
  );
  console.log('');

  // 3. 内置模板文件
  info('3. 检查内置模板文件...');
  const templates = [
    'server/db/seeds/workflow-templates/01-excel-data-analysis.json',
    'server/db/seeds/workflow-templates/02-batch-image-processing.json',
    'server/db/seeds/workflow-templates/03-api-endpoint-testing.json',
    'server/db/seeds/workflow-templates/04-code-quality-analysis.json',
    'server/db/seeds/workflow-templates/05-smart-documentation.json',
  ];

  templates.forEach((template) => {
    checkJsonFile(template, '模板文件');
  });
  console.log('');

  // 4. 验证模板结构
  info('4. 验证模板结构...');
  templates.forEach((template) => {
    checkTemplateStructure(template);
  });
  console.log('');

  // 5. 后端服务文件
  info('5. 检查后端服务文件...');
  const services = [
    'server/services/agent/workflowTemplateService.js',
    'server/services/agent/workflowTemplateCategoryService.js',
    'server/services/agent/workflowTemplateRatingService.js',
    'server/services/agent/workflowInstanceService.js',
  ];

  services.forEach((service) => {
    checkFileExists(service, '服务文件');
  });
  console.log('');

  // 6. API 路由文件
  info('6. 检查 API 路由文件...');
  const routes = [
    'server/routes/agent/index.js',
    'server/routes/agent/workflowTemplates.js',
    'server/routes/agent/workflowInstances.js',
  ];

  routes.forEach((route) => {
    checkFileExists(route, '路由文件');
  });
  console.log('');

  // 7. 前端页面文件
  info('7. 检查前端页面文件...');
  const pages = [
    'client/agent/templates.html',
    'client/agent/template-detail.html',
  ];

  pages.forEach((page) => {
    checkFileExists(page, '前端页面');
  });
  console.log('');

  // 8. 前端组件文件
  info('8. 检查前端组件文件...');
  const components = [
    'client/src/pages/agent/TemplateMarketplace.tsx',
    'client/src/pages/agent/TemplateDetail.tsx',
    'client/src/components/agent/TemplateCard.tsx',
    'client/src/components/agent/TemplateVariableForm.tsx',
  ];

  components.forEach((component) => {
    if (!checkFileExists(component, '前端组件')) {
      warning(`组件缺失，但 HTML 版本可能存在`);
      results.warnings++;
    }
  });
  console.log('');

  // 9. 前端服务文件
  info('9. 检查前端服务文件...');
  checkFileExists(
    'client/src/services/agent/templateService.js',
    '前端服务'
  );
  console.log('');

  // 10. 文档文件
  info('10. 检查文档文件...');
  const docs = [
    'docs/Pivot_v0.3.0_需求规格说明书.md',
    'docs/Pivot_v0.3.0_技术架构设计.md',
    'docs/Pivot_v0.3.0_数据库Schema文档.md',
    'docs/Pivot_v0.3.0_API接口文档.md',
    'docs/releases/v0.3.0-智能体系统全面优化升级.md'
  ];

  docs.forEach((doc) => {
    checkFileExists(doc, '文档');
  });
  console.log('');

  // 11. 测试文件
  info('11. 检查测试文件...');
  const tests = [
    'tests/services/agent/workflowTemplateService.test.js',
    'tests/services/agent/workflowTemplateRatingService.test.js',
    'tests/services/agent/workflowInstanceService.test.js',
  ];

  tests.forEach((test) => {
    if (!checkFileExists(test, '测试文件')) {
      warning(`测试文件缺失: ${test}`);
      results.warnings++;
    }
  });
  console.log('');

  // 12. 验证 package.json 版本
  info('12. 验证版本号...');
  try {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')
    );
    if (packageJson.version === '0.3.0') {
      success(`版本号正确: ${packageJson.version}`);
      results.passed++;
    } else {
      error(`版本号不匹配: ${packageJson.version} (期望: 0.3.0)`);
      results.failed++;
    }
  } catch (err) {
    error(`无法读取 package.json: ${err.message}`);
    results.failed++;
  }
  console.log('');

  // 13. 验证 CHANGELOG
  info('13. 验证 CHANGELOG...');
  checkFileExists('CHANGELOG.md', 'CHANGELOG');
  console.log('');

  // 打印结果
  console.log('=========================================');
  console.log('  验证结果');
  console.log('=========================================\n');
  log(`✓ 通过: ${results.passed}`, 'green');
  log(`✗ 失败: ${results.failed}`, 'red');
  log(`⚠ 警告: ${results.warnings}`, 'yellow');
  console.log('');

  const total = results.passed + results.failed;
  const percentage = ((results.passed / total) * 100).toFixed(1);

  if (results.failed === 0) {
    log('=========================================', 'green');
    log('  ✓ 验证通过！系统完整', 'green');
    log('=========================================', 'green');
    console.log('');
    return 0;
  } else {
    log('=========================================', 'red');
    log(`  ✗ 验证失败 (${percentage}% 通过)`, 'red');
    log('=========================================', 'red');
    console.log('');
    return 1;
  }
}

// 运行验证
main()
  .then((exitCode) => {
    process.exit(exitCode);
  })
  .catch((err) => {
    error(`验证脚本执行失败: ${err.message}`);
    console.error(err);
    process.exit(1);
  });
