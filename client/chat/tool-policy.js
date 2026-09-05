// 管理员工具策略页
const toolPolicyEscape = (value) => escapeHtml(value === undefined || value === null ? '' : String(value));
const TOOL_POLICY_PAGE_SIZE = 18;
let toolPolicyPackagesCache = [];
let toolPolicyToolsCache = [];
let toolPolicySelectedPackageKey = '';
let toolPolicySelectedToolKey = '';

const TOOL_POLICY_KNOWN_TITLES = {
    // 数据处理
    'data.profile_rows': '数据画像分析',
    'data.filter_rows': '筛选表格行',
    'data.group_summary': '分组汇总数据',
    'data.normalize_fields': '标准化字段',
    // 文档解析
    'doc.extract_outline': '提取文档大纲',
    'doc.extract_key_values': '提取关键信息',
    'doc.chunk_text': '切分文档文本',
    // 格式转换
    'format.to_markdown_table': '转换 Markdown 表格',
    'format.to_json': '转换 JSON',
    'format.extract_json': '提取 JSON',
    'format.normalize_text': '规范化文本',
    // 报表与数据文件
    'reports.list_files': '查找报表文件',
    'reports.read_file_summary': '读取报表摘要',
    'reports.query_table': '查询表格数据',
    'reports.compare_files': '对比数据文件',
    // 本机浏览器连接器
    'browser.open': '打开本机浏览器页面',
    'browser.inspect': '读取本机网页内容',
    'browser.click': '点击本机网页元素',
    'browser.screenshot': '截取本机网页',
    // 可视化与报告编排
    'viz.build_chart': '生成图表',
    'viz.build_table': '表格展示',
    'report.compose': '报告编排',
    'report.validate_template': '校验报告模板',
    // 局域网消息通知
    'im.list_allowed_targets': '查看通知目标',
    'im.send_user_message': '发送用户消息',
    'im.send_group_message': '发送群组消息',
    'im.send_markdown': '发送 Markdown 消息',
    // 数据库连接
    'db.list_tables': '列出数据表',
    'db.count_tables': '统计数据表数量',
    'db.describe_table': '查看表结构',
    'db.run_readonly_query': '执行只读 SQL',
    'db.group_count': '分组统计',
    'db.list_collections': '列出集合',
    'db.count_collections': '统计集合数量',
    'db.sample_collection': '读取集合样本',
    'db.aggregate': '执行聚合分析',
    // 智能体与工作流内置工具
    'agent.llm': '大模型节点',
    'agent.content_review': '富文本内容校对',
    'agent.delegate': '委派智能体',
    'agent.handoff': '智能体交接',
    'agent.code': '代码执行',
    'agent.http': 'HTTP 请求',
    'agent.browser': '浏览器自动化',
    'agent.merge': '变量聚合',
    'workflow.input': '工作流输入',
    'workflow.output': '工作流输出',
    'workflow.condition': '条件路由',
    'workflow.approval': '人工审批',
    'workflow.foreach': '循环 / 批处理',
    'workflow.subworkflow': '子工作流',
    'workflow.delay': '延时',
    'system.health': '系统健康',
    'system.modelRuntime': '模型运行状态',
    'rag.search': '知识库检索',
    'knowledge.list': '知识库文档',
    'knowledge.graph.query': '知识图谱查询',
    'sessions.search': '会话检索',
    'sessions.recent': '最近会话'
};

