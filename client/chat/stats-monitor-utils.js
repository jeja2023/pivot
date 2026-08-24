/* 系统监控与可观测性辅助函数（拆自 stats-monitor.js） */




function renderMonitorEndpointLists(endpoints = {}) {
    const runtimeEndpoints = Array.isArray(endpoints.runtime) ? endpoints.runtime : [];
    const listEls = Array.from(document.querySelectorAll('.js-monitor-endpoint-list'));
    const legacyEl = document.getElementById('monitor-endpoint-list');
    if (legacyEl && !listEls.includes(legacyEl)) listEls.push(legacyEl);
    if (listEls.length === 0) return;

    const html = runtimeEndpoints.length
        ? runtimeEndpoints.map(item => {
            const concurrencyStatus = item.concurrency || {};
            const circuit = Number(item.circuitOpenMs || 0) > 0 ? ` · 熔断 ${formatMsDuration(item.circuitOpenMs)}` : '';
            const failures = Number(item.consecutiveFailures || 0) > 0 ? ` · 失败 ${formatMetricNumber(item.consecutiveFailures)}` : '';
            const modelNames = (item.models || []).map(model => model.name).filter(Boolean).slice(0, 3).join('、') || item.name || item.host;
            const detail = `${describeEndpointMonitor(item.monitor)} · 并发 ${formatMetricNumber(concurrencyStatus.active)}/${formatMetricNumber(concurrencyStatus.max)} · 排队 ${formatMetricNumber(concurrencyStatus.queued)}${failures}${circuit}`;
            const warningClass = item.monitor?.status === 'unreachable' || Number(item.circuitOpenMs || 0) > 0 ? ' is-warning' : '';
            const locBadge = item.isLocal
                ? '<span class="monitor-endpoint-badge is-local">本地</span>'
                : '<span class="monitor-endpoint-badge is-remote">远端</span>';
            return `<div class="monitor-endpoint${warningClass}">
                <div class="monitor-row">
                    <span title="${escapeHtml(item.host || item.key)}">${locBadge}${escapeHtml(modelNames)}</span>
                    <strong>${escapeHtml(item.host || item.key)}</strong>
                </div>
                <div class="monitor-empty">${escapeHtml(detail)}</div>
            </div>`;
        }).join('')
        : '<div class="monitor-empty">暂无模型端点运行数据</div>';

    listEls.forEach(el => { PivotSafeHtml.setHtml(el, html); });
}

