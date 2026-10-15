/**
 * 工作流模板服务单元测试
 */

const workflowTemplateService = require('./workflowTemplateService');
const db = require('../../db/knex');

describe('WorkflowTemplateService', () => {
  let testUserId;
  let testCategoryId;
  let testTemplateId;

  beforeAll(async () => {
    // 创建测试用户
    const [user] = await db('users')
      .insert({
        username: 'test_template_user',
        email: 'test@template.com',
        password_hash: 'test',
      })
      .returning('*');
    testUserId = user.id;

    // 创建测试分类
    const [category] = await db('agent_workflow_template_categories')
      .insert({
        name: 'Test Category',
        slug: 'test-category',
      })
      .returning('*');
    testCategoryId = category.id;
  });

  afterAll(async () => {
    // 清理测试数据
    if (testTemplateId) {
      await db('agent_workflow_templates').where('id', testTemplateId).del();
    }
    await db('agent_workflow_template_categories').where('id', testCategoryId).del();
    await db('users').where('id', testUserId).del();
    await db.destroy();
  });

  describe('createTemplate', () => {
    it('should create a template successfully', async () => {
      const templateData = {
        name: 'Test Template',
        slug: 'test-template-' + Date.now(),
        categoryId: testCategoryId,
        description: 'Test description',
        tags: ['test', 'demo'],
        difficulty: 'beginner',
        estimatedTime: '5 minutes',
        dagSpecTemplate: {
          nodes: [
            {
              id: 'node1',
              type: 'llm_call',
              config: { prompt: 'Hello {{var.name}}' },
            },
          ],
          edges: [],
        },
        variables: [
          {
            name: 'name',
            type: 'string',
            label: 'Name',
            required: true,
          },
        ],
      };

      const template = await workflowTemplateService.createTemplate(templateData, testUserId);

      expect(template).toBeDefined();
      expect(template.id).toBeDefined();
      expect(template.name).toBe(templateData.name);
      expect(template.slug).toBe(templateData.slug);

      testTemplateId = template.id;
    });

    it('should throw error for duplicate slug', async () => {
      const templateData = {
        name: 'Another Template',
        slug: 'test-template-' + Date.now(),
        categoryId: testCategoryId,
        dagSpecTemplate: { nodes: [{ id: '1' }], edges: [] },
        variables: [],
      };

      // 创建第一个模板
      await workflowTemplateService.createTemplate(templateData, testUserId);

      // 尝试创建重复 slug 的模板
      await expect(
        workflowTemplateService.createTemplate(templateData, testUserId)
      ).rejects.toThrow('模板 slug 已存在');
    });

    it('should throw error for invalid DAG spec', async () => {
      const templateData = {
        name: 'Invalid Template',
        slug: 'invalid-template',
        categoryId: testCategoryId,
        dagSpecTemplate: {}, // 缺少 nodes
        variables: [],
      };

      await expect(
        workflowTemplateService.createTemplate(templateData, testUserId)
      ).rejects.toThrow('DAG 必须包含至少一个节点');
    });

    it('should throw error for invalid variable type', async () => {
      const templateData = {
        name: 'Invalid Variable Template',
        slug: 'invalid-variable-template',
        categoryId: testCategoryId,
        dagSpecTemplate: { nodes: [{ id: '1' }], edges: [] },
        variables: [
          {
            name: 'test_var',
            type: 'invalid_type', // 无效类型
            label: 'Test',
          },
        ],
      };

      await expect(
        workflowTemplateService.createTemplate(templateData, testUserId)
      ).rejects.toThrow(/变量.*的类型无效/);
    });
  });

  describe('listTemplates', () => {
    it('should list templates with pagination', async () => {
      const result = await workflowTemplateService.listTemplates({
        page: 1,
        pageSize: 10,
      });

      expect(result).toBeDefined();
      expect(result.templates).toBeInstanceOf(Array);
      expect(result.pagination).toBeDefined();
      expect(result.pagination.page).toBe(1);
      expect(result.pagination.pageSize).toBe(10);
    });

    it('should filter templates by category', async () => {
      const result = await workflowTemplateService.listTemplates({
        category: 'test-category',
      });

      expect(result.templates).toBeInstanceOf(Array);
      result.templates.forEach((t) => {
        expect(t.category_slug).toBe('test-category');
      });
    });

    it('should filter templates by difficulty', async () => {
      const result = await workflowTemplateService.listTemplates({
        difficulty: 'beginner',
      });

      expect(result.templates).toBeInstanceOf(Array);
      result.templates.forEach((t) => {
        expect(t.difficulty).toBe('beginner');
      });
    });

    it('should search templates by keyword', async () => {
      const result = await workflowTemplateService.listTemplates({
        search: 'Test Template',
      });

      expect(result.templates).toBeInstanceOf(Array);
      if (result.templates.length > 0) {
        const found = result.templates.some((t) => t.name.includes('Test Template'));
        expect(found).toBe(true);
      }
    });

    it('should sort templates by usage_count', async () => {
      const result = await workflowTemplateService.listTemplates({
        sortBy: 'usage_count',
        sortOrder: 'desc',
      });

      expect(result.templates).toBeInstanceOf(Array);
      if (result.templates.length > 1) {
        expect(result.templates[0].usage_count).toBeGreaterThanOrEqual(
          result.templates[1].usage_count
        );
      }
    });
  });

  describe('getTemplateDetail', () => {
    it('should get template by ID', async () => {
      if (!testTemplateId) return;

      const template = await workflowTemplateService.getTemplateDetail(testTemplateId);

      expect(template).toBeDefined();
      expect(template.id).toBe(testTemplateId);
      expect(template.name).toBeDefined();
      expect(template.dag_spec_template).toBeDefined();
      expect(template.variables).toBeDefined();
    });

    it('should get template by slug', async () => {
      if (!testTemplateId) return;

      const template = await workflowTemplateService.getTemplateDetail(testTemplateId);
      const templateBySlug = await workflowTemplateService.getTemplateDetail(template.slug);

      expect(templateBySlug).toBeDefined();
      expect(templateBySlug.id).toBe(testTemplateId);
    });

    it('should throw error for non-existent template', async () => {
      await expect(
        workflowTemplateService.getTemplateDetail(99999)
      ).rejects.toThrow('模板不存在');
    });

    it('should throw error for private template without permission', async () => {
      // 创建一个私有模板
      const privateTemplate = await workflowTemplateService.createTemplate(
        {
          name: 'Private Template',
          slug: 'private-template-' + Date.now(),
          categoryId: testCategoryId,
          dagSpecTemplate: { nodes: [{ id: '1' }], edges: [] },
          variables: [],
          isPublic: false,
        },
        testUserId
      );

      // 尝试以其他用户身份访问
      await expect(
        workflowTemplateService.getTemplateDetail(privateTemplate.id, testUserId + 1)
      ).rejects.toThrow('无权访问此模板');

      // 清理
      await db('agent_workflow_templates').where('id', privateTemplate.id).del();
    });
  });

  describe('applyTemplate', () => {
    it('should apply template and create workflow', async () => {
      if (!testTemplateId) return;

      const variableValues = {
        name: 'John Doe',
        workflow_name: 'Test Workflow',
      };

      const workflow = await workflowTemplateService.applyTemplate(
        testTemplateId,
        variableValues,
        testUserId
      );

      expect(workflow).toBeDefined();
      expect(workflow.id).toBeDefined();
      expect(workflow.name).toBe('Test Workflow');
      expect(workflow.template_id).toBe(testTemplateId);

      // 验证使用计数增加
      const template = await workflowTemplateService.getTemplateDetail(testTemplateId);
      expect(template.usage_count).toBeGreaterThan(0);

      // 清理
      await db('agent_workflows').where('id', workflow.id).del();
    });

    it('should throw error for missing required variable', async () => {
      if (!testTemplateId) return;

      const variableValues = {
        // 缺少必填变量 'name'
      };

      await expect(
        workflowTemplateService.applyTemplate(testTemplateId, variableValues, testUserId)
      ).rejects.toThrow(/是必填项/);
    });

    it('should replace variables correctly', async () => {
      const service = workflowTemplateService;

      const obj = {
        prompt: 'Hello {{var.name}}, you are {{var.age}} years old',
        default: '{{var.city|Beijing}}',
        nested: {
          message: '{{var.message}}',
        },
      };

      const values = {
        name: 'Alice',
        age: 25,
        message: 'Welcome',
      };

      const result = service._replaceVariables(obj, values);

      expect(result.prompt).toBe('Hello Alice, you are 25 years old');
      expect(result.default).toBe('Beijing'); // 使用默认值
      expect(result.nested.message).toBe('Welcome');
    });
  });

  describe('rateTemplate', () => {
    it('should rate template successfully', async () => {
      if (!testTemplateId) return;

      const result = await workflowTemplateService.rateTemplate(
        testTemplateId,
        5,
        'Excellent template!',
        testUserId
      );

      expect(result).toBeDefined();
      expect(result.rating).toBe(5);
      expect(result.template_avg).toBeDefined();
      expect(result.template_count).toBeGreaterThan(0);

      // 验证模板评分已更新
      const template = await workflowTemplateService.getTemplateDetail(testTemplateId);
      expect(parseFloat(template.rating_avg)).toBeGreaterThan(0);
      expect(template.rating_count).toBeGreaterThan(0);
    });

    it('should update existing rating', async () => {
      if (!testTemplateId) return;

      // 第一次评分
      await workflowTemplateService.rateTemplate(
        testTemplateId,
        3,
        'Good',
        testUserId
      );

      // 更新评分
      const result = await workflowTemplateService.rateTemplate(
        testTemplateId,
        4,
        'Very good',
        testUserId
      );

      expect(result.rating).toBe(4);
      expect(result.comment).toBe('Very good');
    });

    it('should throw error for invalid rating value', async () => {
      if (!testTemplateId) return;

      await expect(
        workflowTemplateService.rateTemplate(testTemplateId, 6, '', testUserId)
      ).rejects.toThrow('评分必须在 1-5 之间');

      await expect(
        workflowTemplateService.rateTemplate(testTemplateId, 0, '', testUserId)
      ).rejects.toThrow('评分必须在 1-5 之间');
    });

    it('should throw error for non-existent template', async () => {
      await expect(
        workflowTemplateService.rateTemplate(99999, 5, '', testUserId)
      ).rejects.toThrow('模板不存在');
    });
  });

  describe('listCategories', () => {
    it('should list all active categories', async () => {
      const categories = await workflowTemplateService.listCategories();

      expect(categories).toBeInstanceOf(Array);
      expect(categories.length).toBeGreaterThan(0);
      categories.forEach((cat) => {
        expect(cat.id).toBeDefined();
        expect(cat.name).toBeDefined();
        expect(cat.slug).toBeDefined();
        expect(cat.is_active).toBe(true);
      });
    });

    it('should return categories in display_order', async () => {
      const categories = await workflowTemplateService.listCategories();

      if (categories.length > 1) {
        for (let i = 0; i < categories.length - 1; i++) {
          expect(categories[i].display_order).toBeLessThanOrEqual(
            categories[i + 1].display_order
          );
        }
      }
    });
  });
});