const TOOL_POLICY_KNOWN_DESCRIPTIONS = {
    // 数据处理
    'data.profile_rows': '分析表格数据行结构，生成字段名、类型分布、填充率及样本值画像。',
    'data.filter_rows': '使用精确匹配或包含匹配规则筛选表格数据行。',
    'data.group_summary': '按指定字段对表格行分组，并计算计数、求和、均值、最小值或最大值。',
    'data.normalize_fields': '重命名表格字段名称并去除字符串首尾空白字符。',
    // 文档解析
    'doc.extract_outline': '从纯文本或 Markdown 内容中轻量提取标题层级与大纲结构。',
    'doc.extract_key_values': '从文档文本中提取键值对风格的关键信息条目。',
    'doc.chunk_text': '按段落感知将长文本智能切分为适合下游分析的文本分块。',
    // 格式转换
    'format.to_markdown_table': '将数据行数组转换为标准 Markdown 表格块。',
    'format.to_json': '将输入值序列化为紧凑或美化格式的 JSON 字符串。',
    'format.extract_json': '从非结构化文本中查找并解析第一个有效 JSON 对象或数组。',
    'format.normalize_text': '规范化文本中的空白字符，并可选转换为指定的大小写模式。',
    // 报表与数据文件
    'reports.list_files': '列出配置目录下可访问的报表与数据文件。',
    'reports.read_file_summary': '读取单个报表/数据文件的元数据、工作表列表和样本行。',
    'reports.query_table': '按列筛选并限制行数，查询 CSV/XLS/XLSX 表格数据。',
    'reports.compare_files': '对比两个报表/数据文件的工作表、表头和样本行。',
    // 本机浏览器连接器
    'browser.open': '在当前设备已授权的隔离浏览器中打开页面，用户可自行完成登录，不读取日常浏览器凭据。',
    'browser.inspect': '在当前设备已授权的隔离浏览器中读取标题和受限正文文本。',
    'browser.click': '在当前设备已授权的隔离浏览器中点击目标元素；桌面端会在执行前请求用户确认。',
    'browser.screenshot': '在当前设备已授权的隔离浏览器中截取当前页面；桌面端会在回传前请求用户确认。',
    // 可视化与报告编排
    'viz.build_chart': '基于传入的表格行生成可直接渲染的统计图表配置。',
    'viz.build_table': '基于输入表格行生成可直接显示的 Markdown 表格。',
    'report.compose': '将摘要、表格、图表、指标和 Markdown 片段组合为固定格式报告。',
    'report.validate_template': '在执行多步骤编排前提前验证报告模板与章节定义的有效性。',
    // 局域网消息通知
    'im.list_allowed_targets': '列出当前允许通知的 LAN IM 目标。',
    'im.send_user_message': '向一个允许的 LAN IM 用户发送纯文本消息。',
    'im.send_group_message': '向一个允许的 LAN IM 群组发送纯文本消息。',
    'im.send_markdown': '向一个允许的 LAN IM 目标发送 Markdown 消息。',
    // 数据库连接
    'db.list_tables': '列出当前数据库中可查询的表和视图。',
    'db.count_tables': '统计当前数据库中可查询的数据表和视图数量。',
    'db.describe_table': '查看表字段、类型和可空性，辅助模型生成安全 SQL。',
    'db.run_readonly_query': '执行只读 SQL 查询，仅允许 SELECT 等安全查询并限制返回行数。',
    'db.group_count': '按指定表字段分组并统计数量，系统自动生成安全只读 SQL。',
    'db.list_collections': '列出 MongoDB 数据库中的集合。',
    'db.count_collections': '统计 MongoDB 数据库中的集合数量。',
    'db.sample_collection': '读取 MongoDB 集合的小样本，辅助理解字段结构。',
    'db.aggregate': '执行 MongoDB 聚合管道，用于只读统计分析。',
    // 智能体与工作流内置工具
    'agent.llm': '在工作流中调用指定大模型，对上游结果进行分析、改写、抽取或生成内容。',
    'agent.content_review': '清洗数据库富文本记录，按模型上下文预算逐条分块校对，并生成结构化结果和完整任务产物。',
    'agent.delegate': '调用一次独立模型运行具名专家，返回专家结果并自动附带结构化 Handoff。',
    'agent.handoff': '把已有结论、证据、风险和待决问题整理为结构化 Handoff。',
    'agent.code': '需要独立受控 Worker 沙箱；服务端不会直接执行 JavaScript。',
    'agent.http': '调用外部 REST API 并返回状态码与响应数据。',
    'agent.browser': '在独立浏览器 Profile 中访问白名单页面并执行受控 DOM/视觉定位操作，禁止读取凭证。',
    'agent.merge': '把多个上游节点的输出合并成一个对象，便于下游统一引用。',
    'workflow.input': '声明并读取运行参数，支持必填校验、默认值和基础类型转换。',
    'workflow.output': '声明工作流最终输出，便于调用方按名称读取交付结果。',
    'workflow.condition': '比较输入值并返回 matched 与 route，供下游 when 条件引用。',
    'workflow.approval': '暂停工作流等待指定用户或部门审批，支持多级串签、超时策略和 IM 回调。',
    'workflow.foreach': '需要独立受控 Worker 沙箱；服务端不会直接执行循环代码。',
    'workflow.subworkflow': '调用另一个已发布工作流；运行时限制递归深度并阻止循环调用。',
    'workflow.delay': '挂起工作流到指定时间后继续，最长 30 天，不占用运行槽。',
    'system.health': '返回当前速率、存储、内存和路由健康状态。',
    'system.modelRuntime': '返回模型端点队列、熔断器和监控状态。',
    'rag.search': '检索当前用户的知识库，返回按相关度排序的片段和来源文档。',
    'knowledge.list': '列出当前用户的知识库文档及索引状态。',
    'knowledge.graph.query': '按问题查询当前用户知识图谱中的实体、关系路径和来源文档。',
    'sessions.search': '按关键词检索当前用户的历史会话内容。',
    'sessions.recent': '列出当前用户最近的未删除会话。'
};

