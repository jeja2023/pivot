// Harness 管理与运行诊断。
(function () {
    const state = {
        skills: [],
        packs: [],
        residents: [],
        profile: null,
        memoryPolicy: null,
        feedback: [],
        feedbackSummary: null,
        proposals: [],
        residentScope: 'self',
        diagnostics: new Map()
    };

    const escape = value => window.PivotSafeHtml?.escapeHtml
        ? window.PivotSafeHtml.escapeHtml(value)
        : String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char]));

    const escapeAttr = value => window.PivotSafeHtml?.escapeAttr
        ? window.PivotSafeHtml.escapeAttr(value)
        : escape(value).replace(/"/g, '&quot;');

    const formatDate = value => {
        const text = String(value || '').trim();
        if (!text) return '-';
        const date = new Date(text.includes('T') || /Z$|[+-]\d\d:\d\d$/.test(text) ? text : `${text.replace(' ', 'T')}+08:00`);
        if (Number.isNaN(date.getTime())) return text;
        return date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    };

    const shortText = (value, max = 120) => {
        const text = String(value ?? '').trim();
        return text.length > max ? `${text.slice(0, max)}...` : text;
    };

    const jsonText = value => {
        try { return JSON.stringify(value ?? {}, null, 2); } catch (_) { return '{}'; }
    };

    const getCurrentUser = () => (typeof currentUser !== 'undefined' ? currentUser : window.currentUser || null);

    function setNotice(message = '', tone = '') {
        const notice = document.getElementById('agent-harness-notice');
        if (!notice) return;
        notice.textContent = message;
        notice.className = `agent-harness-notice${tone ? ` is-${tone}` : ''}`;
    }

    function setMarkup(element, markup) {
        if (!element) return;
        if (window.PivotSafeHtml?.setHtml) window.PivotSafeHtml.setHtml(element, markup);
        else element.textContent = String(markup || '');
    }

    function prependMarkup(element, markup) {
        if (!element) return;
        if (window.PivotSafeHtml?.prependHtml) window.PivotSafeHtml.prependHtml(element, markup);
        else element.prepend(document.createTextNode(String(markup || '')));
    }

    async function apiJson(path, options = {}) {
        const response = await apiFetch(path, options);
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || data.message || `请求失败（${response.status}）`);
        return data;
    }

    function renderSkills() {
        const list = document.getElementById('agent-harness-skill-list');
        if (!list) return;
        if (!state.skills.length) {
            setMarkup(list, `<div class="agent-harness-empty-card">
                <svg class="agent-harness-empty-svg" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path>
                    <polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline>
                    <line x1="12" y1="22.08" x2="12" y2="12"></line>
                </svg>
                <strong>暂无已安装技能包</strong>
                <span>可通过右侧表单填入清单或导入 .skill.zip 离线包</span>
            </div>`);
            return;
        }
        const userId = String(getCurrentUser()?.id || '');
        setMarkup(list, state.skills.map(skill => {
            const own = String(skill.user_id || '') === userId;
            const status = String(skill.status || '').toLowerCase();
            const scopeLabel = ({ user: '个人', shared: '共享', global: '全局' })[skill.scope] || skill.scope || '个人';
            return `<article class="agent-harness-item ${status === 'disabled' ? 'is-disabled' : ''}">
                <div class="agent-harness-item-main">
                    <div class="agent-harness-item-title-row">
                        <strong>${escape(skill.title || skill.name)}</strong>
                        <span class="agent-harness-badge">${escape(scopeLabel)}</span>
                        <span class="agent-harness-status-pill ${status === 'enabled' ? 'is-active' : 'is-inactive'}">${escape(status === 'enabled' ? '已启用' : '已停用')}</span>
                    </div>
                    <span class="agent-harness-item-id">${escape(skill.name || '')} · v${escape(skill.version || '')}</span>
                    <small>${escape(shortText(skill.description || '未填写说明', 180))}</small>
                </div>
                <div class="agent-harness-item-meta">
                    <span>${escape(formatDate(skill.updated_at))}</span>
                    ${own && status === 'enabled' ? `<button type="button" class="btn-secondary btn-xs" data-agent-harness-disable-skill="${escapeAttr(skill.name)}">停用</button>` : ''}
                </div>
            </article>`;
        }).join(''));
    }

    function populateSkillSelect() {
        const select = document.getElementById('agent-skill-select');
        if (!select) return;
        const previous = select.value;
        const options = ['<option value="">不指定技能</option>'].concat(state.skills
            .filter(skill => String(skill.status || 'enabled') === 'enabled')
            .map(skill => `<option value="${escapeAttr(skill.id || skill.name)}">${escape(skill.title || skill.name)} · v${escape(skill.version || '')}</option>`));
        setMarkup(select, options.join(''));
        if (previous && [...select.options].some(option => option.value === previous)) select.value = previous;
    }

    async function loadSkills() {
        const data = await apiJson(`${API_BASE}/agents/skills?includeDisabled=true`, { cache: 'no-store' });
        state.skills = Array.isArray(data.data) ? data.data : [];
        renderSkills();
        populateSkillSelect();
        return state.skills;
    }

    async function registerSkill() {
        const manifest = document.getElementById('agent-harness-skill-manifest')?.value.trim();
        const instructions = document.getElementById('agent-harness-skill-instructions')?.value || '';
        if (!manifest) return setNotice('请填写技能清单。', 'error');
        const button = document.getElementById('agent-harness-skill-register');
        if (button) button.disabled = true;
        try {
            await apiJson(`${API_BASE}/agents/skills`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ manifest, instructions })
            });
            setNotice('技能包注册成功。', 'success');
            document.getElementById('agent-harness-skill-manifest').value = '';
            document.getElementById('agent-harness-skill-instructions').value = '';
            await loadSkills();
        } catch (error) {
            setNotice(error.message || '技能包注册失败。', 'error');
        } finally {
            if (button) button.disabled = false;
        }
    }

    async function uploadSkillPackage(file) {
        if (!file) return;
        const formData = new FormData();
        formData.append('file', file);
        const input = document.getElementById('agent-harness-skill-file');
        if (input) input.disabled = true;
        try {
            await apiJson(`${API_BASE}/agents/skills/package`, { method: 'POST', body: formData });
            setNotice('技能包导入并校验成功。', 'success');
            await loadSkills();
        } catch (error) {
            setNotice(error.message || '技能包导入失败。', 'error');
        } finally {
            if (input) {
                input.disabled = false;
                input.value = '';
            }
        }
    }

    async function disableSkill(name) {
        try {
            await apiJson(`${API_BASE}/agents/skills/${encodeURIComponent(name)}/disable`, { method: 'POST' });
            setNotice('技能包已停用。', 'success');
            await loadSkills();
        } catch (error) {
            setNotice(error.message || '技能包停用失败。', 'error');
        }
    }

    function renderPacks() {
        const list = document.getElementById('agent-harness-pack-list');
        if (!list) return;
        if (!state.packs.length) {
            setMarkup(list, `<div class="agent-harness-empty-card">
                <svg class="agent-harness-empty-svg" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                    <rect x="3" y="3" width="18" height="18" rx="2"></rect>
                    <path d="M3 9h18"></path>
                    <path d="M9 21V9"></path>
                </svg>
                <strong>暂无已安装运行资源包</strong>
                <span>由系统自动下载、校验完整性后安装</span>
            </div>`);
            return;
        }
        setMarkup(list, state.packs.map(pack => `<article class="agent-harness-item">
            <div class="agent-harness-item-main">
                <div class="agent-harness-item-title-row">
                    <strong>${escape(pack.id || '运行资源')}</strong>
                    <span class="agent-harness-badge">${escape(pack.type === 'browser' ? '浏览器' : '数据处理')}</span>
                </div>
                <span class="agent-harness-item-id">版本 v${escape(pack.version || '1.0.0')} · ${escape(String(pack.size || 0))} 字节</span>
                <small>完整性摘要 ${escape(shortText(pack.sha256 || pack.digest || '-', 28))}</small>
            </div>
            <div class="agent-harness-item-meta">
                <span>${escape(formatDate(pack.installedAt || pack.installed_at))}</span>
            </div>
        </article>`).join(''));
    }

    async function loadPacks() {
        const data = await apiJson(`${API_BASE}/agents/runtime-packs`, { cache: 'no-store' });
        state.packs = Array.isArray(data.data) ? data.data : [];
        renderPacks();
        return state.packs;
    }

    async function syncPack() {
        if (!isAdminUser()) return setNotice('只有管理员可以同步运行资源包。', 'error');
        const origins = String(document.getElementById('agent-harness-pack-origins')?.value || '')
            .split(/[\n,]/).map(value => value.trim()).filter(Boolean);
        const manifest = {
            type: document.getElementById('agent-harness-pack-type')?.value || 'data',
            id: document.getElementById('agent-harness-pack-id')?.value.trim(),
            version: document.getElementById('agent-harness-pack-version')?.value.trim(),
            size: Number(document.getElementById('agent-harness-pack-size')?.value || 0) || 0,
            url: document.getElementById('agent-harness-pack-url')?.value.trim(),
            sha256: document.getElementById('agent-harness-pack-sha256')?.value.trim()
        };
        if (!manifest.id || !manifest.version || !manifest.url || !manifest.sha256 || !origins.length) return setNotice('资源包 ID、版本、资源地址、校验摘要和访问来源白名单均为必填。', 'error');
        let allowedPorts = [80, 443, 8080];
        try {
            const parsed = new URL(manifest.url);
            const port = parsed.port ? Number(parsed.port) : (parsed.protocol === 'https:' ? 443 : 80);
            allowedPorts = [...new Set([...allowedPorts, port])];
        } catch (_) {
            return setNotice('运行资源包地址无效。', 'error');
        }
        const button = document.getElementById('agent-harness-pack-sync');
        if (button) button.disabled = true;
        try {
            await apiJson(`${API_BASE}/agents/runtime-packs/sync`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ manifest, networkPolicy: { allowed_origins: origins, allowed_ports: allowedPorts, allow_redirect: false } })
            });
            setNotice('运行资源包同步完成并通过完整性校验。', 'success');
            await loadPacks();
        } catch (error) {
            setNotice(error.message || '运行资源包同步失败。', 'error');
        } finally {
            if (button) button.disabled = false;
        }
    }

    function renderResidents() {
        const list = document.getElementById('agent-harness-residency-list');
        if (!list) return;
        if (!state.residents.length) {
            setMarkup(list, `<div class="agent-harness-empty-card agent-harness-empty-card--wide">
                <svg class="agent-harness-empty-svg" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                    <rect x="2" y="2" width="20" height="8" rx="2" ry="2"></rect>
                    <rect x="2" y="14" width="20" height="8" rx="2" ry="2"></rect>
                    <line x1="6" y1="6" x2="6.01" y2="6"></line>
                    <line x1="6" y1="18" x2="6.01" y2="18"></line>
                </svg>
                <strong>当前暂无活跃的常驻实例</strong>
                <span>自主任务或复杂会话启用环境复用后，常驻实例将在此处展示运行租约、命中次数与生命周期状态。</span>
            </div>`);
            return;
        }
        setMarkup(list, state.residents.map(item => {
            const status = String(item.status || '').toLowerCase();
            const statusLabel = ({ active: '活跃中', idle: '空闲中', evicted: '已驱逐', stopped: '已停止' })[status] || status || '空闲中';
            return `<article class="agent-harness-item agent-harness-item--resident">
                <div class="agent-harness-item-main">
                    <div class="agent-harness-item-title-row">
                        <strong>${escape(item.resident_key || item.resident_id)}</strong>
                        <span class="agent-harness-status-pill ${status === 'active' ? 'is-active' : 'is-idle'}">${escape(statusLabel)}</span>
                        <span class="agent-harness-badge">命中 ${escape(item.hit_count || 0)} 次</span>
                    </div>
                    <span class="agent-harness-item-id">关联运行 ${escape(item.run_id || '-')} · 上下文摘要 ${escape(shortText(item.context_hash || '-', 18))}</span>
                </div>
                <div class="agent-harness-item-meta">
                    <span>最近访问 ${escape(formatDate(item.last_accessed_at))}</span>
                    <span>过期时间 ${escape(formatDate(item.expires_at))}</span>
                    <button type="button" class="btn-secondary btn-xs" data-agent-harness-evict-resident="${escapeAttr(item.resident_id)}">驱逐</button>
                </div>
            </article>`;
        }).join(''));
    }

    async function loadResidents() {
        const scope = document.getElementById('agent-harness-residency-scope')?.value || 'self';
        state.residentScope = scope;
        const query = scope === 'all' && isSuperAdminUser() ? '?scope=all&limit=200' : '?limit=200';
        const data = await apiJson(`${API_BASE}/agents/residencies${query}`, { cache: 'no-store' });
        state.residents = Array.isArray(data.data) ? data.data : [];
        renderResidents();
        return state.residents;
    }

    async function evictResident(residentId) {
        try {
            await apiJson(`${API_BASE}/agents/residencies/${encodeURIComponent(residentId)}/evict`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ scope: state.residentScope })
            });
            setNotice('常驻实例已驱逐。', 'success');
            await loadResidents();
        } catch (error) {
            setNotice(error.message || '常驻实例驱逐失败。', 'error');
        }
    }

    async function sweepResidents() {
        try {
            const data = await apiJson(`${API_BASE}/agents/residencies/sweep`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ scope: state.residentScope })
            });
            setNotice(`已清理 ${Number(data.evicted || 0)} 个过期常驻实例。`, 'success');
            await loadResidents();
        } catch (error) {
            setNotice(error.message || '常驻实例清理失败。', 'error');
        }
    }

    const splitLines = value => String(value || '').split(/[\n,]/).map(item => item.trim()).filter(Boolean);

    function fillProfile(profile = {}) {
        const setValue = (id, value) => { const el = document.getElementById(id); if (el) el.value = value || ''; };
        setValue('agent-profile-display-name', profile.displayName);
        setValue('agent-profile-role', profile.role);
        setValue('agent-profile-preferences', jsonText(profile.preferences || {}));
        setValue('agent-profile-work-habits', (profile.workHabits || []).join('\n'));
        setValue('agent-profile-tools', (profile.frequentTools || []).join('\n'));
        setValue('agent-profile-tasks', (profile.commonTasks || []).join('\n'));
        setValue('agent-profile-tone', profile.communicationStyle?.tone || 'professional');
        setValue('agent-profile-verbosity', profile.communicationStyle?.verbosity || 'balanced');
    }

    async function loadProfile() {
        const data = await apiJson(`${API_BASE}/agents/profile`, { cache: 'no-store' });
        state.profile = data.profile || {};
        fillProfile(state.profile);
        return state.profile;
    }

    async function saveProfile() {
        let preferences = {};
        try { preferences = JSON.parse(document.getElementById('agent-profile-preferences')?.value || '{}'); } catch (_) { return setNotice('偏好必须是合法 JSON。', 'error'); }
        const payload = {
            displayName: document.getElementById('agent-profile-display-name')?.value || '',
            role: document.getElementById('agent-profile-role')?.value || '',
            preferences,
            workHabits: splitLines(document.getElementById('agent-profile-work-habits')?.value),
            frequentTools: splitLines(document.getElementById('agent-profile-tools')?.value),
            commonTasks: splitLines(document.getElementById('agent-profile-tasks')?.value),
            communicationStyle: {
                ...(state.profile?.communicationStyle || {}),
                tone: document.getElementById('agent-profile-tone')?.value || 'professional',
                verbosity: document.getElementById('agent-profile-verbosity')?.value || 'balanced'
            }
        };
        try {
            const data = await apiJson(`${API_BASE}/agents/profile`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
            state.profile = data.profile || payload;
            setNotice('个人 Agent 档案已保存。', 'success');
        } catch (error) { setNotice(error.message || '个人档案保存失败。', 'error'); }
    }

    async function loadMemoryPolicy() {
        const data = await apiJson(`${API_BASE}/memories/policy`, { cache: 'no-store' });
        state.memoryPolicy = data.policy || {};
        const autoCapture = document.getElementById('agent-memory-auto-capture');
        if (autoCapture) autoCapture.checked = state.memoryPolicy.autoCapture !== false;
        const blocked = new Set(state.memoryPolicy.blockedCategories || []);
        document.querySelectorAll('[data-agent-memory-blocked]').forEach(input => { input.checked = blocked.has(input.value); });
        return state.memoryPolicy;
    }

    async function saveMemoryPolicy() {
        const blockedCategories = [...document.querySelectorAll('[data-agent-memory-blocked]:checked')].map(input => input.value);
        try {
            const data = await apiJson(`${API_BASE}/memories/policy`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ autoCapture: document.getElementById('agent-memory-auto-capture')?.checked !== false, blockedCategories }) });
            state.memoryPolicy = data.policy;
            const notice = document.getElementById('agent-memory-policy-notice');
            if (notice) { notice.textContent = '记忆治理策略已保存。敏感信息始终不会持久化。'; notice.className = 'agent-harness-notice is-success'; }
        } catch (error) {
            const notice = document.getElementById('agent-memory-policy-notice');
            if (notice) { notice.textContent = error.message || '记忆治理策略保存失败。'; notice.className = 'agent-harness-notice is-error'; }
        }
    }

    function renderFeedback() {
        const summary = document.getElementById('agent-feedback-summary');
        const list = document.getElementById('agent-feedback-list');
        if (summary) {
            if (state.feedbackSummary) {
                const s = state.feedbackSummary;
                const total = Number(s.total || 0);
                const rate = Math.round(Number(s.successRate || 0) * 100);
                const avg = s.averageRating == null ? '—' : Number(s.averageRating).toFixed(1);
                const failTools = (s.frequentToolFailures || []).slice(0, 3).map(item => `${item.tool} (${item.count})`).join('、') || '无';
                setMarkup(summary, `
                    <div class="agent-feedback-metrics">
                        <div class="agent-feedback-metric-card">
                            <span class="metric-label">近 ${escape(s.days || 30)} 天总反馈</span>
                            <strong class="metric-value">${total} <small>次</small></strong>
                        </div>
                        <div class="agent-feedback-metric-card">
                            <span class="metric-label">任务执行成功率</span>
                            <strong class="metric-value ${rate >= 80 ? 'is-good' : rate >= 50 ? 'is-warn' : 'is-bad'}">${rate}%</strong>
                        </div>
                        <div class="agent-feedback-metric-card">
                            <span class="metric-label">综合平均评分</span>
                            <strong class="metric-value">${avg} <small>${s.averageRating != null ? '分' : ''}</small></strong>
                        </div>
                        <div class="agent-feedback-metric-card">
                            <span class="metric-label">高频失败工具</span>
                            <strong class="metric-value metric-tools" title="${escape(failTools)}">${escape(failTools)}</strong>
                        </div>
                    </div>
                `);
            } else {
                setMarkup(summary, '<div class="agent-feedback-empty">暂无统计指标。</div>');
            }
        }
        if (!list) return;
        setMarkup(list, state.feedback.length ? state.feedback.map(item => `
            <article class="agent-harness-item">
                <div class="agent-harness-item-main">
                    <div class="agent-harness-item-title-row">
                        <strong>任务 #${escape(item.runId)}</strong>
                        <span class="agent-harness-badge ${item.outcome === 'success' ? 'badge-success' : item.outcome === 'failure' ? 'badge-error' : 'badge-neutral'}">${escape(item.outcome === 'success' ? '成功' : item.outcome === 'failure' ? '失败' : item.outcome || '反馈')}</span>
                        ${item.rating ? `<span class="agent-harness-status-pill is-active">评分: ${escape(`${item.rating}/5`)}</span>` : ''}
                    </div>
                    <small>${escape(shortText(item.correction || item.modifiedAnswer || '未填写修正意见', 180))}</small>
                </div>
                <div class="agent-harness-item-meta">
                    <span>${escape(formatDate(item.updatedAt))}</span>
                </div>
            </article>
        `).join('') : '<div class="agent-harness-empty-card"><strong>暂无结果反馈</strong><span>任务完成后可在任务详情提交成功、失败或修正意见。</span></div>');
    }

    async function loadFeedback() {
        const [summary, list] = await Promise.all([
            apiJson(`${API_BASE}/agents/feedback/summary?days=30`, { cache: 'no-store' }),
            apiJson(`${API_BASE}/agents/feedback?limit=30`, { cache: 'no-store' })
        ]);
        state.feedbackSummary = summary.summary || null;
        state.feedback = Array.isArray(list.data) ? list.data : [];
        renderFeedback();
    }

    function renderProposals() {
        const list = document.getElementById('agent-evolution-list');
        if (!list) return;
        const kindLabels = {
            preference: '偏好调整',
            skill: '创建 Skill',
            workflow: '保存工作流'
        };
        const statusLabels = {
            approved: '已批准',
            rejected: '已拒绝',
            pending: '待确认',
            applied: '已应用'
        };
        setMarkup(list, state.proposals.length ? state.proposals.map(item => `
            <article class="agent-harness-item agent-evolution-item">
                <div class="agent-harness-item-main">
                    <div class="agent-harness-item-title-row">
                        <strong>${escape(item.title || '未命名提议')}</strong>
                        <span class="agent-harness-badge">${escape(kindLabels[item.kind] || item.kind || '提议')}</span>
                        <span class="agent-harness-status-pill ${item.status === 'approved' ? 'is-active' : item.status === 'pending' ? 'is-idle' : 'is-inactive'}">${escape(statusLabels[item.status] || item.status)}</span>
                    </div>
                    <small>${escape(shortText(item.description || '无详细说明', 180))}</small>
                    <code class="agent-evolution-code-preview">${escape(shortText(jsonText(item.proposedChange), 220))}</code>
                </div>
                <div class="agent-harness-item-meta">
                    ${item.status === 'pending' ? `
                        <button type="button" class="btn-primary btn-xs" data-agent-evolution-decision="approve" data-agent-evolution-id="${escapeAttr(item.id)}">批准</button>
                        <button type="button" class="btn-secondary btn-xs" data-agent-evolution-decision="reject" data-agent-evolution-id="${escapeAttr(item.id)}">拒绝</button>
                    ` : ''}
                    ${item.status === 'approved' && item.kind === 'preference' ? `
                        <button type="button" class="btn-primary btn-xs" data-agent-evolution-apply="${escapeAttr(item.id)}">应用此偏好</button>
                    ` : ''}
                </div>
            </article>
        `).join('') : '<div class="agent-harness-empty-card"><strong>暂无进化提议</strong><span>Agent 的 Skill、工作流和偏好调整建议都会先进入这里等待确认。</span></div>');
    }

    async function loadProposals() {
        const data = await apiJson(`${API_BASE}/agents/evolution/proposals?limit=50`, { cache: 'no-store' });
        state.proposals = Array.isArray(data.data) ? data.data : [];
        renderProposals();
    }

    async function createProposal() {
        let proposedChange = {};
        try { proposedChange = JSON.parse(document.getElementById('agent-evolution-change')?.value || '{}'); } catch (_) { return setNotice('结构化变更必须是合法 JSON。', 'error'); }
        try {
            await apiJson(`${API_BASE}/agents/evolution/proposals`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: document.getElementById('agent-evolution-kind')?.value, title: document.getElementById('agent-evolution-title-input')?.value, description: document.getElementById('agent-evolution-description')?.value, proposedChange }) });
            setNotice('进化提议已提交，等待用户确认。', 'success');
            await loadProposals();
        } catch (error) { setNotice(error.message || '进化提议提交失败。', 'error'); }
    }

    async function decideProposal(id, decision) {
        try { await apiJson(`${API_BASE}/agents/evolution/proposals/${encodeURIComponent(id)}/decision`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision }) }); await loadProposals(); } catch (error) { setNotice(error.message || '进化提议审批失败。', 'error'); }
    }

    async function applyProposal(id) {
        try { await apiJson(`${API_BASE}/agents/evolution/proposals/${encodeURIComponent(id)}/apply`, { method: 'POST' }); setNotice('偏好提议已应用并生成新档案版本。', 'success'); await Promise.all([loadProposals(), loadProfile()]); } catch (error) { setNotice(error.message || '进化提议应用失败。', 'error'); }
    }

    async function loadHarnessManagement() {
        document.querySelectorAll('.agent-harness-pack-sync').forEach(el => el.classList.toggle('hidden', !isAdminUser()));
        document.querySelectorAll('#agent-harness-residency-scope').forEach(el => el.classList.toggle('hidden', !isSuperAdminUser()));
        try {
            await Promise.all([loadSkills(), loadPacks(), loadResidents(), loadProfile(), loadMemoryPolicy(), loadFeedback(), loadProposals()]);
        } catch (error) {
            setNotice(error.message || '底座数据加载失败。', 'error');
        }
    }

    function renderDiagnosticValue(value, maxChars = 12000) {
        const text = jsonText(value);
        return `<pre class="agent-harness-json">${escape(text.length > maxChars ? `${text.slice(0, maxChars)}\n...` : text)}</pre>`;
    }

    const diagnosticCache = new Map();

    function getDiagnosticCache(runId) {
        const key = String(runId || '');
        let item = diagnosticCache.get(key);
        if (!item) {
            item = {
                activeTab: state.diagnostics.get(key) || 'context',
                panels: { context: '', world: '', resources: '', control: '' },
                loaded: { context: false, world: false, resources: false, control: false },
                fetching: { context: false, world: false, resources: false, control: false },
                sequence: 0
            };
            diagnosticCache.set(key, item);
            if (diagnosticCache.size > 80) {
                const oldest = diagnosticCache.keys().next().value;
                if (oldest) diagnosticCache.delete(oldest);
            }
        }
        return item;
    }

    function formatDiagnosticHtml(type, data) {
        if (type === 'context') {
            const list = Array.isArray(data) ? data : [];
            return list.length
                ? list.map(item => `<article class="agent-harness-diagnostic-card"><strong>窗口 ${escape(item.window_version)}</strong><span>${escape(item.status)} · ${escape(item.opened_reason)}</span><small>${escape(formatDate(item.created_at))} → ${escape(formatDate(item.closed_at))}</small><code>${escape(item.initial_state_hash || '-')}</code></article>`).join('')
                : '<div class="empty-state">暂无上下文窗口记录。</div>';
        }
        if (type === 'world') {
            const list = Array.isArray(data) ? data : [];
            return list.length
                ? list.slice().reverse().map(item => `<details class="agent-harness-diagnostic-card"><summary><strong>快照 ${escape(item.snapshot_version)}</strong><span>${escape(item.injection_mode === 'diff' ? '增量更新' : '完整更新')} · ${escape(item.full_refresh_reason || '常规更新')}</span><small>${escape(formatDate(item.created_at))}</small></summary><div class="agent-harness-diagnostic-meta">上下文摘要 ${escape(shortText(item.context_hash, 18))} · 状态摘要 ${escape(shortText(item.state_hash, 18))}</div>${renderDiagnosticValue({ state: item.state, patch: item.patch }, 9000)}</details>`).join('')
                : '<div class="empty-state">暂无状态快照。</div>';
        }
        if (type === 'resources') {
            const obj = data && typeof data === 'object' ? data : {};
            const budget = Number(obj.token_budget || 0);
            const consumed = Number(obj.tokens_consumed || 0);
            return `<div class="agent-harness-resource-grid"><div><span>Token 预算</span><strong>${escape(budget > 0 ? budget.toLocaleString() : '不限')}</strong></div><div><span>已消耗</span><strong>${escape(consumed.toLocaleString())}</strong></div><div><span>已预留</span><strong>${escape(Number(obj.tokens_reserved || 0).toLocaleString())}</strong></div><div><span>子运行</span><strong>${escape(`${Number(obj.active_children || 0)} / ${Number(obj.max_children || 0) || '不限'}`)}</strong></div></div>${renderDiagnosticValue(obj, 6000)}`;
        }
        if (type === 'control') {
            const list = Array.isArray(data) ? data : [];
            return `<form class="agent-harness-control-form"><select class="form-input" data-agent-control-type><option value="steer">steer</option><option value="request">request</option><option value="reply">reply</option><option value="system">system</option></select><textarea class="form-input" rows="2" data-agent-control-payload placeholder="输入 JSON 载荷，例如 {&quot;message&quot;:&quot;请优先处理第二步&quot;}"></textarea><button class="btn-primary" type="submit">发送控制消息</button></form>${list.length ? list.map(item => `<article class="agent-harness-diagnostic-card"><div><strong>${escape(item.message_type)}</strong><span>${escape(item.status)}</span><small>${escape(formatDate(item.created_at))}</small></div>${renderDiagnosticValue(item.payload, 2600)}${['pending', 'delivered'].includes(String(item.status)) ? `<button type="button" class="btn-secondary btn-xs" data-agent-control-ack="${escapeAttr(item.message_id)}">确认</button>` : ''}</article>`).join('') : '<div class="empty-state">暂无控制消息。</div>'}`;
        }
        return '<div class="empty-state">暂无诊断数据。</div>';
    }

    function diagnosticTabMarkup(runId) {
        const cache = getDiagnosticCache(runId);
        const activeTab = cache.activeTab || state.diagnostics.get(String(runId)) || 'context';
        cache.activeTab = activeTab;
        const tab = (key, label) => `<button class="agent-harness-diagnostic-tab${activeTab === key ? ' active' : ''}" type="button" data-agent-harness-diagnostic-tab="${key}" role="tab" aria-selected="${activeTab === key ? 'true' : 'false'}" tabindex="${activeTab === key ? '0' : '-1'}">${label}</button>`;
        const panelMarkup = (key, placeholder) => {
            const isHidden = activeTab !== key;
            const content = cache.panels[key] || `<div class="empty-state">${placeholder}</div>`;
            return `<div class="agent-harness-diagnostic-panel${isHidden ? ' hidden' : ''}" data-agent-harness-panel="${key}" role="tabpanel" aria-label="${key}">${content}</div>`;
        };
        return `<details class="agent-run-harness-diagnostics" data-agent-harness-diagnostics="${escapeAttr(runId)}" data-agent-harness-active-tab="${escapeAttr(activeTab)}">
            <summary><span>运行诊断</span><em>上下文、状态快照、资源与控制消息</em></summary>
            <div class="agent-harness-diagnostics-body">
                <div class="agent-harness-diagnostic-tabs" role="tablist" aria-label="运行诊断">
                    ${tab('context', '上下文窗口')}
                    ${tab('world', '状态快照')}
                    ${tab('resources', '资源用量')}
                    ${tab('control', '控制消息')}
                </div>
                <div class="agent-harness-diagnostic-panels">
                    ${panelMarkup('context', '正在加载上下文窗口记录...')}
                    ${panelMarkup('world', '正在加载状态快照...')}
                    ${panelMarkup('resources', '正在加载资源用量...')}
                    ${panelMarkup('control', '正在加载控制消息...')}
                </div>
            </div>
        </details>`;
    }

    async function loadDiagnostic(runId, type, detail, options = {}) {
        const cache = getDiagnosticCache(runId);
        const panel = detail?.querySelector?.(`[data-agent-harness-panel="${type}"]`);
        if (!panel) return;

        if (!cache.loaded[type] && !cache.panels[type] && !options.silent) {
            setMarkup(panel, '<div class="empty-state">正在加载诊断数据...</div>');
        }

        const seq = ++cache.sequence;
        cache.fetching[type] = true;
        try {
            let data;
            if (type === 'context') data = (await apiJson(`${API_BASE}/agents/runs/${encodeURIComponent(runId)}/context-windows?limit=100`, { cache: 'no-store' })).data || [];
            if (type === 'world') data = (await apiJson(`${API_BASE}/agents/runs/${encodeURIComponent(runId)}/world-states?limit=120`, { cache: 'no-store' })).data || [];
            if (type === 'resources') data = (await apiJson(`${API_BASE}/agents/runs/${encodeURIComponent(runId)}/resources`, { cache: 'no-store' })).data || {};
            if (type === 'control') data = (await apiJson(`${API_BASE}/agents/runs/${encodeURIComponent(runId)}/control-messages?limit=100`, { cache: 'no-store' })).data || [];

            if (seq !== cache.sequence) return;
            const html = formatDiagnosticHtml(type, data);
            cache.panels[type] = html;
            cache.loaded[type] = true;
            setMarkup(panel, html);
        } catch (error) {
            if (seq !== cache.sequence) return;
            if (!cache.loaded[type] || !cache.panels[type]) {
                setMarkup(panel, `<div class="empty-state agent-harness-error">${escape(error.message || '诊断数据加载失败。')}</div>`);
            }
        } finally {
            cache.fetching[type] = false;
        }
    }

    function bindRunDiagnostics(root, runId) {
        const detail = root?.querySelector?.('.agent-run-harness-diagnostics');
        if (!detail || detail.dataset.bound === '1') return;
        detail.dataset.bound = '1';
        const cache = getDiagnosticCache(runId);
        let active = cache.activeTab || state.diagnostics.get(String(runId)) || 'context';
        cache.activeTab = active;
        state.diagnostics.set(String(runId), active);
        detail.dataset.agentHarnessActiveTab = active;

        const switchTab = (targetTab, shouldFetch = true) => {
            active = targetTab;
            cache.activeTab = active;
            state.diagnostics.set(String(runId), active);
            detail.dataset.agentHarnessActiveTab = active;

            // 1. 切换按钮常驻高亮状态，不发生 DOM 重建
            detail.querySelectorAll('[data-agent-harness-diagnostic-tab]').forEach(item => {
                const selected = item.dataset.agentHarnessDiagnosticTab === active;
                item.classList.toggle('active', selected);
                item.setAttribute('aria-selected', selected ? 'true' : 'false');
                item.tabIndex = selected ? 0 : -1;
            });

            // 2. 切换子面板常驻显示，零延迟且无内容闪烁
            detail.querySelectorAll('[data-agent-harness-panel]').forEach(panelEl => {
                const isMatch = panelEl.dataset.agentHarnessPanel === active;
                panelEl.classList.toggle('hidden', !isMatch);
            });

            // 3. 静默或平滑更新数据
            if (shouldFetch && detail.open) {
                loadDiagnostic(runId, active, detail, { silent: Boolean(cache.loaded[active]) });
            }
        };

        detail.addEventListener('toggle', () => {
            if (detail.open) {
                loadDiagnostic(runId, active, detail, { silent: Boolean(cache.loaded[active]) });
            }
        });

        detail.querySelectorAll('[data-agent-harness-diagnostic-tab]').forEach(button => {
            button.addEventListener('click', () => {
                const targetTab = button.dataset.agentHarnessDiagnosticTab || 'context';
                switchTab(targetTab, true);
            });
        });

        // 初始应用标签与常驻面板状态
        switchTab(active, false);
        if (detail.open) {
            loadDiagnostic(runId, active, detail, { silent: Boolean(cache.loaded[active]) });
        }

        // 控制表单提交与确认按钮绑定（事件委托）
        detail.addEventListener('submit', async event => {
            const form = event.target.closest('.agent-harness-control-form');
            if (!form) return;
            event.preventDefault();
            let payload = {};
            try { payload = JSON.parse(form.querySelector('[data-agent-control-payload]')?.value || '{}'); } catch (_) { return setNotice('控制消息内容必须是合法 JSON。', 'error'); }
            try {
                await apiJson(`${API_BASE}/agents/runs/${encodeURIComponent(runId)}/control-messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: form.querySelector('[data-agent-control-type]')?.value, payload }) });
                form.reset();
                await loadDiagnostic(runId, 'control', detail, { silent: true });
            } catch (error) {
                const controlPanel = detail.querySelector('[data-agent-harness-panel="control"]');
                if (controlPanel) prependMarkup(controlPanel, `<div class="empty-state agent-harness-error">${escape(error.message || '控制消息发送失败。')}</div>`);
            }
        });

        detail.addEventListener('click', async event => {
            const ack = event.target.closest('[data-agent-control-ack]');
            if (!ack) return;
            try {
                await apiJson(`${API_BASE}/agents/runs/${encodeURIComponent(runId)}/control-messages/${encodeURIComponent(ack.dataset.agentControlAck)}/ack`, { method: 'POST' });
                await loadDiagnostic(runId, 'control', detail, { silent: true });
            } catch (error) { setNotice(error.message || '控制消息确认失败。', 'error'); }
        });
    }

    function bindManagement() {
        document.querySelectorAll('[data-agent-harness-nav]').forEach(button => {
            button.addEventListener('click', () => {
                const target = button.dataset.agentHarnessNav;
                document.querySelectorAll('[data-agent-harness-nav]').forEach(b => {
                    const active = b.dataset.agentHarnessNav === target;
                    b.classList.toggle('active', active);
                    b.setAttribute('aria-selected', active ? 'true' : 'false');
                });
                document.querySelectorAll('[data-agent-harness-section]').forEach(sec => {
                    sec.classList.toggle('hidden', sec.dataset.agentHarnessSection !== target);
                });
            });
        });

        document.getElementById('agent-harness-skills-refresh')?.addEventListener('click', () => loadSkills().catch(error => setNotice(error.message, 'error')));
        document.getElementById('agent-harness-packs-refresh')?.addEventListener('click', () => loadPacks().catch(error => setNotice(error.message, 'error')));
        document.getElementById('agent-harness-residency-refresh')?.addEventListener('click', () => loadResidents().catch(error => setNotice(error.message, 'error')));
        document.getElementById('agent-harness-residency-scope')?.addEventListener('change', () => loadResidents().catch(error => setNotice(error.message, 'error')));
        document.getElementById('agent-harness-residency-sweep')?.addEventListener('click', () => sweepResidents());
        document.getElementById('agent-harness-skill-register')?.addEventListener('click', registerSkill);
        document.getElementById('agent-harness-pack-sync')?.addEventListener('click', syncPack);
        document.getElementById('agent-harness-skill-file')?.addEventListener('change', event => uploadSkillPackage(event.target.files?.[0]));
        document.getElementById('agent-harness-skill-list')?.addEventListener('click', event => {
            const button = event.target.closest('[data-agent-harness-disable-skill]');
            if (button) disableSkill(button.dataset.agentHarnessDisableSkill);
        });
        document.getElementById('agent-harness-residency-list')?.addEventListener('click', event => {
            const button = event.target.closest('[data-agent-harness-evict-resident]');
            if (button) evictResident(button.dataset.agentHarnessEvictResident);
        });
        document.getElementById('agent-profile-refresh')?.addEventListener('click', () => loadProfile().catch(error => setNotice(error.message, 'error')));
        document.getElementById('agent-profile-save')?.addEventListener('click', saveProfile);
        document.getElementById('agent-memory-policy-refresh')?.addEventListener('click', () => loadMemoryPolicy().catch(error => setNotice(error.message, 'error')));
        document.getElementById('agent-memory-policy-save')?.addEventListener('click', saveMemoryPolicy);
        document.querySelector('[data-memory-open]')?.addEventListener('click', event => { event.preventDefault(); window.showMainWorkspace?.('settings'); window.switchTab?.('memories'); });
        document.getElementById('agent-feedback-refresh')?.addEventListener('click', () => loadFeedback().catch(error => setNotice(error.message, 'error')));
        document.getElementById('agent-evolution-refresh')?.addEventListener('click', () => loadProposals().catch(error => setNotice(error.message, 'error')));
        document.getElementById('agent-evolution-create')?.addEventListener('click', createProposal);
        document.getElementById('agent-evolution-list')?.addEventListener('click', event => {
            const decision = event.target.closest('[data-agent-evolution-decision]');
            if (decision) return decideProposal(decision.dataset.agentEvolutionId, decision.dataset.agentEvolutionDecision);
            const apply = event.target.closest('[data-agent-evolution-apply]');
            if (apply) applyProposal(apply.dataset.agentEvolutionApply);
        });
    }

    window.Pivot?.exposeModule?.('agent.harness', {
        loadAgentHarnessManagement: loadHarnessManagement,
        bindAgentRunHarnessDiagnostics: bindRunDiagnostics,
        renderAgentHarnessDiagnosticMarkup: diagnosticTabMarkup,
        loadAgentHarnessSkills: loadSkills,
        getAgentHarnessSkillId: () => document.getElementById('agent-skill-select')?.value || ''
    }, [
        'loadAgentHarnessManagement',
        'bindAgentRunHarnessDiagnostics',
        'renderAgentHarnessDiagnosticMarkup',
        'loadAgentHarnessSkills',
        'getAgentHarnessSkillId'
    ]);

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindManagement, { once: true });
    else bindManagement();
})();