const formatMetricNumber = (value, digits = 0) => Number(value || 0).toLocaleString(undefined, {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits
});
const formatBytes = (bytes) => {
    const value = Number(bytes) || 0;
    if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GB`;
    if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`;
    if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${value} B`;
};
const formatDuration = (seconds) => {
    const value = Number(seconds) || 0;
    const days = Math.floor(value / 86400);
    const hours = Math.floor((value % 86400) / 3600);
    const minutes = Math.floor((value % 3600) / 60);
    if (days > 0) return `${days}天 ${hours}小时`;
    if (hours > 0) return `${hours}小时 ${minutes}分钟`;
    return `${minutes}分钟`;
};

const formatMsDuration = (milliseconds) => {
    const value = Math.max(0, Number(milliseconds) || 0);
    if (value >= 60000) return `${Math.ceil(value / 60000)} 分钟`;
    if (value >= 1000) return `${Math.ceil(value / 1000)} 秒`;
    return `${Math.ceil(value)} ms`;
};

const formatObservabilityDuration = (milliseconds) => {
    const value = Math.max(0, Number(milliseconds) || 0);
    if (value >= 60000) return `${(value / 60000).toFixed(1)} min`;
    if (value >= 1000) return `${(value / 1000).toFixed(1)} s`;
    return `${Math.ceil(value)} ms`;
};

const observabilityTypeLabels = {
    model: '模型',
    sql: 'SQL',
    rag: '知识库',
    http: '接口',
    system: '系统'
};

const observabilitySeverityLabels = {
    info: '提示',
    warning: '预警',
    critical: '严重'
};

const formatHealthStatus = (status) => {
    if (status === 'ok') return '正常';
    if (status === 'degraded') return '需关注';
    if (status === 'error') return '异常';
    return '未知';
};

const formatMaintenanceTime = (value) => value ? formatDateToCN(value) : '尚未成功';

const describeEndpointMonitor = (monitor = {}) => {
    if (!monitor.configured) return '未配置健康探针';
    const latency = monitor.latencyMs !== null && monitor.latencyMs !== undefined
        ? ` · ${formatMetricNumber(monitor.latencyMs)} ms`
        : '';
    if (monitor.status === 'unreachable') return `探针不可达${latency}`;
    if (monitor.status === 'degraded') return `探针异常${latency}`;
    return `${monitor.status || 'ok'}${latency}`;
};

const ROUTE_NAME_MAP = {
    // 认证与授权
    '/api/auth/login': '用户登录验证',
    '/api/auth/register': '新用户注册',
    '/api/auth/me': '获取个人账户信息',
    '/api/auth/logout': '安全退出登录',
    '/api/auth/keys': 'API 密钥管理',
    '/api/auth/config': '获取认证配置',
    '/api/auth/refresh': '刷新身份令牌',
    
    // 对话核心
    '/api/chat': 'AI 对话请求',
    '/api/chat/completions': 'AI 对话流式补全',
    '/api/sessions': '会话列表管理',
    '/api/sessions/tags/list': '获取会话标签汇总',
    '/api/sessions/search/content': '全局消息全文搜索',
    '/api/sessions/:id': '获取/更新指定会话',
    '/api/sessions/:id/export': '导出对话记录 CSV',
    '/api/sessions/:id/pin': '置顶/取消置顶会话',
    '/api/sessions/:id/archive': '归档/恢复会话记录',
    '/api/sessions/:id/tags': '批量更新会话标签',
    '/api/sessions/:id/system-prompt': '设置会话系统提示词',
    '/api/messages': '获取历史消息流水',
    '/api/messages/:id': '物理删除单条消息',
    '/api/chat/title': '智能生成会话标题',
    '/api/chat/clear': '清空对话历史',
    
    // 用量与报表
    '/api/stats/usage': '个人用量统计',
    '/api/stats/details': '个人用量明细',
    '/api/stats/trend': '个人用量趋势',
    '/api/stats/report': '报表分析数据',
    '/api/stats/report/export': '导出审计报表 CSV',
    '/api/stats/monitor-summary': '系统实时监控数据',
    '/api/stats/ops-summary': '运营后台汇总数据',
    
    // 管理员专享
    '/api/admin/users': '全站用户账号管理',
    '/api/admin/users/export': '导出全站用户 CSV',
    '/api/admin/users/import': '批量导入用户数据',
    '/api/admin/users/:id': '更新/删除指定用户',
    '/api/admin/users/:id/password': '管理员重置用户密码',
    '/api/admin/logs': '全量审计日志检索',
    '/api/admin/logs/export': '导出全量审计 CSV',
    '/api/stats/admin/usage': '全局多维度用量汇总',
    '/api/stats/admin/details': '全站消息流监控流水',
    '/api/stats/admin/trend': '全站每日流量趋势',
    
    // 模型管理
    '/api/models': '模型列表获取与增删',
    '/api/models/test': '端点连接稳定性测试',
    '/api/models/fetch-remote': '远程模型列表探测',
    '/api/models/:id': '更新/删除指定模型',
    '/api/models/:id/key': '解密查看模型密钥',
    
    // 附件与文件
    '/api/upload': '附件文件上传',
    '/api/attachments': '获取附件资源列表',
    '/api/attachments/:id': '附件资源读取/下载',
    
    // RAG 知识库
    '/api/rag/knowledge': '知识库文档管理',
    '/api/rag/query': '知识库语义检索测试',
    '/api/rag/status': 'RAG 引擎状态检测',
    
    // OpenAI 兼容网关 (v1)
    '/v1/chat/completions': 'OpenAI 接口兼容补全',
    '/v1/models': 'OpenAI 兼容模型列表',
    
    // 系统配置与健康
    '/api/health': '服务健康状态检测',
    '/api/metrics': '监控指标导出 (Prometheus)',
    '/api/settings': '系统与个人基础设置',
    '/api/admin/settings': '修改系统全局策略',
    '/api/settings/password': '用户自主修改密码',
    '/api/settings/default-model': '设置个人默认模型',
    '/api/settings/rag': 'RAG 检索增强参数配置',
    
    // 核心静态资源
    '/': '系统主入口',
    '/chat': '对话主界面',
    '/chat/': '对话主界面',
    '/chat.html': '对话主界面',
    '/chat/chat.html': '对话主界面',
    '/chat/config.js': '前端基础配置脚本',
    '/chat/ui.js': '界面交互逻辑脚本',
    '/chat/auth.js': '前端认证逻辑脚本',
    '/chat/admin.js': '管理后台逻辑脚本',
    '/chat/admin-settings.js': '管理员设置脚本',
    '/chat/admin-memory-ui.js': '长期记忆界面交互与浮层提示脚本',
    '/stats.js': '统计分析核心脚本',
    '/chat/render.js': '消息渲染逻辑脚本',
    '/chat/render-charts.js': '图表渲染脚本',
    '/chat/render-messages.js': '消息内容渲染脚本',
    '/chat/message-virtualizer.js': '长会话消息虚拟滚动脚本',
    '/chat/engine.js': '对话引擎逻辑脚本',
    '/chat/engine-streaming.js': '对话流式处理脚本',
    '/chat/engine-attachments.js': '对话附件处理脚本',
    '/chat/engine-mcp-tools.js': '对话 MCP 工具脚本',
    '/chat/engine-sessions.js': '会话引擎脚本',
    '/chat/engine-default-model.js': '默认模型保存脚本',
    '/chat/sidebar.js': '侧边栏逻辑脚本',
    '/chat/sidebar-search.js': '侧边栏搜索脚本',
    '/chat/app.js': '程序主入口脚本',
    '/chat/app-workspaces.js': '工作区切换脚本',
    '/chat/apps-workbench-core.js': '应用中心工作区脚本（核心/状态）',
    '/chat/apps-workbench-editor.js': '应用中心工作区脚本（编辑/版式）',
    '/chat/apps-workbench-proofread.js': '应用中心工作区脚本（校对/导出）',
    '/chat/apps-workbench-ai.js': '应用中心工作区脚本（AI 调用）',
    '/chat/apps-workbench-rewrite.js': '应用中心工作区脚本（流式改写）',
    '/chat/apps-workbench-export.js': '应用中心工作区脚本（导出 DOCX/MD/PDF）',
    '/chat/apps-workbench-rag.js': '应用中心工作区脚本（知识库检索/入口）',
    '/chat/apps-workbench-data-analysis.js': '应用中心工作区脚本（数据分析）',
    '/chat/announcements-admin.js': '公告管理脚本',
    '/chat/models-actions.js': '模型管理动作脚本',
    '/chat/dag-core.js': 'DAG 基础脚本',
    '/chat/dag-render.js': 'DAG 渲染脚本',
    '/chat/dag-interaction.js': 'DAG 交互脚本',
    '/chat/dag-toolbar-tools.js': 'DAG 工具元数据脚本',
    '/chat/dag-toolbar-db.js': 'DAG 数据库辅助脚本',
    '/chat/dag-toolbar.js': 'DAG 工具栏脚本',
    '/chat/dag-toolbar-field-overrides.js': 'DAG 字段覆盖脚本',
    '/chat/dag-toolbar-fields.js': 'DAG 字段辅助脚本',
    '/chat/dag-wizard-db.js': 'DAG 向导数据库脚本',
    '/chat/dag-query-builder.js': 'DAG 可视化查询脚本',
    '/chat/dag-wizard-input.js': 'DAG 向导输入脚本',
    '/chat/dag-wizard-fields.js': 'DAG 向导字段脚本',
    '/chat/dag-wizard-stats.js': 'DAG 向导统计脚本',
    '/chat/dag-wizard.js': 'DAG 向导主脚本',
    '/chat/dag-inspector.js': 'DAG 检查器脚本',
    '/chat/agent-workflow-library.js': '工作流库脚本',
    '/chat/agent-workflow-versions.js': '工作流版本脚本',
    '/chat/agent-workflow-editor.js': '工作流编辑桥接脚本',
    '/chat/agent-workflow-core.js': '工作流状态与抽屉脚本',
    '/chat/agent-workflow-runners.js': '工作流运行与发布脚本',
    '/chat/agent-workflows.js': '工作流工作台入口脚本',
    '/chat/agent-workflow-schedules.js': '工作流计划任务脚本',
    '/chat/agent-run-renderers.js': '智能体运行渲染脚本',
    '/chat/agent-run-utils.js': '智能体运行工具脚本',
    '/chat/agent-run-tool-labels.js': '智能体工具标签脚本',
    '/chat/agent-run-step-renderers.js': '智能体步骤渲染脚本',
    '/chat/agent-run-visuals.js': '智能体可视化脚本',
    '/chat/agent-run-loaders.js': '智能体运行加载脚本',
    '/chat/agent-run-detail.js': '智能体运行详情脚本',
    '/chat/agent-run-realtime.js': '智能体实时刷新脚本',
    '/chat/agent-run-actions.js': '智能体运行操作脚本',
    '/chat/agent-runs-list.js': '智能体运行列表脚本',
    '/chat/agent-templates.js': '智能体模板脚本',
    '/chat/agent-schedules.js': '智能体计划任务脚本',
    '/chat/agent-artifacts.js': '智能体产物脚本',
    '/chat/mcp-workbench-common.js': 'MCP 工作台通用脚本',
    '/chat/mcp-workbench-local-auth.js': 'MCP 本机授权中心脚本',
    '/chat/mcp-workbench-form.js': 'MCP 工作台表单脚本',
    '/chat/mcp-workbench-main.js': 'MCP 工作台主脚本',
    '/chat/rag-format.js': 'RAG 格式脚本',
    '/chat/rag-graph-layout.js': 'RAG 图布局脚本',
    '/chat/rag-graph-render.js': 'RAG 图渲染脚本',
    '/chat/rag-graph-ui.js': 'RAG 图交互脚本',
    '/chat/rag-graph-controller.js': 'RAG 图控制脚本',
    '/chat/rag-documents-panels.js': 'RAG 文档面板脚本',
    '/chat/rag-documents.js': 'RAG 文档脚本',
    '/chat/stats-monitor-utils.js': '监控页辅助脚本',
    '/chat/stats-monitor.js': '监控页主脚本',
    '/chat/styles/core.css': '聊天基础样式入口',
    '/chat/styles/admin.css': '管理后台样式入口',
    '/chat/styles/stats-monitor.css': '监控页样式入口',
    '/chat/styles/workspaces.css': '工作区样式入口',
    '/chat/styles/workspaces/apps.css': '应用中心工作区样式',
    '/chat/styles/workspaces/agent.css': '智能体工作区样式入口',
    '/chat/styles/workspaces/mcp.css': 'MCP 工作区样式入口',
    '/chat/styles/sessions-prompts.css': '会话与工作区样式入口',
    '/chat.css': '界面主样式表',
    '/common/styles/theme.css': '全局主题样式',
    '/common/styles/layout.css': '通用布局样式',
    '/chat/chat.css': '对话模块专属样式'
};

function describeMonitorRoute(routePath) {
    const raw = String(routePath || '').trim();
    if (!raw) return '';
    const key = raw.split('?')[0].trim().toLowerCase();
    const normalizedKey = key.length > 1 ? key.replace(/\/+$/, '') : key;
    const htmlNormalizedKey = normalizedKey.endsWith('.html') ? normalizedKey.replace(/\.html$/, '') : normalizedKey;
    const direct = ROUTE_NAME_MAP[key] || ROUTE_NAME_MAP[normalizedKey] || ROUTE_NAME_MAP[htmlNormalizedKey] || ROUTE_NAME_MAP[raw.toLowerCase()];
    if (direct) return direct;
    if (key.startsWith('/common/vendor/')) return '第三方组件库资源';
    if (key.startsWith('/uploads/')) return '用户上传附件流';
    if (key.startsWith('/chat/styles/') && key.endsWith('.css')) return `聊天样式 · ${raw.replace(/^\/chat\/styles\//i, '')}`;
    if (key.startsWith('/chat/') && key.endsWith('.js')) return `聊天脚本 · ${raw.replace(/^\/chat\//i, '')}`;
    if (key.startsWith('/chat/') && key.endsWith('.css')) return `聊天样式 · ${raw.replace(/^\/chat\//i, '')}`;
    if (key.startsWith('/common/styles/') && key.endsWith('.css')) return `公共样式 · ${raw.replace(/^\/common\/styles\//i, '')}`;
    return raw;
}