function toolPolicyTypeLabel(type) {
    if (type === 'builtin_tool') return '系统工具';
    if (type === 'database_connection') return '数据库连接';
    if (type === 'mcp_server') return '工具服务';
    return '工具包';
}

function toolPolicyRiskLabel(level) {
    if (level === 'low') return '低风险';
    if (level === 'high') return '高风险';
    return '中风险';
}

function toolPolicyCanEditPackage(item) {
    if (!item) return false;
    return isSuperAdminUser();
}

function toolPolicyIsGlobalPackage(item) {
    return item && !item.user_id && (item.scope === 'global' || item.scope === 'admin');
}

function toolPolicySelectedPackage() {
    return toolPolicyPackagesCache.find(item => item.package_key === toolPolicySelectedPackageKey) || null;
}

function toolPolicyToolName(tool) {
    return tool?.name || tool?.fullName || '';
}

function toolPolicyToolTitle(tool) {
    const rawName = toolPolicyToolName(tool);
    const shortName = rawName.replace(/^mcp\.\d+\./, '');
    if (tool?.title && tool.title !== rawName && tool.title !== shortName && !/^[a-zA-Z0-9_.-]+$/.test(tool.title)) {
        return tool.title;
    }
    return TOOL_POLICY_KNOWN_TITLES[shortName] || TOOL_POLICY_KNOWN_TITLES[rawName] || tool?.title || rawName;
}

function toolPolicyToolDescription(tool) {
    const rawName = toolPolicyToolName(tool);
    const shortName = rawName.replace(/^mcp\.\d+\./, '');
    const knownDesc = TOOL_POLICY_KNOWN_DESCRIPTIONS[shortName] || TOOL_POLICY_KNOWN_DESCRIPTIONS[rawName];
    const desc = String(tool?.description || '').trim();
    if (knownDesc) {
        if (!desc || desc === rawName || desc === shortName || /^Profile|Filter|Group|Rename|Extract|Split|Convert|Serialize|Normalize/i.test(desc)) {
            return knownDesc;
        }
    }
    if (tool?.stale) return '已保存策略，当前工具缓存中未找到该工具。';
    return desc || knownDesc || toolPolicyToolTitle(tool) || rawName;
}

function toolPolicyEntryKey(item, tool) {
    return `${item?.package_key || ''}::${toolPolicyToolName(tool)}`;
}

function toolPolicyEntryByKey(key) {
    return toolPolicyToolsCache.find(entry => entry.key === key) || null;
}

function toolPolicySelectedToolEntry() {
    return toolPolicyEntryByKey(toolPolicySelectedToolKey);
}

function toolPolicyGovernance(tool) {
    return tool?.governance || {};
}

