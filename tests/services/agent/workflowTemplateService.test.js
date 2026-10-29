const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { WorkflowTemplateService } = require('../../../server/services/agent/workflowTemplateService');
const { queryOne, execute } = require('../../../server/db/client');

describe('WorkflowTemplateService Tests', () => {
  it('should list builtin workflow templates with pagination', async () => {
    const result = await WorkflowTemplateService.listTemplates({
      isBuiltin: true,
      limit: 10,
      page: 1
    });

    assert.ok(result, 'Result should exist');
    assert.ok(Array.isArray(result.templates), 'templates should be an array');
    assert.strictEqual(typeof result.pagination.total, 'number', 'total should be a number');
  });

  it('should resolve variable substitution correctly in templates', () => {
    const spec = {
      nodes: [
        { id: 'node_1', config: { query: '{{var.database_table}}' } }
      ]
    };
    const variables = { database_table: 'users' };
    const replaced = WorkflowTemplateService._replaceVariables(spec, variables);
    assert.strictEqual(replaced.nodes[0].config.query, 'users');
    assert.deepEqual(WorkflowTemplateService._replaceVariables({
      prompt: '你好 {{var.person.name}}', fallback: '{{var.city|上海}}', items: ['{{var.number}}']
    }, { person: { name: '小李' }, number: 0 }), { prompt: '你好 小李', fallback: '上海', items: ['0'] });
  });
  it('模板分类、筛选、分页及应用记录在真实数据库中一致', async () => {
    const suffix = `${process.pid}_${Date.now()}`;
    const owner = await queryOne('INSERT INTO users (username, password_hash) VALUES (?, ?) RETURNING id', [`template_cases_${suffix}`, 'hash']);
    const category = await queryOne('INSERT INTO agent_workflow_template_categories (name, slug, display_order) VALUES (?, ?, ?) RETURNING id', [`分类${suffix}`, `category-${suffix}`, 1]);
    try {
      const base = {
        categoryId: category.id, description: `测试 ${suffix}`,
        dagSpecTemplate: { nodes: [{ id: 'one', input: '{{var.name}}' }] },
        variables: [{ name: 'name', type: 'string', required: true }]
      };
      const first = await WorkflowTemplateService.createTemplate({ ...base, name: `模板甲 ${suffix}`, slug: `first-${suffix}`, difficulty: 'beginner', tags: [`tag-${suffix}`] }, Number(owner.id));
      const second = await WorkflowTemplateService.createTemplate({ ...base, name: `模板乙 ${suffix}`, slug: `second-${suffix}`, difficulty: 'advanced' }, Number(owner.id));
      const filtered = await WorkflowTemplateService.listTemplates({ category: `category-${suffix}`, difficulty: 'beginner', search: `tag-${suffix}`, page: 1, pageSize: 1 });
      assert.equal(filtered.pagination.total, 1);
      assert.deepEqual(filtered.templates.map(item => item.id), [first.id]);
      const page = await WorkflowTemplateService.listTemplates({ category: `category-${suffix}`, page: 2, pageSize: 1 });
      assert.equal(page.pagination.total, 2);
      assert.equal(page.templates.length, 1);
      assert.equal((await WorkflowTemplateService.getTemplateDetail(`first-${suffix}`, Number(owner.id))).id, first.id);
      await assert.rejects(WorkflowTemplateService.getTemplateDetail(`missing-${suffix}`, Number(owner.id)), error => error.status === 404);
      await assert.rejects(WorkflowTemplateService.rateTemplate(2147483647, 5, '', Number(owner.id)), error => error.status === 404);
      for (const invalid of [0, 6]) await assert.rejects(WorkflowTemplateService.rateTemplate(first.id, invalid, '', Number(owner.id)), error => error.status === 400);
      const workflow = await WorkflowTemplateService.applyTemplate(first.id, { name: '测试值', workflow_name: `流程 ${suffix}` }, Number(owner.id));
      assert.equal(workflow.name, `流程 ${suffix}`);
      assert.equal(workflow.dag_spec.nodes[0].input, '测试值');
      const usage = await queryOne('SELECT workflow_id, user_id FROM agent_workflow_template_usage WHERE template_id = ?', [first.id]);
      assert.equal(usage.workflow_id, workflow.id);
      assert.equal(usage.user_id, Number(owner.id));
      assert.equal((await WorkflowTemplateService.getTemplateDetail(first.id, Number(owner.id))).usage_count, 1);
      const sorted = await WorkflowTemplateService.listTemplates({ category: `category-${suffix}`, sortBy: 'usage_count', sortOrder: 'desc' });
      assert.deepEqual(sorted.templates.map(item => item.id), [first.id, second.id]);
      await execute('DELETE FROM agent_workflows WHERE id = ?', [workflow.id]);
    } finally {
      await execute('DELETE FROM users WHERE id = ?', [owner.id]);
      await execute('DELETE FROM agent_workflow_template_categories WHERE id = ?', [category.id]);
    }
  });
  it('模板创建拒绝重复 slug、空 DAG 和未知变量类型', async () => {
    const suffix = `${process.pid}_${Date.now()}`;
    const owner = await queryOne('INSERT INTO users (username, password_hash) VALUES (?, ?) RETURNING id', [`template_validation_${suffix}`, 'hash']);
    const base = { name: '测试模板', slug: `template-${suffix}`, dagSpecTemplate: { nodes: [{ id: 'one' }] } };
    try {
      await WorkflowTemplateService.createTemplate(base, Number(owner.id));
      await assert.rejects(WorkflowTemplateService.createTemplate(base, Number(owner.id)), /slug 已存在/);
      await assert.rejects(WorkflowTemplateService.createTemplate({ ...base, slug: `empty-${suffix}`, dagSpecTemplate: { nodes: [] } }, Number(owner.id)), /至少一个节点/);
      await assert.rejects(WorkflowTemplateService.createTemplate({ ...base, slug: `invalid-${suffix}`, variables: [{ name: 'x', type: 'invalid' }] }, Number(owner.id)), /类型无效/);
      const categories = await WorkflowTemplateService.listCategories();
      assert.ok(categories.every(item => item.is_active));
      assert.ok(categories.every((item, index) => index === 0 || categories[index - 1].display_order <= item.display_order));
    } finally {
      await execute('DELETE FROM users WHERE id = ?', [owner.id]);
    }
  });
  it('私有模板仅创建者可查阅，变量验证阻止缺失必填值', async () => {
    const suffix = `${process.pid}_${Date.now()}`;
    const owner = await queryOne('INSERT INTO users (username, password_hash) VALUES (?, ?) RETURNING id', [`template_owner_${suffix}`, 'hash']);
    const other = await queryOne('INSERT INTO users (username, password_hash) VALUES (?, ?) RETURNING id', [`template_other_${suffix}`, 'hash']);
    try {
      const template = await WorkflowTemplateService.createTemplate({
        name: `私有模板 ${suffix}`, slug: `private-${suffix}`, isPublic: false,
        dagSpecTemplate: { nodes: [{ id: 'one', value: '{{var.name}}' }] },
        variables: [{ name: 'name', type: 'string', required: true }]
      }, Number(owner.id));
      const ownerList = await WorkflowTemplateService.listTemplates({ includePrivate: true, userId: Number(owner.id), search: suffix });
      assert.equal(ownerList.templates.some(item => item.id === template.id), true);
      const otherList = await WorkflowTemplateService.listTemplates({ includePrivate: true, userId: Number(other.id), search: suffix });
      assert.equal(otherList.templates.some(item => item.id === template.id), false);
      const anonymousList = await WorkflowTemplateService.listTemplates({ includePrivate: true, search: suffix });
      assert.equal(anonymousList.templates.some(item => item.id === template.id), false);
      assert.equal((await WorkflowTemplateService.getTemplateDetail(template.id, Number(owner.id))).id, template.id);
      await assert.rejects(WorkflowTemplateService.getTemplateDetail(template.id, Number(other.id)), error => error.status === 403);
      await assert.rejects(WorkflowTemplateService.rateTemplate(template.id, 5, '无权评分', Number(other.id)), error => error.status === 403);
      await assert.rejects(WorkflowTemplateService.rateTemplate(template.id, 1.5, '', Number(owner.id)), error => error.status === 400);
      const firstRating = await WorkflowTemplateService.rateTemplate(template.id, 5, '有效评分', Number(owner.id));
      assert.equal(firstRating.template_count, 1);
      const updatedRating = await WorkflowTemplateService.rateTemplate(template.id, 3, '修改评分', Number(owner.id));
      assert.equal(updatedRating.template_count, 1);
      assert.equal(updatedRating.template_avg, '3.00');
      await assert.rejects(WorkflowTemplateService.applyTemplate(template.id, {}, Number(owner.id)), /必填/);
    } finally {
      await execute('DELETE FROM users WHERE id IN (?, ?)', [owner.id, other.id]);
    }
  });

});
