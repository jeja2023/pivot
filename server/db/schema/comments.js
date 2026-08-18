/**
 * server/db/schema/comments.js
 * 数据库表级与字段级中文元数据注释字典（全量 79 张表）
 *
 * 用于在 PostgreSQL 中执行 COMMENT ON TABLE / COMMENT ON COLUMN，
 * 方便 DBA 运维、Navicat / DBeaver / DataGrip 等数据库客户端直观查阅数据字典。
 */

const TABLE_COMMENTS = {
    // ── 系统配置与基础元数据 ──
    app_meta: '系统全局元数据与运行状态标记表',
    schema_migrations: '版本化数据库迁移执行记录表',
    app_settings: '系统级全局参数与业务运行配置表',
    user_settings: '用户个人偏好设置与个性化配置表',
    audit_logs: '全局安全审计日志与用户操作行为轨迹表',
    api_call_logs: '外部 API 与模型调用审计日志表',
    observability_events: '系统可观测性监控与性能指标事件表',

    // ── 用户与认证体系 ──
    users: '系统用户主表（包含账号、身份、权限角色及状态）',
    refresh_tokens: '用户登录刷新令牌与会话凭证表',
    api_keys: 'OpenAI 协议兼容的对外开放 API Key 表',

    // ── 会话与对话系统 ──
    sessions: '用户聊天对话会话主表',
    messages: '会话内聊天消息明细表（含用户提问、助手回复与推理思考）',
    attachments: '会话消息上传的附件元数据表（图片、文档等）',
    prompts: '提示词模板与快捷角色指令库',
    announcements: '系统全员公告与通知发布主表',
    announcement_reads: '全员公告用户已读状态记录表',

    // ── 模型与网关 ──
    models: '接入的 LLM 大语言模型与多模态模型配置表',
    model_usage_events: '模型 Token 用量与计费统计事件表',

    // ── 长期记忆系统 ──
    memories: '用户专属长期记忆库（事实、偏好、习惯与技能）',
    memory_extraction_jobs: '长期记忆异步抽取与合并治理任务表',

    // ── 知识库与 RAG 检索 ──
    knowledge_collections: '企业知识库集合（合集）分类表',
    knowledge_docs: '知识库文档主表（解析状态与源文件引用）',
    knowledge_chunks: '知识库切片分块与稠密向量索引表',
    knowledge_doc_tags: '知识库文档与标签关联映射表',
    knowledge_tags: '知识库业务标签定义字典表',
    rag_feedback: 'RAG 问答效果用户点赞点踩反馈表',
    rag_debug_queries: 'RAG 检索调试历史与得分分析记录表',

    // ── 知识图谱 ──
    knowledge_entities: '知识图谱实体主表（概念、术语、机构等）',
    knowledge_entity_mentions: '知识图谱实体在文档分块中的提及引用表',
    knowledge_relations: '知识图谱实体间三元组关系表',

    // ── 规章制度库 ──
    regulation_documents: '企业制度规范制度文档主表',
    regulation_versions: '制度文档历史版本与生命周期管理表',
    regulation_articles: '制度条款拆解细则与条款内容表',
    regulation_article_links: '制度条款之间的上下游引用关联表',
    regulation_aliases: '制度条款同义词与业务别名表',
    regulation_article_annotations: '制度条款人工专家批注与解读表',
    regulation_access_logs: '制度库用户查阅与访问审计日志表',
    regulation_saved_searches: '用户制度检索收藏与常用查询条件表',

    // ── 智能体 Agent 与 DAG 任务 ──
    agent_runs: '智能体任务运行主表（包含目标、状态、预算与模式）',
    agent_steps: '智能体单步执行记录表（规划、思考、工具调用与结果）',
    agent_traces: '智能体分布式链路追踪 Trace 主表',
    agent_trace_spans: '智能体链路 Span 明细表（阶段耗时与调用拓扑）',
    agent_run_checkpoints: '智能体长时间运行状态快照与断点恢复 Checkpoint 表',
    agent_eval_suites: '智能体自动化评测集定义主表',
    agent_eval_cases: '智能体评测集测试用例明细表',
    agent_eval_runs: '智能体评测执行批次运行表',
    agent_eval_results: '智能体评测用例得分与指标明细表',
    agent_templates: '智能体可复用预设模版与应用资产表',
    agent_schedules: '智能体定时自动化调度任务表（Cron 触发器）',
    agent_artifacts: '智能体执行生成的产物元数据表（文件、报告、图表）',
    agent_artifact_versions: '智能体产物历史迭代版本表',
    agent_dag_nodes: '智能体 DAG 编排节点执行状态与上下文表',
    agent_approval_requests: '智能体高危工具人工审批请求表（Human-in-the-loop）',
    agent_notifications: '智能体执行完成与告警系统通知表',

    // ── 工作流 Workflow 编排 ──
    agent_workflows: '企业可视化工作流定义主表',
    agent_workflow_versions: '工作流版本编排快照表（节点与连线 DAG 结构）',
    agent_workflow_dependency_bindings: '工作流跨节点依赖与动态数据绑定表',
    agent_workflow_triggers: '工作流外部事件与 Webhook 触发器表',
    workflow_credentials: '工作流集成第三方系统安全凭证表（加密存储）',

    // ── 组织机构与多租户权限 ──
    organizations: '多租户企业组织机构主表',
    teams: '企业部门与业务团队定义表',
    team_members: '团队成员关系与团队内角色关联表',
    resource_permissions: '细粒度资源访问控制策略表（ACL/RBAC）',
    policy_objects: '企业安全与合规治理策略对象表',
    deployment_provider_configs: '模型与算力部署服务商环境配置表',
    capability_packages: '企业扩展功能包与能力单元配置表',

    // ── MCP 协议与外部工具生态 ──
    mcp_servers: 'MCP（Model Context Protocol）外部服务节点配置表',
    mcp_tool_cache: 'MCP 动态暴露工具定义元数据缓存表',
    mcp_call_logs: 'MCP 工具实际调用入参、出参与延迟日志表',
    mcp_database_connections: 'MCP 关系型数据库连接源配置表',
    mcp_builtin_configs: '系统内置 MCP 插件与扩展参数配置表',

    // ── 文档处理与 OCR 流水线 ──
    document_files: '文档智能处理流水线原始文件存储表',
    document_jobs: '文档解析、OCR 与结构化抽取异步作业表',
    document_pages: '文档单页渲染图片与页面元数据表',
    document_ocr_blocks: '文档 OCR 识别文本框与排版几何块表',
    document_outputs: '文档处理最终结构化产物输出表（Markdown/JSON）',
    document_reviews: '文档结构化内容人工校对与审核修正表',

    // ── 数据分析看板 ──
    analysis_datasets: '数据分析看板导入的数据集主表',
    analysis_artifacts: '数据分析生成的图表视图与统计分析结果表',
};