function toolPolicyToolPayload(tool, patch = {}) {
    const governance = toolPolicyGovernance(tool);
    return {
        enabled: governance.enabled !== false,
        riskLevel: governance.riskLevel || 'medium',
        approvalRequired: Boolean(governance.approvalRequired),
        usage: governance.usage || '',
        ...patch
    };
}

function renderToolPolicyMessage(message, options = {}) {
    const body = document.getElementById('tool-policy-tool-body');
    const pagination = document.getElementById('pagination-tool-policy');
    if (!body) return;
    if (pagination) pagination.replaceChildren();
    body.className = 'tool-policy-tool-grid has-message';
    PivotSafeHtml.setHtml(body, `
        <div class="tool-policy-empty${options.error ? ' is-error' : ''}">
            ${toolPolicyEscape(message)}
        </div>
    `);
}

function updateToolPolicyCount() {
    const count = document.getElementById('tool-policy-tool-count');
    if (count) count.textContent = `${toolPolicyToolsCache.length} 个工具`;
}

function toolPolicyCurrentPage() {
    const page = typeof pageState === 'undefined' ? 1 : Number.parseInt(pageState['tool-policy'], 10);
    return Number.isFinite(page) && page > 0 ? page : 1;
}

function setToolPolicyPage(page) {
    if (typeof pageState !== 'undefined') {
        pageState['tool-policy'] = page;
    }
}

function toolPolicyPageEntries() {
    const totalPages = Math.max(Math.ceil(toolPolicyToolsCache.length / TOOL_POLICY_PAGE_SIZE), 1);
    const page = Math.min(toolPolicyCurrentPage(), totalPages);
    setToolPolicyPage(page);
    const start = (page - 1) * TOOL_POLICY_PAGE_SIZE;
    return {
        entries: toolPolicyToolsCache.slice(start, start + TOOL_POLICY_PAGE_SIZE),
        page
    };
}

function renderToolPolicyPagination(page) {
    const container = document.getElementById('pagination-tool-policy');
    if (!container) return;
    container.replaceChildren();
    const total = toolPolicyToolsCache.length;
    const totalPages = Math.ceil(total / TOOL_POLICY_PAGE_SIZE);
    if (totalPages <= 1) return;

    const createButton = (label, targetPage, disabled) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn-secondary';
        button.disabled = disabled;
        button.dataset.paginationTab = 'tool-policy';
        button.dataset.paginationPage = String(targetPage);
        button.textContent = label;
        return button;
    };

    const summary = document.createElement('span');
    summary.style.margin = '0 15px';
    summary.style.fontWeight = '500';
    summary.textContent = `第 ${page} / ${totalPages} 页 (共 ${total} 条)`;

    container.append(
        createButton('首页', 1, page === 1),
        createButton('上一页', page - 1, page === 1),
        summary,
        createButton('下一页', page + 1, page === totalPages),
        createButton('末页', totalPages, page === totalPages)
    );
}

