const test = require('node:test');
const assert = require('node:assert/strict');

const {
    buildOperationInputSchema,
    extractOperations,
    resolveOperationUrl,
    schemaWithoutReferences,
    toToolDefinition
} = require('../server/services/workflow-api-operations');

const document = {
    openapi: '3.0.3',
    servers: [{ url: 'https://api.example.test/v1' }],
    paths: {
        '/orders/{orderId}': {
            parameters: [{ name: 'orderId', in: 'path', required: true, schema: { type: 'string' } }],
            get: {
                operationId: 'getOrder',
                summary: '读取订单',
                parameters: [{ name: 'includeItems', in: 'query', schema: { type: 'boolean' } }],
                responses: {
                    200: {
                        content: {
                            'application/json': {
                                schema: { type: 'object', properties: { id: { type: 'string' } } }
                            }
                        }
                    }
                }
            },
            post: {
                operationId: 'updateOrder',
                summary: '更新订单',
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: { type: 'object', required: ['status'], properties: { status: { type: 'string' } } }
                        }
                    }
                },
                responses: {
                    200: {
                        content: {
                            'application/json': { schema: { type: 'object' } }
                        }
                    }
                }
            }
        }
    }
};

test('OpenAPI 导入只生成受支持的内联 JSON 操作与契约', () => {
    const operations = extractOperations(document);
    assert.equal(operations.length, 2);
    const read = operations.find(item => item.operationId === 'getOrder');
    const write = operations.find(item => item.operationId === 'updateOrder');
    assert.equal(read.method, 'GET');
    assert.equal(read.baseUrl, 'https://api.example.test/v1');
    assert.equal(read.parameters.length, 2);
    assert.equal(write.bodySchema.required, true);
    assert.deepEqual(buildOperationInputSchema(write.parameters, write.bodySchema).required, ['orderId', 'body']);
    assert.throws(() => extractOperations({ ...document, openapi: '2.0.0' }), /仅支持 OpenAPI 3/);
    assert.throws(() => schemaWithoutReferences({ $ref: '#/components/schemas/Order' }), /暂不支持/);
});

test('OpenAPI 操作 URL 仅替换声明参数并进行编码', () => {
    const row = {
        base_url: 'https://api.example.test/v1',
        path_template: '/orders/{orderId}',
        parameter_schema: [
            { name: 'orderId', location: 'path', required: true, schema: { type: 'string' } },
            { name: 'tag', location: 'query', required: false, schema: { type: 'string' } }
        ]
    };
    assert.equal(resolveOperationUrl(row, { orderId: 'A/B', tag: '新品' }), 'https://api.example.test/v1/orders/A%2FB?tag=%E6%96%B0%E5%93%81');
    assert.throws(() => resolveOperationUrl(row, { tag: 'x' }), /缺少 API 参数/);
});

test('API 操作工具保持网络、审批和无缓存契约', () => {
    const tool = toToolDefinition({
        id: 'op-1', name: '更新订单', description: '', source_digest: 'digest', method: 'POST', base_url: 'https://api.example.test', path_template: '/orders',
        parameter_schema: [], body_schema: { schema: { type: 'object' }, required: true }, response_schema: { type: 'object' }, side_effect: true, idempotent: false
    });
    assert.equal(tool.name, 'api.operation.op-1');
    assert.deepEqual(tool.capabilities, ['network.http_request']);
    assert.equal(tool.approval_required, true);
    assert.equal(tool.network, true);
    assert.equal(tool.cacheable, false);
    assert.deepEqual(tool.input_schema.required, ['body']);
});