const COMMON_COLUMN_COMMENTS = {
    id: '主键自增 ID / 唯一主键',
    user_id: '所属用户 ID',
    session_id: '关联的会话 ID',
    created_at: '记录创建时间（东八区）',
    updated_at: '最后更新时间（东八区）',
    deleted_at: '软删除时间（为空表示正常有效）',
    status: '状态标识',
    metadata: '扩展元数据（JSON 格式）',
    name: '名称',
    title: '标题',
    description: '描述说明',
    content: '文本内容主体',
    role: '角色标识（user/assistant/system/tool 等）',
    version: '版本号',
    type: '类型标识',
    config: '详细配置参数（JSON 格式）',
};

const COLUMN_COMMENTS = {
    users: {
        id: '用户主键 ID',
        username: '登录用户名（唯一）',
        password_hash: '加盐哈希加密后的登录密码',
        nickname: '用户中文显示昵称',
        unit: '所属单位/部门名称',
        role: '用户全局角色（admin/user）',
        status: '账号状态（active/disabled）',
        default_model_id: '用户默认选中的首选模型 ID',
        last_login_at: '最后一次成功登录时间',
        deleted_by_admin: '是否由管理员执行软删除（1:是, 0:否）',
        deleted_username: '删除时备份的原用户名',
    },
    sessions: {
        id: '会话主键 ID',
        user_id: '所属用户 ID',
        title: '会话标题',
        model_id: '会话当前绑定的默认模型 ID',
        is_pinned: '是否置顶会话（1:置顶, 0:常规）',
        is_archived: '是否已归档（1:已归档, 0:正常）',
        tag_values: '会话绑定的标签值（JSON 数组）',
        summary: '会话内容摘要',
    },
    messages: {
        id: '消息主键 ID',
        session_id: '所属会话 ID',
        user_id: '发送用户 ID',
        role: '消息发送角色（user/assistant/system/tool）',
        content: '消息正文内容',
        thought: '大模型思维链推理过程（Thinking 过程）',
        model_id: '生成该消息所使用的模型 ID',
        tokens_prompt: '输入提示词消耗的 Token 数',
        tokens_completion: '模型生成回复消耗的 Token 数',
        tokens_reasoning: '思维链推理消耗的 Token 数',
        latency_ms: '模型响应全流程耗时（毫秒）',
        first_token_ms: '首字生成耗时（毫秒）',
        tool_calls: '模型返回的工具调用指令结构体（JSON）',
        is_error: '是否为报错异常消息（1:是, 0:否）',
    },
    models: {
        id: '模型主键 ID',
        name: '模型在界面展示的友好名称',
        model_name: '模型在推理后端对应的 API 真实模型名',
        url: '模型 API 端点基础 URL',
        max_concurrent: '允许的最大并发调用请求数',
        daily_token_limit: '每日 Token 消耗上限配额',
        allowed_units: '允许访问此模型的部门单位白名单',
        supports_vision: '是否支持图片等多模态视觉输入',
        supports_reasoning: '是否支持 DeepSeek-R1 等深度思考模式',
        chat_thinking_enabled: '是否在对话中默认开启深度思考',
    },
    knowledge_docs: {
        id: '文档主键 ID',
        collection_id: '所属知识库合集 ID',
        filename: '文档原始文件名',
        file_path: '文档在磁盘上的物理存储相对路径',
        file_size: '文档文件大小（字节）',
        file_hash: '文档内容 SHA-256 唯一校验哈希',
        status: '索引解析状态（pending/processing/ready/error）',
        chunk_count: '分块切片总数',
        total_tokens: '文档包含的总 Token 预估数',
        error_message: '解析或向量化失败时的错误信息',
    },
    knowledge_chunks: {
        id: '分块主键 ID',
        doc_id: '所属知识库文档 ID',
        chunk_index: '分块在原文档中的顺序序号（从0开始）',
        content: '分块纯文本内容',
        search_content: '用于全文检索优化的分词与归一化文本',
        token_count: '分块包含的 Token 数',
        embedding: '向量表示（pgvector 向量数据）',
    },
    agent_runs: {
        id: '任务运行主键 ID',
        user_id: '发起任务的用户 ID',
        goal: '智能体目标与需求描述',
        status: '任务状态（running/completed/failed/cancelled/paused）',
        model_id: '智能体主控推理模型 ID',
        run_mode: '运行模式（standard/quick/dag）',
        max_steps: '最大允许执行轮数（步数）',
        current_step: '当前已执行步数',
        final_answer: '智能体最终交付的总结回答',
        error_message: '任务异常终止时的错误原因',
    },
    agent_steps: {
        id: '执行步骤主键 ID',
        run_id: '所属智能体任务 ID',
        step_number: '执行步数序号',
        step_type: '步骤类型（plan/thought/tool/observation/answer）',
        content: '步骤产生的文本内容或模型回复',
        tool_name: '本步调用的工具名称',
        tool_input: '传递给工具的入参（JSON）',
        tool_output: '工具执行返回的原始结果',
        latency_ms: '本步骤执行耗时（毫秒）',
    },
    agent_workflows: {
        id: '工作流主键 ID',
        user_id: '创建者用户 ID',
        name: '工作流名称',
        description: '工作流业务场景与功能描述',
        status: '工作流状态（draft/published/archived）',
        unit: '所属业务单位',
        active_version_id: '当前生效的已发布版本 ID',
    },
    agent_workflow_versions: {
        id: '工作流版本主键 ID',
        workflow_id: '所属工作流 ID',
        version: '版本号字符串（如 v1.0）',
        nodes: '工作流包含的 DAG 节点配置（JSON 数组）',
        edges: '工作流节点间的连线与流转规则（JSON 数组）',
        created_by: '发布该版本的用户 ID',
    }
};

/**
 * 生成全量 PostgreSQL COMMENT ON 语句列表
 */
function buildPgCommentStatements() {
    const statements = [];

    // 1. 表级注释
    for (const [table, comment] of Object.entries(TABLE_COMMENTS)) {
        statements.push(`COMMENT ON TABLE "${table}" IS '${comment.replace(/'/g, "''")}';`);
    }

    // 2. 字段级注释
    for (const [table, cols] of Object.entries(COLUMN_COMMENTS)) {
        for (const [col, comment] of Object.entries(cols)) {
            statements.push(`COMMENT ON COLUMN "${table}"."${col}" IS '${comment.replace(/'/g, "''")}';`);
        }
    }

    return statements;
}

module.exports = {
    TABLE_COMMENTS,
    COLUMN_COMMENTS,
    COMMON_COLUMN_COMMENTS,
    buildPgCommentStatements,
};