function renderToolPolicyGovernancePanel(entry = null) {
    const panel = document.getElementById('tool-policy-governance-panel');
    const shell = document.getElementById('tool-policy-tool-shell');
    if (!panel) return;
    const open = Boolean(entry?.tool && entry?.item);
    if (shell) shell.classList.toggle('has-governance-open', open);
    if (!open) {
        panel.hidden = true;
        PivotSafeHtml.setHtml(panel, '');
        return;
    }
    const { item, tool, key } = entry;
    const editable = toolPolicyCanEditPackage(item);
    const governance = toolPolicyGovernance(tool);
    const riskLevel = governance.riskLevel || 'medium';
    const approvalRequired = Boolean(governance.approvalRequired);
    const name = toolPolicyToolName(tool);
    const title = toolPolicyToolTitle(tool);
    panel.hidden = false;
    PivotSafeHtml.setHtml(panel, `
        <div class="tool-policy-governance-head">
            <div>
                <strong>${toolPolicyEscape(title)}</strong>
                <small title="${toolPolicyEscape(name)}">${toolPolicyEscape(toolPolicyTypeLabel(item.type))} · ${toolPolicyEscape(item.name || item.package_key)}</small>
            </div>
        </div>
        <div class="tool-policy-governance-body">
            <label class="tool-policy-form-field">
                <span>风险等级</span>
                <select class="form-input" data-tool-policy-risk="${toolPolicyEscape(key)}" ${editable ? '' : 'disabled'}>
                    <option value="low" ${riskLevel === 'low' ? 'selected' : ''}>低风险</option>
                    <option value="medium" ${riskLevel === 'medium' ? 'selected' : ''}>中风险</option>
                    <option value="high" ${riskLevel === 'high' ? 'selected' : ''}>高风险</option>
                </select>
            </label>
            <label class="tool-policy-switch-row${editable ? '' : ' is-readonly'}">
                <span>
                    <strong>审批要求</strong>
                    <small>${approvalRequired ? '调用前需要审批' : '无需额外审批'}</small>
                </span>
                <span class="tool-policy-switch-control">
                    <input type="checkbox" data-tool-policy-approval="${toolPolicyEscape(key)}" ${approvalRequired ? 'checked' : ''} ${editable ? '' : 'disabled'}>
                    <span class="tool-policy-switch-track"></span>
                </span>
            </label>
            <label class="tool-policy-form-field">
                <span>适用说明</span>
                <textarea class="form-input" rows="4" data-tool-policy-usage="${toolPolicyEscape(key)}" placeholder="${toolPolicyEscape(toolPolicyRiskLabel(riskLevel))}" ${editable ? '' : 'disabled'}>${toolPolicyEscape(governance.usage || '')}</textarea>
            </label>
            <div class="tool-policy-governance-actions">
                <button type="button" class="btn-secondary" data-tool-policy-close>取消</button>
                <button type="button" class="btn-primary tool-policy-save-governance" data-tool-policy-save="${toolPolicyEscape(key)}" ${editable ? '' : 'disabled'}>保存</button>
            </div>
        </div>
    `);
    panel.querySelector('[data-tool-policy-close]')?.addEventListener('click', () => window.closeToolPolicyGovernancePanel());
    panel.querySelector('[data-tool-policy-save]')?.addEventListener('click', event => window.saveToolPolicyTool(event.currentTarget));
}

