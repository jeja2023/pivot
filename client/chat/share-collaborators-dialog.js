/* 通用协作者与共享面板组件
 * 统一协作者与共享面板（与 PPT 制作应用协作者面板完全对齐）
 * 供知识库（专题库共享）、自动化工作流（工作流共享）、思维导图（导图共享）通用
 */
(function (root) {
    'use strict';

    const UNASSIGNED_UNIT = '未分配单位';

    function escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function escapeAttr(value) {
        return escapeHtml(value);
    }

    function toast(message, type = 'success') {
        if (typeof root.showToast === 'function') {
            root.showToast(message, type);
        } else if (typeof root.Pivot?.legacy?.showToast === 'function') {
            root.Pivot.legacy.showToast(message, type);
        }
    }

    function createSvgIcon(type, size = 12) {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('width', String(size));
        svg.setAttribute('height', String(size));
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        if (type === 'check') {
            svg.setAttribute('stroke-width', '3');
            const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
            poly.setAttribute('points', '20 6 9 17 4 12');
            svg.appendChild(poly);
        } else if (type === 'unit') {
            svg.setAttribute('stroke-width', '2');
            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('d', 'M3 21h18M3 7v14M21 7v14M9 3h6v18H9zM9 7h6M9 11h6M9 15h6');
            svg.appendChild(path);
        } else if (type === 'trash') {
            svg.setAttribute('stroke-width', '2');
            const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
            poly.setAttribute('points', '3 6 5 6 21 6');
            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('d', 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2');
            svg.append(poly, path);
        }
        return svg;
    }

    function createUnitBadge(unitName) {
        const badge = document.createElement('div');
        badge.className = 'presentation-collab-unit-badge';
        badge.appendChild(createSvgIcon('unit', 11));
        const text = document.createElement('span');
        text.textContent = unitName || UNASSIGNED_UNIT;
        badge.appendChild(text);
        return badge;
    }

    function open(options = {}) {
        const modalId = String(options.modalId || 'pivot-collab-modal');
        const title = String(options.title || '协作者与共享');
        const subtitle = String(options.subtitle || '管理协同审阅、编辑与查看的成员与单位协作权限。');
        const summaryTitle = options.summaryTitle ? String(options.summaryTitle) : '';
        const summaryDesc = options.summaryDesc ? String(options.summaryDesc) : '';
        const defaultRole = String(options.defaultRole || (options.roles?.[0]?.value || 'viewer'));
        const roles = Array.isArray(options.roles) && options.roles.length > 0
            ? options.roles
            : [{ value: 'viewer', label: '查看者（仅浏览）', shortLabel: '查看者' }];

        // 统一候选人数据
        const rawUsers = Array.isArray(options.users) ? options.users : [];
        const candidateUsers = rawUsers
            .filter(u => Number(u?.id) > 0)
            .map(u => ({
                id: Number(u.id),
                username: String(u.username || '').trim(),
                nickname: String(u.nickname || '').trim(),
                unit: String(u.unit || '').trim() || UNASSIGNED_UNIT
            }));

        const userMap = new Map();
        candidateUsers.forEach(u => {
            userMap.set(u.id, u);
            if (u.username) userMap.set(u.username, u);
        });

        // 统计单位与人数
        const unitCounts = new Map();
        candidateUsers.forEach(u => {
            unitCounts.set(u.unit, (unitCounts.get(u.unit) || 0) + 1);
        });

        // 候选单位列表
        const candidateUnits = Array.from(unitCounts.keys())
            .sort((a, b) => {
                if (a === UNASSIGNED_UNIT) return 1;
                if (b === UNASSIGNED_UNIT) return -1;
                return a.localeCompare(b, 'zh-CN');
            })
            .map(name => ({
                name,
                count: unitCounts.get(name) || 0
            }));

        // 所有者信息
        const owner = options.owner ? {
            id: Number(options.owner.id || options.owner.userId || 0),
            username: String(options.owner.username || '').trim(),
            nickname: String(options.owner.nickname || options.owner.userName || '').trim(),
            unit: String(options.owner.unit || '').trim() || UNASSIGNED_UNIT
        } : null;

        // 初始协作者列表
        const initialCollabs = Array.isArray(options.initialCollaborators) ? options.initialCollaborators : [];
        const collaboratorMap = new Map();
        initialCollabs.forEach(item => {
            const id = Number(item.id || item.userId);
            if (!Number.isSafeInteger(id) || id <= 0) return;
            if (owner && id === owner.id) return;
            const user = userMap.get(id);
            collaboratorMap.set(id, {
                id,
                username: user?.username || item.username || '',
                nickname: user?.nickname || item.nickname || item.userName || item.name || '',
                unit: user?.unit || item.unit || UNASSIGNED_UNIT,
                role: item.role || defaultRole
            });
        });

        // 对话框状态
        const state = {
            activeTab: 'unit-user',
            selectedBatchUnits: new Set(),
            collaborators: Array.from(collaboratorMap.values()),
            saving: false
        };

        // 获取或创建模态框遮罩
        let modal = document.getElementById(modalId);
        if (!modal) {
            modal = document.createElement('div');
            modal.id = modalId;
            modal.className = 'modal-overlay hidden';
            document.body.appendChild(modal);
        }
        modal.classList.add('knowledge-share-modal-overlay', 'agent-workflow-share-modal-overlay');
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
        modal.setAttribute('aria-labelledby', `${modalId}-title`);

        const roleOptionsHtml = roles.map(r => `<option value="${escapeAttr(r.value)}">${escapeHtml(r.label)}</option>`).join('');

        const modalHtml = `
            <div class="modal presentation-collab-dialog pivot-collab-dialog">
                <div class="presentation-create-dialog-head">
                    <div class="presentation-create-dialog-title-group">
                        <h3 id="${modalId}-title">${escapeHtml(title)}</h3>
                        <p>${escapeHtml(subtitle)}</p>
                    </div>
                </div>
                <div class="presentation-collab-body">
                    ${summaryTitle ? `
                    <div class="agent-workflow-share-summary">
                        <strong>${escapeHtml(summaryTitle)}</strong>
                        <span>${escapeHtml(summaryDesc)}</span>
                    </div>` : ''}

                    <div class="presentation-collab-tabs" role="tablist">
                        <button id="${modalId}-tab-unit-user" class="btn-secondary presentation-collab-tab is-active" type="button">按单位选人</button>
                        <button id="${modalId}-tab-search-user" class="btn-secondary presentation-collab-tab" type="button">直接搜索用户</button>
                        <button id="${modalId}-tab-unit" class="btn-secondary presentation-collab-tab" type="button">按单位批量授权</button>
                    </div>

                    <!-- 模式一：按单位选人 -->
                    <form id="${modalId}-form-unit-user" class="presentation-collab-panel">
                        <div class="presentation-collab-grid-unit-user">
                            <div class="presentation-collab-field">
                                <label class="presentation-collab-label" for="${modalId}-unit-filter">所属单位（联动筛选）</label>
                                <select id="${modalId}-unit-filter" class="form-input presentation-collab-select">
                                    <option value="">全部单位 (${candidateUsers.length} 人)</option>
                                    ${candidateUnits.map(u => `<option value="${escapeAttr(u.name)}">${escapeHtml(u.name)} (${u.count} 人)</option>`).join('')}
                                </select>
                            </div>
                            <div class="presentation-collab-field">
                                <label class="presentation-collab-label" for="${modalId}-unit-user-select">单位成员列表</label>
                                <select id="${modalId}-unit-user-select" class="form-input presentation-collab-select" required>
                                    <option value="">点击选择单位成员…</option>
                                </select>
                            </div>
                            <div class="presentation-collab-field">
                                <label class="presentation-collab-label" for="${modalId}-unit-user-role">协作角色</label>
                                <select id="${modalId}-unit-user-role" class="form-input presentation-collab-select">
                                    ${roleOptionsHtml}
                                </select>
                            </div>
                            <div class="presentation-collab-field presentation-collab-btn-cell">
                                <button id="${modalId}-unit-user-submit-btn" class="btn-primary presentation-collab-submit-btn" type="submit">添加该成员</button>
                            </div>
                        </div>
                    </form>

                    <!-- 模式二：直接搜索用户 -->
                    <form id="${modalId}-form-search" class="presentation-collab-panel hidden">
                        <div class="presentation-collab-grid-search">
                            <div class="presentation-collab-field presentation-collab-search-field">
                                <label class="presentation-collab-label" for="${modalId}-search-username">直接搜索或输入用户</label>
                                <input id="${modalId}-search-username" class="form-input presentation-collab-input" placeholder="输入用户名、昵称或 ID 搜索…" autocomplete="off" required list="${modalId}-user-datalist">
                                <datalist id="${modalId}-user-datalist">
                                    ${candidateUsers.map(u => `<option value="${escapeAttr(u.username)}">${escapeHtml(u.nickname || u.username)}（${escapeHtml(u.unit)}）</option>`).join('')}
                                </datalist>
                            </div>
                            <div class="presentation-collab-field presentation-collab-role-field">
                                <label class="presentation-collab-label" for="${modalId}-search-role">协作角色</label>
                                <select id="${modalId}-search-role" class="form-input presentation-collab-select">
                                    ${roleOptionsHtml}
                                </select>
                            </div>
                            <div class="presentation-collab-field presentation-collab-btn-cell">
                                <button id="${modalId}-search-submit-btn" class="btn-primary presentation-collab-submit-btn" type="submit">添加成员</button>
                            </div>
                        </div>
                    </form>

                    <!-- 模式三：按单位批量授权 -->
                    <div id="${modalId}-panel-unit" class="presentation-collab-panel hidden">
                        <div class="presentation-collab-unit-desc">
                            <span>勾选需要开放协作的单位（支持多选），所选单位的全部成员将直接获得协作权限：</span>
                        </div>
                        <div id="${modalId}-units-group" class="presentation-collab-units-group">
                            ${candidateUnits.length ? candidateUnits.map(u => `
                                <div class="presentation-collab-unit-card" data-collab-unit="${escapeAttr(u.name)}">
                                    <span class="presentation-collab-check-icon">
                                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>
                                    </span>
                                    <span class="presentation-collab-unit-icon">
                                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 21h18M3 7v14M21 7v14M9 3h6v18H9zM9 7h6M9 11h6M9 15h6"/></svg>
                                    </span>
                                    <strong>${escapeHtml(u.name)}</strong>
                                    <small>${u.count}人</small>
                                </div>
                            `).join('') : '<div class="agent-workflow-share-empty">暂无可授权的单位数据</div>'}
                        </div>
                        <div class="presentation-collab-unit-actions-row">
                            <div class="presentation-collab-field presentation-collab-role-field">
                                <label class="presentation-collab-label" for="${modalId}-batch-role">所选单位协作权限</label>
                                <select id="${modalId}-batch-role" class="form-input presentation-collab-select">
                                    ${roleOptionsHtml}
                                </select>
                            </div>
                            <div class="presentation-collab-field presentation-collab-btn-cell">
                                <button id="${modalId}-batch-submit-btn" class="btn-primary presentation-collab-submit-btn" type="button">一键授权所选单位</button>
                            </div>
                        </div>
                    </div>

                    <!-- 协作者列表区 -->
                    <div class="presentation-collab-list-section">
                        <div class="presentation-collab-list-head">
                            <strong>已加入协作成员</strong>
                            <span id="${modalId}-collab-count" class="presentation-collab-badge">0 人</span>
                        </div>
                        <div id="${modalId}-collab-list" class="presentation-collab-list"></div>
                    </div>

                    <div id="${modalId}-error" class="agent-workflow-share-error" role="alert" hidden></div>
                </div>
                <div class="presentation-create-actions presentation-collab-actions">
                    <button id="${modalId}-save-btn" class="btn-primary" type="button">保存</button>
                    <button id="${modalId}-close-btn" class="btn-secondary" type="button">关闭</button>
                </div>
            </div>
        `;

        if (typeof PivotSafeHtml !== 'undefined' && typeof PivotSafeHtml.setHtml === 'function') {
            PivotSafeHtml.setHtml(modal, modalHtml);
        } else if (typeof root.PivotSafeHtml?.setHtml === 'function') {
            root.PivotSafeHtml.setHtml(modal, modalHtml);
        } else if (typeof root.Pivot?.safeHtml?.setHtml === 'function') {
            root.Pivot.safeHtml.setHtml(modal, modalHtml);
        } else if (typeof root.DOMParser === 'function') {
            const parser = new root.DOMParser();
            const doc = parser.parseFromString(modalHtml, 'text/html');
            modal.replaceChildren(...doc.body.childNodes);
        }

        const byId = id => document.getElementById(id);

        function setError(msg = '') {
            const errEl = byId(`${modalId}-error`);
            if (!errEl) return;
            errEl.textContent = msg;
            errEl.hidden = !msg;
        }

        function switchTab(tab) {
            state.activeTab = tab;
            byId(`${modalId}-tab-unit-user`)?.classList.toggle('is-active', tab === 'unit-user');
            byId(`${modalId}-tab-search-user`)?.classList.toggle('is-active', tab === 'search');
            byId(`${modalId}-tab-unit`)?.classList.toggle('is-active', tab === 'unit');

            byId(`${modalId}-form-unit-user`)?.classList.toggle('hidden', tab !== 'unit-user');
            byId(`${modalId}-form-search`)?.classList.toggle('hidden', tab !== 'search');
            byId(`${modalId}-panel-unit`)?.classList.toggle('hidden', tab !== 'unit');
            setError('');
        }

        function updateUnitUserSelect() {
            const select = byId(`${modalId}-unit-user-select`);
            if (!select) return;
            const selectedUnit = byId(`${modalId}-unit-filter`)?.value || '';
            select.replaceChildren();

            const defaultOpt = document.createElement('option');
            defaultOpt.value = '';
            defaultOpt.textContent = selectedUnit ? `选择 ${selectedUnit} 成员…` : '点击选择单位成员…';
            select.appendChild(defaultOpt);

            const filtered = selectedUnit
                ? candidateUsers.filter(u => u.unit === selectedUnit)
                : candidateUsers;

            filtered.forEach(u => {
                if (owner && u.id === owner.id) return;
                const opt = document.createElement('option');
                opt.value = String(u.id);
                opt.textContent = selectedUnit
                    ? `${u.nickname || u.username}（@${u.username}）`
                    : `${u.nickname || u.username} · ${u.unit}`;
                select.appendChild(opt);
            });
        }

        function renderCollaboratorsList() {
            const list = byId(`${modalId}-collab-list`);
            const countBadge = byId(`${modalId}-collab-count`);
            if (!list) return;
            list.replaceChildren();

            const total = state.collaborators.length + (owner ? 1 : 0);
            if (countBadge) countBadge.textContent = `${total} 人`;

            // 1. 置顶渲染所有者行
            if (owner) {
                const ownerRow = document.createElement('div');
                ownerRow.className = 'presentation-collab-row is-owner';

                const userWrap = document.createElement('div');
                userWrap.className = 'presentation-collab-user';

                const avatar = document.createElement('div');
                avatar.className = 'presentation-collab-avatar is-owner';
                avatar.textContent = (owner.nickname || owner.username || '主').slice(0, 1).toUpperCase();

                const info = document.createElement('div');
                info.className = 'presentation-collab-info';

                const nameLine = document.createElement('div');
                nameLine.className = 'presentation-collab-name-line';
                const name = document.createElement('strong');
                name.textContent = owner.nickname || owner.username;
                const handle = document.createElement('span');
                handle.className = 'presentation-collab-username';
                handle.textContent = owner.username ? `@${owner.username}` : '';
                nameLine.append(name, handle);

                const unitTag = createUnitBadge(owner.unit);
                info.append(nameLine, unitTag);
                userWrap.append(avatar, info);

                const ownerBadge = document.createElement('span');
                ownerBadge.className = 'presentation-collab-role-tag is-owner';
                ownerBadge.textContent = '所有者';

                ownerRow.append(userWrap, ownerBadge);
                list.appendChild(ownerRow);
            }

            if (!state.collaborators.length) {
                if (!owner) {
                    const empty = document.createElement('div');
                    empty.className = 'agent-workflow-share-empty';
                    empty.textContent = '暂无其他协作者。可按单位选人或批量授权。';
                    list.appendChild(empty);
                }
                return;
            }

            // 2. 协作者列表
            state.collaborators.forEach(c => {
                const row = document.createElement('div');
                row.className = 'presentation-collab-row';

                const userWrap = document.createElement('div');
                userWrap.className = 'presentation-collab-user';

                const avatar = document.createElement('div');
                avatar.className = 'presentation-collab-avatar';
                avatar.textContent = (c.nickname || c.username || '协').slice(0, 1).toUpperCase();

                const info = document.createElement('div');
                info.className = 'presentation-collab-info';

                const nameLine = document.createElement('div');
                nameLine.className = 'presentation-collab-name-line';
                const name = document.createElement('strong');
                name.textContent = c.nickname || c.username || `用户 #${c.id}`;
                const handle = document.createElement('span');
                handle.className = 'presentation-collab-username';
                handle.textContent = c.username ? `@${c.username}` : '';
                nameLine.append(name, handle);

                const unitTag = createUnitBadge(c.unit);
                info.append(nameLine, unitTag);
                userWrap.append(avatar, info);

                const actions = document.createElement('div');
                actions.className = 'presentation-collab-row-actions';

                if (roles.length > 1) {
                    const roleSelect = document.createElement('select');
                    roleSelect.className = 'form-input presentation-collab-select';
                    roles.forEach(r => {
                        const opt = document.createElement('option');
                        opt.value = r.value;
                        opt.textContent = r.shortLabel || r.label;
                        if (r.value === c.role) opt.selected = true;
                        roleSelect.appendChild(opt);
                    });
                    roleSelect.addEventListener('change', () => {
                        c.role = roleSelect.value;
                    });
                    actions.appendChild(roleSelect);
                } else {
                    const roleTag = document.createElement('span');
                    roleTag.className = `presentation-collab-role-tag is-${roles[0].value}`;
                    roleTag.textContent = roles[0].shortLabel || roles[0].label;
                    actions.appendChild(roleTag);
                }

                const removeBtn = document.createElement('button');
                removeBtn.type = 'button';
                removeBtn.className = 'btn-secondary presentation-collab-remove-btn';
                removeBtn.textContent = '移除';
                removeBtn.title = '移除协作者';
                removeBtn.addEventListener('click', () => {
                    state.collaborators = state.collaborators.filter(item => item.id !== c.id);
                    renderCollaboratorsList();
                });
                actions.appendChild(removeBtn);

                row.append(userWrap, actions);
                list.appendChild(row);
            });
        }

        function addCollaborator(user, role) {
            if (!user || !user.id) return;
            if (owner && user.id === owner.id) {
                toast('该成员为文档所有者，无需额外添加。', 'info');
                return;
            }
            const existing = state.collaborators.find(item => item.id === user.id);
            if (existing) {
                existing.role = role;
                toast(`已更新「${user.nickname || user.username}」的权限。`);
            } else {
                state.collaborators.push({
                    id: user.id,
                    username: user.username,
                    nickname: user.nickname,
                    unit: user.unit,
                    role
                });
                toast(`已添加「${user.nickname || user.username}」。`);
            }
            renderCollaboratorsList();
            setError('');
        }

        // 事件绑定
        byId(`${modalId}-tab-unit-user`)?.addEventListener('click', () => switchTab('unit-user'));
        byId(`${modalId}-tab-search-user`)?.addEventListener('click', () => switchTab('search'));
        byId(`${modalId}-tab-unit`)?.addEventListener('click', () => switchTab('unit'));

        byId(`${modalId}-unit-filter`)?.addEventListener('change', updateUnitUserSelect);

        // 模式一提交
        byId(`${modalId}-form-unit-user`)?.addEventListener('submit', e => {
            e.preventDefault();
            const select = byId(`${modalId}-unit-user-select`);
            const roleSelect = byId(`${modalId}-unit-user-role`);
            const userId = Number(select?.value);
            if (!userId) {
                toast('请先选择需要添加的成员。', 'warning');
                return;
            }
            const user = userMap.get(userId);
            if (user) {
                addCollaborator(user, roleSelect?.value || defaultRole);
                select.value = '';
            }
        });

        // 模式二提交
        byId(`${modalId}-form-search`)?.addEventListener('submit', e => {
            e.preventDefault();
            const input = byId(`${modalId}-search-username`);
            const roleSelect = byId(`${modalId}-search-role`);
            const queryText = (input?.value || '').trim();
            if (!queryText) {
                toast('请输入用户名、昵称或 ID 进行搜索。', 'warning');
                return;
            }
            const match = candidateUsers.find(u =>
                String(u.id) === queryText ||
                u.username.toLowerCase() === queryText.toLowerCase() ||
                u.nickname.toLowerCase() === queryText.toLowerCase()
            );
            if (!match) {
                toast(`未找到匹配「${queryText}」的用户。`, 'warning');
                return;
            }
            addCollaborator(match, roleSelect?.value || defaultRole);
            input.value = '';
        });

        // 模式三：单位卡片点击勾选
        byId(`${modalId}-units-group`)?.querySelectorAll('[data-collab-unit]').forEach(card => {
            card.addEventListener('click', () => {
                const unitName = card.dataset.collabUnit;
                if (!unitName) return;
                if (state.selectedBatchUnits.has(unitName)) {
                    state.selectedBatchUnits.delete(unitName);
                    card.classList.remove('is-selected');
                } else {
                    state.selectedBatchUnits.add(unitName);
                    card.classList.add('is-selected');
                }
            });
        });

        // 模式三：批量授权提交
        byId(`${modalId}-batch-submit-btn`)?.addEventListener('click', () => {
            if (!state.selectedBatchUnits.size) {
                toast('请先点击勾选需要授权的单位。', 'warning');
                return;
            }
            const role = byId(`${modalId}-batch-role`)?.value || defaultRole;
            let addedCount = 0;
            state.selectedBatchUnits.forEach(unitName => {
                const members = candidateUsers.filter(u => u.unit === unitName);
                members.forEach(m => {
                    if (owner && m.id === owner.id) return;
                    const existing = state.collaborators.find(item => item.id === m.id);
                    if (existing) {
                        existing.role = role;
                    } else {
                        state.collaborators.push({
                            id: m.id,
                            username: m.username,
                            nickname: m.nickname,
                            unit: m.unit,
                            role
                        });
                        addedCount += 1;
                    }
                });
            });

            const unitNames = Array.from(state.selectedBatchUnits).join('、');
            state.selectedBatchUnits.clear();
            byId(`${modalId}-units-group`)?.querySelectorAll('[data-collab-unit]').forEach(c => c.classList.remove('is-selected'));
            renderCollaboratorsList();
            toast(`已为单位「${unitNames}」授权，新增协作成员 ${addedCount} 人。`);
        });

        function closeModal() {
            modal.classList.add('hidden');
            if (typeof options.onClose === 'function') options.onClose();
        }

        byId(`${modalId}-close-btn`)?.addEventListener('click', closeModal);

        modal.addEventListener('click', e => {
            if (e.target === modal) closeModal();
        });

        // 保存操作
        const saveBtn = byId(`${modalId}-save-btn`);
        if (saveBtn) {
            saveBtn.addEventListener('click', async () => {
                if (state.saving) return;
                state.saving = true;
                saveBtn.disabled = true;
                setError('');
                try {
                    if (typeof options.onSave === 'function') {
                        await options.onSave({
                            collaborators: state.collaborators,
                            selectedBatchUnits: Array.from(state.selectedBatchUnits)
                        });
                    }
                    closeModal();
                } catch (err) {
                    setError(err?.message || '保存共享设置失败，请稍后重试。');
                    toast(err?.message || '保存共享设置失败', 'error');
                } finally {
                    state.saving = false;
                    saveBtn.disabled = false;
                }
            });
        }

        // 初始化渲染
        updateUnitUserSelect();
        renderCollaboratorsList();
        modal.classList.remove('hidden');
    }

    const api = Object.freeze({
        open,
        escapeHtml,
        escapeAttr
    });

    if (root.Pivot) {
        if (typeof root.Pivot.registerModule === 'function') {
            root.Pivot.registerModule('share.collaborators', api);
        }
        if (root.Pivot.legacy) {
            root.Pivot.legacy.PivotShareCollabModal = api;
        }
    }
}(window));
