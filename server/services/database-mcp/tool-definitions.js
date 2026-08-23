const SQL_TOOL_DEFINITIONS = [
    {
        name: 'db.list_tables',
        title: '列出数据表',
        description: '列出当前数据库中可查询的表和视图。',
        inputSchema: {
            type: 'object',
            properties: {
                schema: { type: 'string', description: '可选，数据库 schema 名称。' }
            }
        }
    },
    {
        name: 'db.count_tables',
        title: '统计数据表数量',
        description: '统计当前数据库中可查询的数据表和视图数量，适合回答“有多少张表”等问题。',
        inputSchema: {
            type: 'object',
            properties: {
                schema: { type: 'string', description: '可选，数据库 schema 名称。' }
            }
        }
    },
    {
        name: 'db.describe_table',
        title: '查看表结构',
        description: '查看表字段、类型和可空性，辅助模型生成安全 SQL。',
        inputSchema: {
            type: 'object',
            required: ['table'],
            properties: {
                table: { type: 'string', description: '表名。' },
                schema: { type: 'string', description: '可选，数据库 schema 名称。' }
            }
        }
    },
    {
        name: 'db.run_readonly_query',
        title: '执行只读 SQL',
        description: '执行只读 SQL 查询，仅允许 SELECT/WITH/SHOW/DESCRIBE/EXPLAIN，并限制返回行数。',
        inputSchema: {
            type: 'object',
            required: ['sql'],
            properties: {
                sql: { type: 'string', description: '只读 SQL。' },
                limit: { type: 'integer', minimum: 1, maximum: 1000, description: '最大返回行数，默认 100。' }
            }
        }
    },
    {
        name: 'db.group_count',
        title: '分组统计',
        description: '按指定表字段分组并统计数量，适合普通用户生成分布图，系统会自动生成安全只读 SQL。',
        inputSchema: {
            type: 'object',
            required: ['table', 'groupBy'],
            properties: {
                table: { type: 'string', description: '要统计的数据表。' },
                groupBy: { type: 'string', description: '用于分组统计的字段。' },
                schema: { type: 'string', description: '可选，数据库 schema 名称。' },
                groupAlias: { type: 'string', default: 'group_value', description: '分组字段输出别名。' },
                countAlias: { type: 'string', default: 'count', description: '数量字段别名。' },
                limit: { type: 'integer', minimum: 1, maximum: 1000, default: 100, description: '最多返回的分组数量。' },
                sortOrder: { type: 'string', enum: ['asc', 'desc'], default: 'desc', description: '按数量排序方向。' }
            }
        }
    }
];

const MONGO_TOOL_DEFINITIONS = [
    {
        name: 'db.list_collections',
        title: '列出集合',
        description: '列出 MongoDB 数据库中的集合。',
        inputSchema: { type: 'object', properties: {} }
    },
    {
        name: 'db.count_collections',
        title: '统计集合数量',
        description: '统计 MongoDB 数据库中的集合数量，适合回答“有多少个集合”等问题。',
        inputSchema: { type: 'object', properties: {} }
    },
    {
        name: 'db.sample_collection',
        title: '读取集合样本',
        description: '读取 MongoDB 集合的小样本，辅助理解字段结构。',
        inputSchema: {
            type: 'object',
            required: ['collection'],
            properties: {
                collection: { type: 'string' },
                limit: { type: 'integer', minimum: 1, maximum: 100, description: '最大返回文档数，默认 20。' }
            }
        }
    },
    {
        name: 'db.aggregate',
        title: '执行聚合分析',
        description: '执行 MongoDB 聚合管道，建议仅用于只读统计分析。',
        inputSchema: {
            type: 'object',
            required: ['collection', 'pipeline'],
            properties: {
                collection: { type: 'string' },
                pipeline: { type: 'array', description: 'MongoDB aggregation pipeline。' },
                limit: { type: 'integer', minimum: 1, maximum: 1000, description: '最大返回文档数，默认 100。' }
            }
        }
    }
];

module.exports = { SQL_TOOL_DEFINITIONS, MONGO_TOOL_DEFINITIONS };