function renderToolPolicyTools() {
    const body = document.getElementById('tool-policy-tool-body');
    if (!body) return;
    updateToolPolicyCount();
    const { entries, page } = toolPolicyPageEntries();
    renderToolPolicyPagination(page);
    if (!toolPolicyToolsCache.length) {
        toolPolicySelectedToolKey = '';
        renderToolPolicyMessage(toolPolicyPackagesCache.length ? '暂无可治理工具，请先在工具库刷新工具列表。' : '暂无全局工具包');
        renderToolPolicyGovernancePanel(null);
        return;
    }
    if (toolPolicySelectedToolKey && !toolPolicySelectedToolEntry()) {
        toolPolicySelectedToolKey = '';
    }
    body.className = 'tool-policy-tool-grid';
    PivotSafeHtml.setHtml(body, entries.map(entry => {
        const { item, tool, key } = entry;
        const editable = toolPolicyCanEditPackage(item);
        const governance = toolPolicyGovernance(tool);
        const enabled = governance.enabled !== false;
        const packageEnabled = item.enabled !== false;
        const riskLevel = governance.riskLevel || 'medium';
        const approvalRequired = Boolean(governance.approvalRequired);
        const name = toolPolicyToolName(tool);
        const title = toolPolicyToolTitle(tool);
        const desc = toolPolicyToolDescription(tool);
        const active = key === toolPolicySelectedToolKey;
        return `
            <article class="tool-policy-tool-card${active ? ' active' : ''}${enabled && packageEnabled ? ' is-enabled' : ' is-disabled'}${tool.stale ? ' is-stale' : ''}">
                <header class="tool-policy-tool-card-head">
                    <div class="tool-policy-tool-title">
                        <strong title="${toolPolicyEscape(title)}">${toolPolicyEscape(title)}</strong>
                        <em title="${toolPolicyEscape(item.name || item.package_key)}">${toolPolicyEscape(toolPolicyTypeLabel(item.type))}</em>
                    </div>
                    <button class="tool-policy-status-toggle${enabled && packageEnabled ? ' is-on' : ''}" type="button" data-tool-policy-toggle="${toolPolicyEscape(key)}" data-next-enabled="${enabled && packageEnabled ? 'false' : 'true'}" aria-label="${enabled && packageEnabled ? '停用工具' : '启用工具'}" title="${enabled && packageEnabled ? '停用工具' : '启用工具'}" ${editable ? '' : 'disabled'}>
                        <span></span>
                    </button>
                </header>
                <p>${toolPolicyEscape(desc)}</p>
                <div class="tool-policy-card-meta" title="${toolPolicyEscape(name)}">${toolPolicyEscape(name)}</div>
                <footer>
                    <span class="tool-policy-chip risk-${toolPolicyEscape(riskLevel)}">${toolPolicyEscape(toolPolicyRiskLabel(riskLevel))}</span>
                    <span class="tool-policy-chip${approvalRequired ? ' approval-on' : ''}">${approvalRequired ? '需审批' : '免审批'}</span>
                    ${packageEnabled ? '' : '<span class="tool-policy-chip package-off">包停用</span>'}
                    ${editable ? `<button type="button" class="btn-secondary" data-tool-policy-edit="${toolPolicyEscape(key)}">编辑</button>` : ''}
                </footer>
            </article>
        `;
    }).join(''));
    body.querySelectorAll('[data-tool-policy-edit]').forEach(button => {
        button.addEventListener('click', () => window.openToolPolicyGovernancePanel(button.dataset.toolPolicyEdit));
    });
    body.querySelectorAll('[data-tool-policy-toggle]').forEach(button => {
        button.addEventListener('click', () => window.toggleToolPolicyToolStatus(button));
    });
    renderToolPolicyGovernancePanel(toolPolicySelectedToolEntry());
}

