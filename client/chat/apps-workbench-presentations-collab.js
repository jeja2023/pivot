(function () {
    if (window.Pivot?.moduleApi?.('apps.presentations.collab')?.ready) return;

    const API = '/api/apps/presentations';
    const state = {
        presenceTimer: null,
        activePresentationId: '',
        activeSlideIdProvider: null,
        presences: [],
        comments: [],
        commentsFilter: 'slide',
        activeReplyId: null,
        collaborators: [],
        activeTab: 'unit-user',
        selectedBatchUnits: new Set(),
        candidates: { units: [], users: [] }
    };

    const byId = id => document.getElementById(id);

    function toast(message, type = 'success') {
        if (typeof showToast === 'function') showToast(message, type);
    }

    async function requestJson(url, options = {}) {
        const res = await apiFetch(url, options);
        const data = await res.clone().json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error?.message || data?.error || data?.message || `请求失败（${res.status}）`);
        return data;
    }

    function jsonOptions(body) {
        return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
    }

    function formatTime(value) {
        if (!value) return '刚刚';
        const date = new Date(String(value).replace(' ', 'T'));
        return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('zh-CN', { hour12: false });
    }

    // ==========================================
    // 1. Presence (在线状态与心跳)
    // ==========================================
    function startPresenceHeartbeat(presentationId, slideIdProvider) {
        stopPresenceHeartbeat();
        state.activePresentationId = String(presentationId || '').trim();
        state.activeSlideIdProvider = typeof slideIdProvider === 'function' ? slideIdProvider : () => '';
        if (!state.activePresentationId) return;

        sendPresenceHeartbeat().catch(() => {});
        state.presenceTimer = window.setInterval(() => {
            sendPresenceHeartbeat().catch(() => {});
        }, 15000);
    }

    async function sendPresenceHeartbeat() {
        if (!state.activePresentationId) return;
        try {
            const currentSlideId = state.activeSlideIdProvider ? state.activeSlideIdProvider() : '';
            const data = await requestJson(`${API}/${encodeURIComponent(state.activePresentationId)}/presence`, jsonOptions({
                activeSlideId: currentSlideId || '',
                slideId: currentSlideId || ''
            }));
            const list = Array.isArray(data.presences) ? data.presences : (Array.isArray(data.activeCollaborators) ? data.activeCollaborators : []);
            state.presences = list;
            renderPresenceBar();
        } catch (_) {}
    }

    function stopPresenceHeartbeat() {
        if (state.presenceTimer) {
            clearInterval(state.presenceTimer);
            state.presenceTimer = null;
        }
        if (state.activePresentationId) {
            apiFetch(`${API}/${encodeURIComponent(state.activePresentationId)}/presence`, { method: 'DELETE' }).catch(() => {});
            state.activePresentationId = '';
        }
        state.presences = [];
        renderPresenceBar();
    }

    function renderPresenceBar() {
        const bar = byId('presentation-presence-bar');
        if (!bar) return;
        bar.replaceChildren();
        if (!state.presences.length) return;
        const colors = ['#2563eb', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4', '#6366f1'];
        state.presences.forEach((p, idx) => {
            const avatar = document.createElement('div');
            avatar.className = 'presentation-presence-avatar';
            avatar.style.background = colors[idx % colors.length];
            const name = p.displayName || p.username || '用';
            avatar.textContent = name.charAt(0).toUpperCase();
            const slideText = p.slideId ? `正在查看页面` : '浏览中';
            avatar.title = `${name} · ${slideText}`;
            const pulse = document.createElement('span');
            pulse.className = 'presentation-presence-pulse';
            avatar.appendChild(pulse);
            bar.appendChild(avatar);
        });
        if (state.presences.length > 1) {
            const count = document.createElement('span');
            count.className = 'presentation-presence-count';
            count.textContent = `${state.presences.length}人在线`;
            bar.appendChild(count);
        }
    }

    // ==========================================
    // 2. Comments (评论线程与批注)
    // ==========================================
    async function loadComments(presentationId) {
        const pId = presentationId || state.activePresentationId;
        if (!pId) return;
        try {
            const data = await requestJson(`${API}/${encodeURIComponent(pId)}/comments`);
            state.comments = Array.isArray(data.comments) ? data.comments : [];
            updateCommentsBadge();
            renderComments();
        } catch (err) {
            console.warn('Failed to load comments', err);
        }
    }

    function updateCommentsBadge() {
        const badge = byId('presentation-comments-badge');
        if (!badge) return;
        const unresolved = state.comments.filter(c => c.status !== 'resolved' && !c.resolved).length;
        badge.textContent = unresolved > 0 ? String(unresolved) : '';
        badge.classList.toggle('hidden', unresolved === 0);
    }

    function setCommentsFilter(mode) {
        state.commentsFilter = mode === 'all' ? 'all' : 'slide';
        byId('presentation-comments-filter-slide')?.classList.toggle('is-active', state.commentsFilter === 'slide');
        byId('presentation-comments-filter-all')?.classList.toggle('is-active', state.commentsFilter === 'all');
        renderComments();
    }

    function renderComments() {
        const list = byId('presentation-comments-list');
        if (!list) return;
        list.replaceChildren();
        const currentSlideId = state.activeSlideIdProvider ? state.activeSlideIdProvider() : '';
        const filterSlide = state.commentsFilter === 'slide';
        let displayed = state.comments;
        if (filterSlide && currentSlideId) {
            displayed = state.comments.filter(c => c.slideId === currentSlideId);
        }
        if (!displayed.length) {
            const empty = document.createElement('div');
            empty.className = 'presentation-empty-note';
            empty.textContent = filterSlide ? '当前页暂无评论批注。' : '当前文稿暂无评论批注。';
            list.appendChild(empty);
            return;
        }
        displayed.forEach(comment => {
            list.appendChild(renderCommentCard(comment));
        });
    }

    function renderCommentCard(comment) {
        const isResolved = comment.status === 'resolved' || Boolean(comment.resolved);
        const card = document.createElement('article');
        card.className = `presentation-comment-card${isResolved ? ' is-resolved' : ''}`;

        const meta = document.createElement('div');
        meta.className = 'presentation-comment-meta';
        const left = document.createElement('div');
        left.style.display = 'flex';
        left.style.alignItems = 'center';
        left.style.gap = '6px';
        const author = document.createElement('strong');
        author.className = 'presentation-comment-author';
        author.textContent = comment.userName || comment.username || '用户';
        const time = document.createElement('span');
        time.className = 'presentation-comment-time';
        time.textContent = formatTime(comment.createdAt);
        left.append(author, time);

        const right = document.createElement('div');
        right.style.display = 'flex';
        right.style.alignItems = 'center';
        right.style.gap = '6px';
        if (comment.slideId) {
            const tag = document.createElement('span');
            tag.className = 'presentation-comment-slide-tag';
            tag.textContent = '页面批注';
            right.appendChild(tag);
        }
        if (isResolved) {
            const resTag = document.createElement('span');
            resTag.className = 'presentation-comment-slide-tag';
            resTag.style.background = '#f1f5f9';
            resTag.style.color = '#64748b';
            resTag.textContent = '已解决';
            right.appendChild(resTag);
        }
        meta.append(left, right);

        const body = document.createElement('div');
        body.className = 'presentation-comment-body';
        body.textContent = comment.content;

        const actions = document.createElement('div');
        actions.className = 'presentation-comment-actions';

        const replyBtn = document.createElement('button');
        replyBtn.type = 'button';
        replyBtn.textContent = '回复';
        replyBtn.dataset.commentAction = 'reply';
        replyBtn.dataset.commentId = String(comment.id);

        const resolveBtn = document.createElement('button');
        resolveBtn.type = 'button';
        resolveBtn.textContent = isResolved ? '重新打开' : '解决';
        resolveBtn.dataset.commentAction = 'resolve';
        resolveBtn.dataset.commentId = String(comment.id);
        resolveBtn.dataset.resolved = String(!isResolved);

        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'btn-danger-text';
        deleteBtn.textContent = '删除';
        deleteBtn.dataset.commentAction = 'delete';
        deleteBtn.dataset.commentId = String(comment.id);

        actions.append(replyBtn, resolveBtn, deleteBtn);
        card.append(meta, body, actions);

        if (Array.isArray(comment.replies) && comment.replies.length > 0) {
            const repliesContainer = document.createElement('div');
            repliesContainer.className = 'presentation-comment-replies';
            comment.replies.forEach(reply => {
                const replyEl = document.createElement('div');
                replyEl.className = 'presentation-comment-body';
                replyEl.style.fontSize = '0.72rem';
                const rAuthor = document.createElement('strong');
                rAuthor.textContent = `${reply.userName || reply.username || '用户'}: `;
                replyEl.appendChild(rAuthor);
                replyEl.appendChild(document.createTextNode(reply.content));
                const rTime = document.createElement('span');
                rTime.className = 'presentation-comment-time';
                rTime.style.marginLeft = '6px';
                rTime.textContent = formatTime(reply.createdAt);
                replyEl.appendChild(rTime);
                repliesContainer.appendChild(replyEl);
            });
            card.appendChild(repliesContainer);
        }

        if (String(state.activeReplyId) === String(comment.id)) {
            const replyBox = document.createElement('div');
            replyBox.className = 'presentation-reply-box';
            const replyInput = document.createElement('textarea');
            replyInput.className = 'form-input';
            replyInput.rows = 2;
            replyInput.placeholder = `回复 ${comment.userName || comment.username || '用户'}…`;
            replyInput.id = `presentation-reply-input-${comment.id}`;
            const replyActions = document.createElement('div');
            replyActions.className = 'presentation-reply-box-actions';
            const cancelBtn = document.createElement('button');
            cancelBtn.type = 'button';
            cancelBtn.className = 'btn-secondary';
            cancelBtn.textContent = '取消';
            cancelBtn.dataset.replyAction = 'cancel';
            const sendBtn = document.createElement('button');
            sendBtn.type = 'button';
            sendBtn.className = 'btn-primary';
            sendBtn.textContent = '发送';
            sendBtn.dataset.replyAction = 'send';
            sendBtn.dataset.commentId = String(comment.id);
            replyActions.append(cancelBtn, sendBtn);
            replyBox.append(replyInput, replyActions);
            card.appendChild(replyBox);
        }

        return card;
    }

    async function submitComment(content, parentId = null) {
        if (!state.activePresentationId || !content || !content.trim()) return;
        const currentSlideId = state.activeSlideIdProvider ? state.activeSlideIdProvider() : null;
        await requestJson(`${API}/${encodeURIComponent(state.activePresentationId)}/comments`, jsonOptions({
            slideId: currentSlideId || null,
            content: content.trim(),
            parentId: parentId ? Number(parentId) : null
        }));
        state.activeReplyId = null;
        const input = byId('presentation-comment-input');
        if (input && !parentId) input.value = '';
        await loadComments();
        toast(parentId ? '回复已发表。' : '评论已发表。');
    }

    async function resolveComment(commentId) {
        if (!state.activePresentationId || !commentId) return;
        await requestJson(`${API}/${encodeURIComponent(state.activePresentationId)}/comments/${encodeURIComponent(commentId)}/resolve`, jsonOptions({}));
        await loadComments();
        toast('评论状态已更新。');
    }

    async function deleteComment(commentId) {
        if (!state.activePresentationId || !commentId) return;
        const accepted = await window.Pivot?.legacy?.showConfirm?.('删除评论', '确定要删除这条评论吗？');
        if (!accepted) return;
        await requestJson(`${API}/${encodeURIComponent(state.activePresentationId)}/comments/${encodeURIComponent(commentId)}`, {
            method: 'DELETE'
        });
        await loadComments();
        toast('评论已删除。');
    }

    // ==========================================
    // 3. Collaborators (演示文稿协作者管理)
    // ==========================================
    function openCollaboratorsModal() {
        if (!state.activePresentationId) return;
        const modal = byId('presentation-collaborators-modal');
        modal?.classList.remove('hidden');
        if (modal && !modal.dataset.collabBound) {
            modal.dataset.collabBound = 'true';
            modal.addEventListener('change', handleCollabChange);
        }
        switchCollabTab('unit-user');
        loadCollaboratorCandidates().catch(() => {});
        loadCollaborators().catch(err => toast(err.message, 'error'));
    }

    function closeCollaboratorsModal() {
        try {
            const usernameInput = byId('presentation-collab-username');
            if (usernameInput) usernameInput.value = '';
            const userSelect = byId('presentation-collab-unit-user-select') || byId('presentation-collab-user-select');
            if (userSelect) userSelect.value = '';
            if (state.selectedBatchUnits instanceof Set) {
                state.selectedBatchUnits.clear();
            } else {
                state.selectedBatchUnits = new Set();
            }
        } catch (_) {}
        byId('presentation-collaborators-modal')?.classList.add('hidden');
    }

    async function saveCollaboratorsAndClose() {
        if (!state.activePresentationId) {
            closeCollaboratorsModal();
            return;
        }
        try {
            if (state.activeTab === 'unit-user') {
                const username = byId('presentation-collab-unit-user-select')?.value;
                if (username) {
                    const role = byId('presentation-collab-unit-user-role')?.value || 'editor';
                    await addCollaborator(username, role);
                } else {
                    toast('协作设置已保存。');
                }
            } else if (state.activeTab === 'search') {
                const username = byId('presentation-collab-username')?.value?.trim();
                if (username) {
                    const role = byId('presentation-collab-role')?.value || 'editor';
                    await addCollaborator(username, role);
                } else {
                    toast('协作设置已保存。');
                }
            } else if (state.activeTab === 'unit') {
                if (state.selectedBatchUnits instanceof Set && state.selectedBatchUnits.size > 0) {
                    await submitBatchUnitAuthorization();
                } else {
                    toast('协作设置已保存。');
                }
            } else {
                toast('协作设置已保存。');
            }
        } catch (err) {
            toast(err?.message || '保存协作设置失败，请重试。', 'error');
        } finally {
            closeCollaboratorsModal();
        }
    }

    function switchCollabTab(tab) {
        state.activeTab = tab;
        byId('presentation-collab-tab-unit-user')?.classList.toggle('is-active', tab === 'unit-user');
        byId('presentation-collab-tab-search-user')?.classList.toggle('is-active', tab === 'search');
        byId('presentation-collab-tab-unit')?.classList.toggle('is-active', tab === 'unit');

        byId('presentation-collab-form')?.classList.toggle('hidden', tab !== 'unit-user');
        byId('presentation-collab-search-form')?.classList.toggle('hidden', tab !== 'search');
        byId('presentation-collab-unit-panel')?.classList.toggle('hidden', tab !== 'unit');
    }

    function handleCollabChange(event) {
        if (event.target?.id === 'presentation-collab-unit-filter') {
            updateUserSelectOptions();
        }
    }

    async function loadCollaboratorCandidates() {
        if (!state.activePresentationId) return;
        try {
            const data = await requestJson(`${API}/${encodeURIComponent(state.activePresentationId)}/collaborator-candidates`);
            state.candidates = {
                units: Array.isArray(data.units) ? data.units : [],
                users: Array.isArray(data.users) ? data.users : []
            };
            renderCandidateControls();
        } catch (_) {}
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
        }
        return svg;
    }

    function createUnitBadge(unitName) {
        const badge = document.createElement('div');
        badge.className = 'presentation-collab-unit-badge';
        badge.appendChild(createSvgIcon('unit', 11));
        const text = document.createElement('span');
        text.textContent = unitName || '未分配单位';
        badge.appendChild(text);
        return badge;
    }

    function renderCandidateControls() {
        const unitFilter = byId('presentation-collab-unit-filter');
        if (unitFilter) {
            const currentVal = unitFilter.value;
            unitFilter.replaceChildren();
            const allOpt = document.createElement('option');
            allOpt.value = '';
            allOpt.textContent = `全部单位 (${state.candidates.users.length} 人)`;
            unitFilter.appendChild(allOpt);
            state.candidates.units.forEach(u => {
                const opt = document.createElement('option');
                opt.value = u.name;
                opt.textContent = `${u.name} (${u.count} 人)`;
                unitFilter.appendChild(opt);
            });
            if (currentVal && state.candidates.units.some(u => u.name === currentVal)) {
                unitFilter.value = currentVal;
            }
        }

        const datalist = byId('presentation-collab-user-datalist');
        if (datalist) {
            datalist.replaceChildren();
            state.candidates.users.forEach(u => {
                const opt = document.createElement('option');
                opt.value = u.username;
                opt.textContent = `${u.nickname || u.username}（${u.unit || '未分配单位'}）`;
                datalist.appendChild(opt);
            });
        }

        const unitsGroup = byId('presentation-collab-units-group');
        if (unitsGroup) {
            unitsGroup.replaceChildren();
            if (!state.candidates.units.length) {
                const note = document.createElement('div');
                note.className = 'presentation-empty-note';
                note.textContent = '暂无单位数据';
                unitsGroup.appendChild(note);
            } else {
                state.candidates.units.forEach(u => {
                    const card = document.createElement('div');
                    card.className = 'presentation-collab-unit-card' + (state.selectedBatchUnits.has(u.name) ? ' is-selected' : '');
                    card.dataset.collabUnit = u.name;

                    const checkIcon = document.createElement('span');
                    checkIcon.className = 'presentation-collab-check-icon';
                    checkIcon.appendChild(createSvgIcon('check', 12));

                    const icon = document.createElement('span');
                    icon.className = 'presentation-collab-unit-icon';
                    icon.appendChild(createSvgIcon('unit', 13));

                    const name = document.createElement('strong');
                    name.textContent = u.name;

                    const count = document.createElement('small');
                    count.textContent = `${u.count}人`;

                    card.append(checkIcon, icon, name, count);
                    unitsGroup.appendChild(card);
                });
            }
        }

        updateUserSelectOptions();
    }

    function updateUserSelectOptions() {
        const userSelect = byId('presentation-collab-unit-user-select') || byId('presentation-collab-user-select');
        if (!userSelect) return;
        const selectedUnit = byId('presentation-collab-unit-filter')?.value || '';
        userSelect.replaceChildren();
        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = selectedUnit ? `选择 ${selectedUnit} 成员…` : '点击选择单位成员…';
        userSelect.appendChild(placeholder);

        const filteredUsers = selectedUnit
            ? state.candidates.users.filter(u => u.unit === selectedUnit)
            : state.candidates.users;

        filteredUsers.forEach(u => {
            const opt = document.createElement('option');
            opt.value = u.username;
            opt.textContent = selectedUnit
                ? `${u.nickname || u.username}（@${u.username}）`
                : `${u.nickname || u.username} · ${u.unit || '未分配'}`;
            userSelect.appendChild(opt);
        });
    }

    async function submitBatchUnitAuthorization() {
        if (!state.activePresentationId) return;
        const units = state.selectedBatchUnits instanceof Set ? Array.from(state.selectedBatchUnits) : [];
        if (!units.length) {
            toast('请先点击勾选需要授权的单位。', 'warning');
            return;
        }
        const role = byId('presentation-collab-batch-role')?.value || 'editor';
        const roleNames = { editor: '编辑者', commenter: '评论者', viewer: '查看者' };
        try {
            const data = await requestJson(`${API}/${encodeURIComponent(state.activePresentationId)}/collaborators`, jsonOptions({
                units,
                role
            }));
            if (state.selectedBatchUnits instanceof Set) state.selectedBatchUnits.clear();
            renderCandidateControls();
            await loadCollaborators();
            toast(`已成功为单位「${units.join('、')}」的 ${data.collaborator?.count || data.count || ''} 位成员添加「${roleNames[role] || role}」权限。`);
        } catch (err) {
            toast(err?.message || '批量授权失败，请重试。', 'error');
        }
    }

    async function loadCollaborators() {
        if (!state.activePresentationId) return;
        const data = await requestJson(`${API}/${encodeURIComponent(state.activePresentationId)}/collaborators`);
        state.owner = data.owner || null;
        state.collaborators = Array.isArray(data.collaborators) ? data.collaborators : [];
        renderCollaborators();
    }

    function renderCollaborators() {
        const list = byId('presentation-collaborators-list');
        const countBadge = byId('presentation-collab-list-count');
        if (!list) return;
        list.replaceChildren();

        const totalCount = state.collaborators.length + (state.owner ? 1 : 0);
        if (countBadge) countBadge.textContent = totalCount + ' 人';

        if (!state.owner && !state.collaborators.length) {
            const empty = document.createElement('div');
            empty.className = 'presentation-empty-note';
            empty.textContent = '暂无其他协作者。可按成员搜索或按单位批量授权。';
            list.appendChild(empty);
            return;
        }

        // 1. 置顶渲染文稿所有者行
        if (state.owner) {
            const ownerRow = document.createElement('div');
            ownerRow.className = 'presentation-collab-row is-owner';

            const userWrap = document.createElement('div');
            userWrap.className = 'presentation-collab-user';

            const avatar = document.createElement('div');
            avatar.className = 'presentation-collab-avatar is-owner';
            avatar.textContent = (state.owner.userName || state.owner.username || '主').slice(0, 1).toUpperCase();

            const info = document.createElement('div');
            info.className = 'presentation-collab-info';

            const nameLine = document.createElement('div');
            nameLine.className = 'presentation-collab-name-line';
            const name = document.createElement('strong');
            name.textContent = state.owner.userName || state.owner.username;
            const handle = document.createElement('span');
            handle.className = 'presentation-collab-username';
            handle.textContent = state.owner.username ? `@${state.owner.username}` : '';
            nameLine.append(name, handle);

            const unitTag = createUnitBadge(state.owner.unit);

            info.append(nameLine, unitTag);
            userWrap.append(avatar, info);

            const ownerBadge = document.createElement('span');
            ownerBadge.className = 'presentation-collab-role-tag is-owner';
            ownerBadge.textContent = '所有者';

            ownerRow.append(userWrap, ownerBadge);
            list.appendChild(ownerRow);
        }

        // 2. 协作者列表
        const roleNames = { editor: '编辑者', commenter: '评论者', viewer: '查看者' };
        state.collaborators.forEach(c => {
            const row = document.createElement('div');
            row.className = 'presentation-collab-row';

            const userWrap = document.createElement('div');
            userWrap.className = 'presentation-collab-user';

            const avatar = document.createElement('div');
            avatar.className = 'presentation-collab-avatar';
            avatar.textContent = (c.userName || c.username || '协').slice(0, 1).toUpperCase();

            const info = document.createElement('div');
            info.className = 'presentation-collab-info';

            const nameLine = document.createElement('div');
            nameLine.className = 'presentation-collab-name-line';
            const name = document.createElement('strong');
            name.textContent = c.userName || c.username || `用户 #${c.userId}`;
            const handle = document.createElement('span');
            handle.className = 'presentation-collab-username';
            handle.textContent = c.username ? `@${c.username}` : '';
            nameLine.append(name, handle);

            const unitTag = createUnitBadge(c.unit);

            info.append(nameLine, unitTag);
            userWrap.append(avatar, info);

            const actionsWrap = document.createElement('div');
            actionsWrap.className = 'presentation-collab-row-actions';

            const tag = document.createElement('span');
            tag.className = 'presentation-collab-role-tag is-' + c.role;
            tag.textContent = roleNames[c.role] || c.role;

            const removeBtn = document.createElement('button');
            removeBtn.type = 'button';
            removeBtn.className = 'btn-danger presentation-collab-remove-btn';
            removeBtn.textContent = '移除';
            removeBtn.dataset.collabRemoveUser = String(c.userId);

            actionsWrap.append(tag, removeBtn);
            row.append(userWrap, actionsWrap);
            list.appendChild(row);
        });
    }

    async function addCollaborator(username, role) {
        if (!state.activePresentationId || !username || !username.trim()) return;
        await requestJson(`${API}/${encodeURIComponent(state.activePresentationId)}/collaborators`, jsonOptions({
            username: username.trim(),
            role: role || 'editor'
        }));
        const input = byId('presentation-collab-username');
        if (input) input.value = '';
        await loadCollaborators();
        toast('已成功添加协作者。');
    }

    async function removeCollaborator(userId) {
        if (!state.activePresentationId || !userId) return;
        await requestJson(`${API}/${encodeURIComponent(state.activePresentationId)}/collaborators/${encodeURIComponent(userId)}`, {
            method: 'DELETE'
        });
        await loadCollaborators();
        toast('已移除协作者。');
    }

    function handleCollabClick(event) {
        if (event.target.closest('#presentation-collaborators-btn')) { openCollaboratorsModal(); return true; }
        if (event.target.closest('#presentation-collaborators-close-btn')) { closeCollaboratorsModal(); return true; }
        if (event.target.closest('#presentation-collaborators-save-btn')) { saveCollaboratorsAndClose().catch(error => toast(error?.message || '保存失败，请重试。', 'error')); return true; }
        if (event.target.closest('#presentation-collab-tab-unit-user') || event.target.closest('#presentation-collab-tab-user')) { switchCollabTab('unit-user'); return true; }
        if (event.target.closest('#presentation-collab-tab-search-user')) { switchCollabTab('search'); return true; }
        if (event.target.closest('#presentation-collab-tab-unit')) { switchCollabTab('unit'); return true; }
        const unitCard = event.target.closest('.presentation-collab-unit-card');
        if (unitCard) {
            const unit = unitCard.dataset.collabUnit;
            if (!(state.selectedBatchUnits instanceof Set)) {
                state.selectedBatchUnits = new Set();
            }
            if (state.selectedBatchUnits.has(unit)) state.selectedBatchUnits.delete(unit);
            else state.selectedBatchUnits.add(unit);
            unitCard.classList.toggle('is-selected', state.selectedBatchUnits.has(unit));
            return true;
        }
        if (event.target.closest('#presentation-collab-batch-submit-btn')) {
            submitBatchUnitAuthorization();
            return true;
        }
        const removeCollab = event.target.closest('[data-collab-remove-user]');
        if (removeCollab) { removeCollaborator(removeCollab.dataset.collabRemoveUser).catch(error => toast(error.message, 'error')); return true; }
        if (event.target.closest('#presentation-comments-filter-slide')) { setCommentsFilter('slide'); return true; }
        if (event.target.closest('#presentation-comments-filter-all')) { setCommentsFilter('all'); return true; }
        const commentAction = event.target.closest('[data-comment-action]');
        if (commentAction) {
            const { commentAction: action, commentId } = commentAction.dataset;
            if (action === 'reply') { state.activeReplyId = state.activeReplyId === commentId ? null : commentId; renderComments(); }
            else if (action === 'resolve') { resolveComment(commentId).catch(error => toast(error.message, 'error')); }
            else if (action === 'delete') { deleteComment(commentId).catch(error => toast(error.message, 'error')); }
            return true;
        }
        const replyAction = event.target.closest('[data-reply-action]');
        if (replyAction) {
            const { replyAction: action, commentId } = replyAction.dataset;
            if (action === 'cancel') { state.activeReplyId = null; renderComments(); }
            else if (action === 'send') { const input = byId(`presentation-reply-input-${commentId}`); submitComment(input?.value, commentId).catch(error => toast(error.message, 'error')); }
            return true;
        }
        return false;
    }

    function handleCollabSubmit(event) {
        if (event.target?.id === 'presentation-comment-form') {
            event.preventDefault();
            submitComment(byId('presentation-comment-input')?.value).catch(error => toast(error.message, 'error'));
            return true;
        }
        if (event.target?.id === 'presentation-collab-form') {
            event.preventDefault();
            const username = byId('presentation-collab-unit-user-select')?.value;
            const role = byId('presentation-collab-unit-user-role')?.value || 'editor';
            if (!username) {
                toast('请先从成员下拉列表中选择需要添加的成员。', 'warning');
                return true;
            }
            addCollaborator(username, role).then(() => {
                const sel = byId('presentation-collab-unit-user-select');
                if (sel) sel.value = '';
            }).catch(error => toast(error.message, 'error'));
            return true;
        }
        if (event.target?.id === 'presentation-collab-search-form') {
            event.preventDefault();
            const username = byId('presentation-collab-username')?.value?.trim();
            const role = byId('presentation-collab-role')?.value || 'editor';
            if (!username) {
                toast('请输入需要添加的用户名或工号。', 'warning');
                return true;
            }
            addCollaborator(username, role).then(() => {
                const input = byId('presentation-collab-username');
                if (input) input.value = '';
            }).catch(error => toast(error.message, 'error'));
            return true;
        }
        return false;
    }

    window.addEventListener('beforeunload', () => stopPresenceHeartbeat());

    window.Pivot?.exposeModule?.('apps.presentations.collab', {
        ready: true,
        startPresenceHeartbeat,
        stopPresenceHeartbeat,
        sendPresenceHeartbeat,
        renderPresenceBar,
        loadComments,
        renderComments,
        submitComment,
        resolveComment,
        deleteComment,
        openCollaboratorsModal,
        closeCollaboratorsModal,
        saveCollaboratorsAndClose,
        loadCollaborators,
        addCollaborator,
        removeCollaborator,
        handleCollabClick,
        handleCollabSubmit
    });
})();
