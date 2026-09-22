/* 工具库产品目录、连接账户与运行治理视图。 */

(function installMcpProductWorkbench() {
    const escape = value => escapeHtml(value === undefined || value === null ? '' : String(value));
    const modalApi = () => window.Pivot?.moduleApi?.('mcp.modal', {}) || {};
    let describedTool = null;

    function empty(message) {
        return `<div class="mcp-product-empty">${escape(message)}</div>`;
    }

    function riskLabel(value) {
        const risk = String(value || 'low');
        return risk === 'critical' ? '严重风险' : risk === 'high' ? '高风险' : risk === 'medium' ? '中风险' : '低风险';
    }

    const CAPABILITY_LABEL_MAP = {
        'agent.execute': '工具执行',
        'agent.delegate': '委派子任务',
        'agent.review': '内容审查',
        'workflow.orchestrate': '工作流编排',
        'workflow.control': '工作流控制',
        'workflow.approval': '人工审批',
        'viz.render': '图表渲染',
        'system.observe': '系统观察',
        'filesystem.read': '文件读取',
        'filesystem.read_workspace': '工作区读取',
        'filesystem.write': '文件写入',
        'filesystem.write_workspace': '工作区写入',
        'code.execute': '代码执行',
        'code.python_execute': 'Python 执行',
        'code.sandbox_eval': '沙箱执行',
        'data.query': '数据查询',
        'data.duckdb.query': 'DuckDB 查询',
        'data.sql.query': '数据库查询',
        'data.dataset.read': '数据集读取',
        'network.request': '网络访问',
        'network.http_request': 'HTTP 请求',
        'network.web_search': '网页检索',
        'network.browser_visit': '浏览器访问',
        'media.image_generate': '图片生成',
        'media.text_to_speech': '语音合成',
        'knowledge.read': '知识库读取',
        'knowledge.search': '知识库检索',
        'knowledge.graph_query': '图谱查询',
        'model.invoke': '模型调用',
        'document.render': '文档渲染',
        'artifact.read': '产物读取',
        'artifact.deliver': '产物交付',
        'chat': '对话',
        'embeddings': '向量嵌入'
    };

    function capabilityBadgeLabel(cap = '') {
        const key = String(cap || '').trim();
        return CAPABILITY_LABEL_MAP[key] || key;
    }

    function sourceBadgeLabel(source = '') {
        const labels = {
            builtin: '系统工具',
            mcp: '工具服务',
            api_operation: 'API 操作',
            database: '数据库连接'
        };
        return labels[String(source || '')] || (source === 'builtin' ? '系统工具' : '工具服务');
    }

    function toolDisplayName(title = '', name = '') {
        let text = String(title || name || '').trim();
        if (!text) return '未命名工具';
        text = text
            .replace(/^Viz\s*MCP\s*/iu, '图表生成 ')
            .replace(/^Report\s*MCP\s*/iu, '报告编排 ')
            .replace(/^Documents\s*MCP\s*/iu, '文档解析 ')
            .replace(/^Data\s*MCP\s*/iu, '数据处理 ')
            .replace(/^Format\s*MCP\s*/iu, '格式转换 ')
            .replace(/\bMCP\b/gi, '服务')
            .replace(/\s+/g, ' ')
            .trim();

        const titleMap = {
            visualization: '图表生成',
            report: '报告编排',
            documents: '文档解析',
            data: '数据处理',
            format: '格式转换',
            im: '即时通信通知',
            reports: '服务器报表目录',
            database: '数据库连接',
            database_connection: '数据库连接',
            'browser.open': '打开本机浏览器页面',
            'browser.inspect': '读取本机网页内容',
            'browser.click': '点击本机网页元素',
            'browser.screenshot': '截取本机网页',
            'browser.navigate': '浏览器访问页面',
            'browser.extract_text': '网页内容提取',
            'code.python_execute': 'Python 脚本执行',
            'code.duckdb_query': 'DuckDB 高性能查询',
            'filesystem.read_workspace': '读取工作区文件',
            'filesystem.write_workspace': '写入工作区文件'
        };
        if (titleMap[text.toLowerCase()]) {
            text = titleMap[text.toLowerCase()];
        }
        return text;
    }

    function serverDisplayName(name = '') {
        let text = String(name || '').trim();
        if (!text) return '';
        text = text
            .replace(/^Viz\s*MCP\s*/iu, '图表生成 ')
            .replace(/^Report\s*MCP\s*/iu, '报告编排 ')
            .replace(/^Documents\s*MCP\s*/iu, '文档解析 ')
            .replace(/^Data\s*MCP\s*/iu, '数据处理 ')
            .replace(/^Format\s*MCP\s*/iu, '格式转换 ')
            .replace(/\bMCP\b/gi, '服务')
            .replace(/\s+/g, ' ')
            .trim();

        const map = {
            visualization: '图表服务',
            report: '报告服务',
            documents: '文档服务',
            data: '数据服务',
            format: '格式服务',
            im: '即时通信',
            reports: '报表服务',
            database: '数据库连接',
            builtin: '系统工具'
        };
        return map[text.toLowerCase()] || text;
    }

    function renderCatalog(items = []) {
        if (!items.length) return empty('暂无匹配的已授权工具。可修改关键词，或在下方添加工具服务。');
        return items.slice(0, 100).map(item => {
            const ref = item.toolRef || {};
            const toolName = item.name || ref.toolName || '';
            const capabilities = Array.isArray(item.capabilities) ? item.capabilities.slice(0, 3) : [];
            const displayTitle = toolDisplayName(item.title, toolName);
            const displayServer = serverDisplayName(item.serverName);
            return `
                <article class="mcp-product-card">
                    <div class="mcp-product-card-head">
                        <strong title="${escape(displayTitle)}">${escape(displayTitle)}</strong>
                        <em class="risk-${escape(item.riskLevel || 'low')}">${escape(riskLabel(item.riskLevel))}</em>
                    </div>
                    <p>${escape(item.description || '暂无工具说明。')}</p>
                    <div class="mcp-product-badges">
                        ${item.source ? `<span>${escape(sourceBadgeLabel(item.source))}</span>` : ''}
                        ${displayServer ? `<span>${escape(displayServer)}</span>` : ''}
                        ${item.requiresConnection ? '<span>需连接</span>' : ''}
                        ${item.requiresApproval || item.approvalRequired ? '<span>需审批</span>' : ''}
                        ${capabilities.map(capability => `<span title="${escape(capability)}">${escape(capabilityBadgeLabel(capability))}</span>`).join('')}
                    </div>
                    <div class="mcp-product-card-actions">
                        <button class="btn-secondary" type="button" data-mcp-product-describe="${escape(toolName)}" data-mcp-product-release="${escape(ref.releaseId || '')}" data-mcp-product-digest="${escape(ref.definitionDigest || '')}">查看契约</button>
                    </div>
                </article>
            `;
        }).join('');
    }

    function openCatalogModal() {
        const modal = document.getElementById('mcp-catalog-modal');
        if (!modal) return;
        const modalApi = window.Pivot?.moduleApi?.('mcp.modal');
        if (typeof modalApi?.setMcpModalVisibility === 'function') {
            modalApi.setMcpModalVisibility(modal, true, { focusSelector: '#mcp-product-tool-search' });
        } else {
            modal.classList.remove('hidden');
            modal.setAttribute('aria-hidden', 'false');
            modal.querySelector('#mcp-product-tool-search')?.focus();
        }
    }

    function closeCatalogModal() {
        const modal = document.getElementById('mcp-catalog-modal');
        if (!modal) return;
        const modalApi = window.Pivot?.moduleApi?.('mcp.modal');
        if (typeof modalApi?.setMcpModalVisibility === 'function') {
            modalApi.setMcpModalVisibility(modal, false);
        } else {
            modal.classList.add('hidden');
            modal.setAttribute('aria-hidden', 'true');
        }
    }

    function closeProductDetailModal() {
        const modal = document.getElementById('mcp-product-detail-modal');
        if (!modal) return;
        const modalApi = window.Pivot?.moduleApi?.('mcp.modal');
        if (typeof modalApi?.setMcpModalVisibility === 'function') {
            modalApi.setMcpModalVisibility(modal, false);
        } else {
            modal.classList.add('hidden');
            modal.setAttribute('aria-hidden', 'true');
        }
    }

    function generateSampleInput(inputSchema = {}) {
        const properties = (inputSchema && typeof inputSchema.properties === 'object' && inputSchema.properties !== null)
            ? inputSchema.properties
            : {};
        const sample = {};
        for (const [key, prop] of Object.entries(properties)) {
            if (!prop || typeof prop !== 'object') continue;
            if (prop.default !== undefined) {
                sample[key] = prop.default;
            } else if (Array.isArray(prop.enum) && prop.enum.length) {
                sample[key] = prop.enum[0];
            } else if (prop.type === 'string') {
                sample[key] = prop.description ? String(prop.description).slice(0, 16) : 'test';
            } else if (prop.type === 'number' || prop.type === 'integer') {
                sample[key] = prop.minimum !== undefined ? prop.minimum : 1;
            } else if (prop.type === 'boolean') {
                sample[key] = true;
            } else if (prop.type === 'array') {
                sample[key] = [];
            } else if (prop.type === 'object') {
                sample[key] = {};
            } else {
                sample[key] = '';
            }
        }
        return sample;
    }

    function renderParameterTable(inputSchema = {}) {
        const properties = (inputSchema && typeof inputSchema.properties === 'object' && inputSchema.properties !== null)
            ? inputSchema.properties
            : {};
        const requiredList = Array.isArray(inputSchema?.required) ? inputSchema.required : [];
        const keys = Object.keys(properties);

        if (!keys.length) {
            return '<div class="mcp-contract-no-params">该工具无需输入参数，可直接运行。</div>';
        }

        const rows = keys.map(key => {
            const prop = properties[key] || {};
            const isRequired = requiredList.includes(key);
            const type = prop.type || (Array.isArray(prop.enum) ? 'enum' : 'any');
            const desc = prop.description || prop.title || '暂无说明';
            const defaultValue = prop.default !== undefined ? JSON.stringify(prop.default) : '';
            const enumValues = Array.isArray(prop.enum) ? prop.enum.map(v => JSON.stringify(v)).join(', ') : '';

            return `
                <tr>
                    <td><code class="mcp-param-name">${escape(key)}</code></td>
                    <td>
                        ${isRequired
                            ? '<span class="mcp-param-tag mcp-param-required">必填</span>'
                            : '<span class="mcp-param-tag mcp-param-optional">选填</span>'}
                    </td>
                    <td><span class="mcp-param-type">${escape(type)}</span></td>
                    <td>
                        <div class="mcp-param-desc">${escape(desc)}</div>
                        ${defaultValue ? `<div class="mcp-param-extra">默认值：<code>${escape(defaultValue)}</code></div>` : ''}
                        ${enumValues ? `<div class="mcp-param-extra">可选值：<code>${escape(enumValues)}</code></div>` : ''}
                    </td>
                </tr>
            `;
        }).join('');

        return `
            <table class="data-table mcp-params-table">
                <thead>
                    <tr>
                        <th>参数名称</th>
                        <th>状态</th>
                        <th>类型</th>
                        <th>说明与取值</th>
                    </tr>
                </thead>
                <tbody>
                    ${rows}
                </tbody>
            </table>
        `;
    }

    function bindProductDetailModal() {
        const modal = document.getElementById('mcp-product-detail-modal');
        if (!modal || modal.dataset.boundDetail === '1') return;
        modal.dataset.boundDetail = '1';

        modal.querySelectorAll('[data-mcp-product-detail-close], #mcp-product-detail-close-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                closeProductDetailModal();
            });
        });

        modal.addEventListener('click', event => {
            if (event.target === modal) closeProductDetailModal();
        });

        const fillSampleBtn = modal.querySelector('#mcp-product-fill-sample-btn');
        fillSampleBtn?.addEventListener('click', (e) => {
            e.preventDefault();
            const input = document.getElementById('mcp-product-execute-input');
            if (input && describedTool?.inputSchema) {
                const sample = generateSampleInput(describedTool.inputSchema);
                input.value = JSON.stringify(sample, null, 2);
                showToast('已填入样例入参', 'success');
            }
        });

        const formatJsonBtn = modal.querySelector('#mcp-product-format-json-btn');
        formatJsonBtn?.addEventListener('click', (e) => {
            e.preventDefault();
            const input = document.getElementById('mcp-product-execute-input');
            if (!input) return;
            try {
                const parsed = JSON.parse(input.value.trim() || '{}');
                input.value = JSON.stringify(parsed, null, 2);
                showToast('JSON 已格式化', 'success');
            } catch (err) {
                showToast('JSON 格式无效：' + err.message, 'error');
            }
        });

        const executeBtn = modal.querySelector('#mcp-product-execute-btn');
        executeBtn?.addEventListener('click', async (e) => {
            e.preventDefault();
            try {
                await executeDescribedTool(executeBtn);
            } catch (error) {
                showToast(error.message || '工具执行失败', 'error');
            }
        });
    }

    function bindCatalogModal() {
        bindProductDetailModal();
        const modal = document.getElementById('mcp-catalog-modal');
        if (!modal || modal.dataset.bound === '1') return;
        modal.dataset.bound = '1';

        modal.querySelector('#mcp-catalog-modal-close-btn')?.addEventListener('click', closeCatalogModal);
        modal.addEventListener('click', async event => {
            if (event.target === modal) return closeCatalogModal();
            const button = event.target.closest('button, [role="button"]');
            if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true') return;
            if (button.dataset.mcpProductDescribe !== undefined) {
                event.preventDefault();
                try { await describeTool(button); }
                catch (error) { showToast(error.message || '工具契约读取失败', 'error'); }
            }
        });

        const searchInput = modal.querySelector('#mcp-product-tool-search');
        searchInput?.addEventListener('keydown', async event => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            try { await loadCatalog(searchInput.value || ''); }
            catch (error) { showToast(error.message || '工具搜索失败', 'error'); }
        });

        modal.querySelector('#mcp-product-tool-search-btn')?.addEventListener('click', async event => {
            event.preventDefault();
            try { await loadCatalog(searchInput?.value || ''); }
            catch (error) { showToast(error.message || '工具搜索失败', 'error'); }
        });

        document.getElementById('mcp-open-catalog-modal')?.addEventListener('click', (e) => {
            e.stopPropagation();
            openCatalogModal();
        });

        document.querySelector('.mcp-catalog-entry-section')?.addEventListener('click', (e) => {
            if (e.target.closest('button')) return;
            openCatalogModal();
        });
    }

    async function loadCatalog(queryText = '') {
        const box = document.getElementById('mcp-product-catalog');
        const badgeEl = document.getElementById('mcp-catalog-total-badge');
        const modalCountEl = document.getElementById('mcp-catalog-modal-count');
        const query = String(queryText || '').trim();
        try {
            const response = query
                ? await apiFetch(`${API_BASE}/tools/search`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query, limit: 24 }) })
                : await apiFetch(`${API_BASE}/tools/catalog?limit=100`);
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data.error || (query ? '工具搜索失败' : '工具目录加载失败'));
            const items = Array.isArray(data.data) ? data.data : [];
            if (!query && badgeEl) {
                badgeEl.textContent = `${items.length} 个已授权工具`;
            }
            if (modalCountEl) {
                modalCountEl.textContent = query ? `搜索结果：${items.length} 个可用工具` : `共 ${items.length} 个可用工具`;
            }
            if (box) {
                PivotSafeHtml.setHtml(box, renderCatalog(items));
            }
            bindCatalogModal();
        } catch (error) {
            if (badgeEl && !query) badgeEl.textContent = '工具目录不可用';
            if (modalCountEl) modalCountEl.textContent = '加载失败';
            if (box) PivotSafeHtml.setHtml(box, empty(error.message || '工具目录加载失败'));
            throw error;
        }
    }

    function renderConnectionAccounts(items = []) {
        if (!items.length) {
            return `
                <div class="mcp-empty-state-card">
                    <div class="mcp-empty-state-icon">
                        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
                    </div>
                    <div class="mcp-empty-state-title">尚未绑定任何连接账户</div>
                    <div class="mcp-empty-state-desc">配置支持授权的工具服务或连接器后，可在此处绑定个人、单位或服务账号，集中管理 OAuth 2.0 授权、安全凭据引用与自动刷新。</div>
                    <div class="mcp-empty-state-highlights">
                        <span class="mcp-feature-chip"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg> 授权码 + PKCE 闭环</span>
                        <span class="mcp-feature-chip"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg> 令牌服务端加密保留</span>
                        <span class="mcp-feature-chip"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg> 提示词与日志零泄露</span>
                    </div>
                </div>
            `;
        }
        return items.map(item => {
            const scopes = Array.isArray(item.scopes) ? item.scopes.slice(0, 4) : [];
            const state = String(item.auth_state || 'unconnected');
            const stateLabel = { active: '已连接', unconnected: '未连接', authorizing: '授权中', expiring: '即将过期', refresh_failed: '刷新失败', disabled: '已停用', revoked: '已撤销' }[state] || state;
            const scopeText = item.ownership_scope === 'service' ? '服务账号' : item.ownership_scope === 'unit' ? '单位共享' : '个人连接';
            const displayName = escape(item.display_name || item.connector_name || '连接账户');
            const scopesHtml = scopes.length
                ? scopes.map(scope => {
                    const escapedScope = escape(scope);
                    return `<span title="${escapedScope}">${escapedScope}</span>`;
                }).join('')
                : '<span class="is-muted">未授予额外范围</span>';
            return `
                <article class="mcp-product-card mcp-connection-card">
                    <div class="mcp-product-card-head">
                        <div class="mcp-connection-title-row">
                            <span class="mcp-connection-account-icon">
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                            </span>
                            <strong title="${displayName}">${displayName}</strong>
                        </div>
                        <em class="connection-${escape(state)}">${escape(stateLabel)}</em>
                    </div>
                    <div class="mcp-connection-subtext">
                        <span class="mcp-ownership-tag ${escape(item.ownership_scope || 'personal')}">${escape(scopeText)}</span>
                        <span class="mcp-connector-tag">${escape(item.connector_name || item.connector_slug || '工具连接')}</span>
                    </div>
                    <div class="mcp-product-badges">
                        ${scopesHtml}
                        ${item.expires_at ? `<span class="is-expires">到期：${escape(String(item.expires_at).slice(0, 16))}</span>` : ''}
                    </div>
                    ${item.last_error ? `<small class="mcp-product-error"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg> ${escape(item.last_error)}</small>` : ''}
                    <div class="mcp-product-card-actions">
                        <button class="btn-secondary btn-xs" type="button" data-mcp-connection-action="${escape(item.auth_type === 'oauth2' ? 'authorize' : 'refresh')}" data-mcp-connection-id="${escape(item.id)}">${escape(item.auth_type === 'oauth2' ? (state === 'active' ? '重新授权' : '完成授权') : '刷新状态')}</button>
                        <button class="btn-secondary btn-xs" type="button" data-mcp-connection-action="test" data-mcp-connection-id="${escape(item.id)}">测试连接</button>
                        ${state !== 'revoked' ? `<button class="btn-danger-outline btn-xs" type="button" data-mcp-connection-action="revoke" data-mcp-connection-id="${escape(item.id)}">撤销</button>` : ''}
                    </div>
                </article>
            `;
        }).join('');
    }

    function openConnectionAccountsModal() {
        const modal = document.getElementById('mcp-connection-accounts-modal');
        if (!modal) return;
        const modalApi = window.Pivot?.moduleApi?.('mcp.modal');
        if (typeof modalApi?.setMcpModalVisibility === 'function') {
            modalApi.setMcpModalVisibility(modal, true);
        } else {
            modal.classList.remove('hidden');
            modal.setAttribute('aria-hidden', 'false');
        }
    }

    function closeConnectionAccountsModal() {
        const modal = document.getElementById('mcp-connection-accounts-modal');
        if (!modal) return;
        const modalApi = window.Pivot?.moduleApi?.('mcp.modal');
        if (typeof modalApi?.setMcpModalVisibility === 'function') {
            modalApi.setMcpModalVisibility(modal, false);
        } else {
            modal.classList.add('hidden');
            modal.setAttribute('aria-hidden', 'true');
        }
    }

    function bindConnectionAccountsModal() {
        const modal = document.getElementById('mcp-connection-accounts-modal');
        if (!modal || modal.dataset.bound === '1') return;
        modal.dataset.bound = '1';
        modal.querySelector('#mcp-connection-modal-close-btn')?.addEventListener('click', closeConnectionAccountsModal);
        modal.querySelector('#mcp-modal-refresh-connections')?.addEventListener('click', async () => {
            try {
                await loadConnectionAccounts();
                showToast('连接账户状态已刷新', 'success');
            } catch (err) {
                showToast(err.message || '刷新失败', 'error');
            }
        });
        modal.addEventListener('click', event => {
            if (event.target === modal) closeConnectionAccountsModal();
        });

        document.getElementById('mcp-open-connection-modal')?.addEventListener('click', (e) => {
            e.stopPropagation();
            openConnectionAccountsModal();
        });
        document.getElementById('mcp-refresh-connections-btn')?.addEventListener('click', async (e) => {
            e.stopPropagation();
            try {
                await loadConnectionAccounts();
                showToast('连接账户状态已刷新', 'success');
            } catch (err) {
                showToast(err.message || '刷新失败', 'error');
            }
        });
        document.getElementById('mcp-card-connection-accounts')?.addEventListener('click', (e) => {
            if (e.target.closest('button')) return;
            openConnectionAccountsModal();
        });
    }

    async function loadConnectionAccounts() {
        const box = document.getElementById('mcp-connection-accounts');
        const metricEl = document.getElementById('mcp-metric-connections');
        try {
            const response = await apiFetch(`${API_BASE}/connection-accounts?includeInactive=true`);
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data.error || '连接账户加载失败');
            const items = Array.isArray(data.data) ? data.data : [];
            if (metricEl) {
                const activeCount = items.filter(item => item.auth_state === 'active').length;
                metricEl.textContent = `${activeCount} 个已连接 (${items.length} 个账号)`;
            }
            if (box) {
                PivotSafeHtml.setHtml(box, renderConnectionAccounts(items));
            }
            bindConnectionAccountsModal();
        } catch (error) {
            if (metricEl) metricEl.textContent = '暂无连接账户';
            if (box) PivotSafeHtml.setHtml(box, `<div class="mcp-product-error">${escape(error.message || '连接账户加载失败')}</div>`);
        }
    }

    function renderOperationSummary(summary = {}) {
        const total = Number(summary.total || 0);
        const rate = Number(summary.successRate || 0) * 100;
        return `<span><b>${escape(total)}</b> 调用</span><span><b>${escape(rate.toFixed(1))}%</b> 成功率</span><span><b>${escape(Math.round(Number(summary.p50_ms || 0)))}</b>ms P50</span><span><b>${escape(Math.round(Number(summary.p95_ms || 0)))}</b>ms P95</span><span><b>${escape(Number(summary.approval_count || 0))}</b> 等待审批</span>`;
    }

    function renderOperations(items = []) {
        if (!items.length) return empty('暂无新的工具运行记录。');
        return items.map(item => `
            <article class="mcp-operation-row">
                <div><strong>${escape(item.tool_name || '工具')}</strong><span>${escape(item.source || 'unknown')} · ${escape(item.policy_decision || 'allow')}</span></div>
                <div><em class="status-${escape(item.status || 'unknown')}">${escape(item.status || 'unknown')}</em><span>${escape(Number(item.total_ms || 0))}ms</span></div>
                ${item.error_code || item.error_class ? `<small>${escape(item.error_code || item.error_class)}</small>` : ''}
            </article>
        `).join('');
    }

    async function loadOperations() {
        const summaryBox = document.getElementById('mcp-tool-operations-summary');
        const listBox = document.getElementById('mcp-tool-operations');
        if (!summaryBox && !listBox) return;
        const [summaryResponse, operationsResponse] = await Promise.all([apiFetch(`${API_BASE}/tools/operations/summary`), apiFetch(`${API_BASE}/tools/operations?limit=80`)]);
        const summary = await summaryResponse.json().catch(() => ({}));
        const operations = await operationsResponse.json().catch(() => ({}));
        if (!summaryResponse.ok || !operationsResponse.ok) throw new Error(summary.error || operations.error || '工具运行记录加载失败');
        if (summaryBox) PivotSafeHtml.setHtml(summaryBox, renderOperationSummary(summary.data || {}));
        if (listBox) PivotSafeHtml.setHtml(listBox, renderOperations(operations.data || []));
    }

    async function describeTool(button) {
        const name = button?.dataset?.mcpProductDescribe;
        if (!name) return;
        const response = await apiFetch(`${API_BASE}/tools/describe`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ toolRef: { toolName: name, releaseId: Number(button.dataset.mcpProductRelease) || null, definitionDigest: button.dataset.mcpProductDigest || '' } })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || '工具契约读取失败');
        const detail = data.data || {};
        describedTool = detail.toolRef && detail.name ? detail : null;

        const modal = document.getElementById('mcp-product-detail-modal');
        const title = document.getElementById('mcp-product-detail-title');
        const subtitle = document.getElementById('mcp-product-detail-subtitle');
        const descEl = document.getElementById('mcp-product-detail-desc');
        const badgesEl = document.getElementById('mcp-product-detail-badges');
        const paramsCountEl = document.getElementById('mcp-contract-params-count');
        const paramsBox = document.getElementById('mcp-contract-params-box');
        const content = document.getElementById('mcp-product-detail-content');

        const displayTitle = toolDisplayName(detail.title, detail.name);
        const displayServer = serverDisplayName(detail.serverName);

        if (!modal) return showToast(`${displayTitle}：已加载完整工具契约`, 'success');
        if (title) title.textContent = displayTitle;
        if (subtitle) subtitle.textContent = `${detail.name || ''} · 风险：${riskLabel(detail.riskLevel)}${detail.requiresApproval ? ' · 调用前需审批' : ''}`;
        if (descEl) descEl.textContent = detail.description || '暂无详细工具说明。';

        if (badgesEl) {
            const capabilities = Array.isArray(detail.capabilities) ? detail.capabilities.slice(0, 4) : [];
            PivotSafeHtml.setHtml(badgesEl, `
                ${detail.source ? `<span>${escape(sourceBadgeLabel(detail.source))}</span>` : ''}
                ${displayServer ? `<span>${escape(displayServer)}</span>` : ''}
                ${detail.requiresConnection ? '<span>需连接凭据</span>' : ''}
                ${detail.requiresApproval || detail.approvalRequired ? '<span class="is-warning">需审批确认</span>' : ''}
                ${capabilities.map(cap => `<span title="${escape(cap)}">${escape(capabilityBadgeLabel(cap))}</span>`).join('')}
            `);
        }

        const inputSchema = detail.inputSchema || {};
        const properties = (inputSchema && typeof inputSchema.properties === 'object' && inputSchema.properties !== null)
            ? inputSchema.properties
            : {};
        const paramKeys = Object.keys(properties);
        if (paramsCountEl) paramsCountEl.textContent = `${paramKeys.length} 个参数`;
        if (paramsBox) {
            PivotSafeHtml.setHtml(paramsBox, renderParameterTable(inputSchema));
        }

        const sample = generateSampleInput(inputSchema);
        const input = document.getElementById('mcp-product-execute-input');
        const execute = document.getElementById('mcp-product-execute-btn');
        if (input) input.value = JSON.stringify(sample, null, 2);
        if (execute) execute.disabled = !describedTool;

        if (content) {
            const rawSchemaText = `输入 Schema:\n${JSON.stringify(detail.inputSchema || {}, null, 2)}\n\n输出 Schema:\n${JSON.stringify(detail.outputSchema || {}, null, 2)}`;
            content.textContent = rawSchemaText;
        }

        const bodyEl = modal.querySelector('.mcp-product-detail-body');
        if (bodyEl) bodyEl.scrollTop = 0;
        const rawDetails = modal.querySelector('.mcp-contract-raw-details');
        if (rawDetails) rawDetails.open = false;

        bindProductDetailModal();
        modalApi().setMcpModalVisibility?.(modal, true, { focusSelector: '[data-mcp-product-detail-close]' });
    }

    async function executeDescribedTool(button) {
        if (!describedTool?.toolRef || !describedTool?.name) throw new Error('请先从搜索结果中查看工具契约。');
        const rawInput = String(document.getElementById('mcp-product-execute-input')?.value || '{}').trim() || '{}';
        let input;
        try { input = JSON.parse(rawInput); } catch (_) { throw new Error('执行输入必须是合法 JSON 对象。'); }
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('执行输入必须是 JSON 对象。');
        button.disabled = true;
        try {
            const response = await apiFetch(`${API_BASE}/tools/invoke`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ toolRef: describedTool.toolRef, input })
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data.error || '工具执行失败');
            showToast('工具已执行；可在“运行与治理”查看策略与调用记录。', 'success');
            await loadOperations();
            return data.result;
        } finally { button.disabled = false; }
    }

    async function changeConnectionAccount(button) {
        const id = button?.dataset?.mcpConnectionId;
        const action = button?.dataset?.mcpConnectionAction;
        if (!id || !action) return;
        button.disabled = true;
        try {
            if (action === 'authorize') {
                const response = await apiFetch(`${API_BASE}/connection-accounts/${encodeURIComponent(id)}/authorize`, { method: 'POST' });
                const data = await response.json().catch(() => ({}));
                const authorizationUrl = String(data?.data?.authorizationUrl || '');
                if (!response.ok || !authorizationUrl) throw new Error(data.error || '无法发起 OAuth 授权');
                // Keep the signed-in browser session for the callback, then let
                // the provider complete the Authorization Code + PKCE exchange.
                window.location.assign(authorizationUrl);
                return;
            }
            const response = await apiFetch(`${API_BASE}/connection-accounts/${encodeURIComponent(id)}/${encodeURIComponent(action)}`, { method: 'POST' });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data.error || '连接账户操作失败');
            if (action === 'test') {
                const count = data?.data?.toolCount;
                showToast(count === null || count === undefined ? '连接授权有效' : `连接成功，可访问 ${count} 个工具`, 'success');
            } else {
                showToast(action === 'revoke' ? '连接授权已撤销' : '连接状态已刷新', 'success');
            }
            await loadConnectionAccounts();
        } finally {
            button.disabled = false;
        }
    }

    bindCatalogModal();
    bindProductDetailModal();
    window.Pivot?.exposeModule?.('mcp.product', {
        bindCatalogModal,
        capabilityBadgeLabel,
        changeConnectionAccount,
        closeCatalogModal,
        closeConnectionAccountsModal,
        closeProductDetailModal,
        describeTool,
        executeDescribedTool,
        loadCatalog,
        loadConnectionAccounts,
        loadOperations,
        openCatalogModal,
        openConnectionAccountsModal,
        serverDisplayName,
        sourceBadgeLabel,
        toolDisplayName
    });
}());