function toolPolicyField(key, attr) {
    const escaped = window.CSS?.escape ? CSS.escape(key) : String(key || '').replace(/["\\]/g, '\\$&');
    return document.querySelector(`[${attr}="${escaped}"]`);
}

async function saveToolPolicyPackageEnabled(packageKey, enabled) {
    const res = await apiFetch(`${API_BASE}/capabilities/packages/${encodeURIComponent(packageKey)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '工具包状态保存失败');
    return data.item || null;
}

async function saveToolPolicyGovernance(entry, payload) {
    if (payload.enabled && entry.item.enabled === false) {
        await saveToolPolicyPackageEnabled(entry.item.package_key, true);
    }
    const toolName = toolPolicyToolName(entry.tool);
    const res = await apiFetch(`${API_BASE}/capabilities/packages/${encodeURIComponent(entry.item.package_key)}/tools/${encodeURIComponent(toolName)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '工具策略保存失败');
    return data.item || null;
}

async function loadToolPolicyToolsForPackage(item) {
    const res = await apiFetch(`${API_BASE}/capabilities/packages/${encodeURIComponent(item.package_key)}/tools`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '工具列表加载失败');
    const packageItem = data.item || item;
    return (data.tools || []).map(tool => ({
        key: toolPolicyEntryKey(packageItem, tool),
        item: packageItem,
        tool
    }));
}

window.loadToolPolicy = async function(options = {}) {
    if (!isAdminUser()) return;
    if (!options.forceReload && toolPolicyToolsCache.length) {
        if (!options.preserveSelection) {
            toolPolicySelectedToolKey = '';
            toolPolicySelectedPackageKey = '';
        }
        renderToolPolicyTools();
        return;
    }
    renderToolPolicyMessage('正在加载工具策略...');
    const res = await apiFetch(`${API_BASE}/capabilities/packages?include_tools=true`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        renderToolPolicyMessage(data.error || '工具策略加载失败', { error: true });
        return showToast(data.error || '工具策略加载失败', 'error');
    }
    const previousToolKey = options.preserveSelection ? toolPolicySelectedToolKey : '';
    toolPolicyPackagesCache = (data.data || []).filter(toolPolicyIsGlobalPackage);
    toolPolicyToolsCache = toolPolicyPackagesCache.flatMap(packageItem => {
        return (packageItem.tools || []).map(tool => ({
            key: toolPolicyEntryKey(packageItem, tool),
            item: packageItem,
            tool
        }));
    });
    toolPolicySelectedToolKey = toolPolicyToolsCache.some(entry => entry.key === previousToolKey) ? previousToolKey : '';
    const selected = toolPolicySelectedToolEntry();
    toolPolicySelectedPackageKey = selected?.item?.package_key || '';
    renderToolPolicyTools();
};

window.openToolPolicyGovernancePanel = function(entryKey) {
    const entry = toolPolicyEntryByKey(entryKey);
    toolPolicySelectedToolKey = entry?.key || '';
    toolPolicySelectedPackageKey = entry?.item?.package_key || '';
    renderToolPolicyTools();
};

window.closeToolPolicyGovernancePanel = function() {
    toolPolicySelectedToolKey = '';
    toolPolicySelectedPackageKey = '';
    renderToolPolicyTools();
};

window.saveToolPolicyPackageStatus = async function(input) {
    const packageKey = input?.getAttribute?.('data-tool-policy-package-enabled') || input?.dataset?.toolPolicyPackageEnabled || '';
    if (!packageKey) return;
    const item = toolPolicyPackagesCache.find(row => row.package_key === packageKey);
    const nextEnabled = input.dataset.nextEnabled === 'true';
    input.disabled = true;
    try {
            await saveToolPolicyPackageEnabled(packageKey, nextEnabled);
            showToast(nextEnabled ? '工具包已启用' : '工具包已停用', 'success');
            await window.loadToolPolicy({ forceReload: true, preserveSelection: true });
    } catch (e) {
        showToast(e.message || '工具包状态保存失败', 'error');
    } finally {
        input.disabled = !toolPolicyCanEditPackage(item);
    }
};

window.toggleToolPolicyToolStatus = async function(button) {
    const entryKey = button?.dataset?.toolPolicyToggle || '';
    const entry = toolPolicyEntryByKey(entryKey);
    if (!entry) return;
    const nextEnabled = button.dataset.nextEnabled === 'true';
    button.disabled = true;
    try {
            await saveToolPolicyGovernance(entry, toolPolicyToolPayload(entry.tool, { enabled: nextEnabled }));
            showToast(nextEnabled ? '工具已启用' : '工具已停用', 'success');
            await window.loadToolPolicy({ forceReload: true, preserveSelection: true });
    } catch (e) {
        showToast(e.message || '工具状态保存失败', 'error');
    } finally {
        button.disabled = false;
    }
};

window.saveToolPolicyTool = async function(button) {
    const entryKey = button?.dataset?.toolPolicySave || '';
    const entry = toolPolicyEntryByKey(entryKey);
    if (!entry) return;
    const riskInput = toolPolicyField(entryKey, 'data-tool-policy-risk');
    const approvalInput = toolPolicyField(entryKey, 'data-tool-policy-approval');
    const usageInput = toolPolicyField(entryKey, 'data-tool-policy-usage');
    const payload = {
        enabled: toolPolicyGovernance(entry.tool).enabled !== false,
        riskLevel: riskInput?.value || 'medium',
        approvalRequired: approvalInput?.checked || false,
        usage: usageInput?.value || ''
    };
    const oldText = button.textContent;
    button.disabled = true;
    button.textContent = '保存中...';
    try {
        await saveToolPolicyGovernance(entry, payload);
        showToast('工具策略已保存', 'success');
        await window.loadToolPolicy({ forceReload: true, preserveSelection: true });
    } catch (e) {
        showToast(e.message || '工具策略保存失败', 'error');
    } finally {
        button.disabled = false;
        button.textContent = oldText || '保存';
    }
};

document.addEventListener('click', event => {
    const refresh = event.target.closest('#tool-policy-refresh-btn');
    if (!refresh) return;
    event.preventDefault();
    window.loadToolPolicy?.({ forceReload: true });
});
