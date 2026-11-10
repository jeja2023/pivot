/* 项目空间复用工作台、任务创建和产物预览；异步结果绑定当前账号与打开序列。 */
/* global apiFetch, API_BASE */
(() => {
    let modal, body, message, heading, sequence = 0, busy = false, returnFocus = null, current = null, offset = 0, filter = '', query = '', selectionSequence = 0;
    let activeMilestoneModal = null;

    const node = (tag, className = '', text = '') => {
        const el = document.createElement(tag);
        if (className)
            el.className = className;
        if (text)
            el.textContent = text;
        return el;
    };

    const actor = () => window.Pivot.legacy.currentUser?.id;

    async function request(url, options) {
        const response = await apiFetch(`${API_BASE}/agents/projects${url}`, options);
        const data = await response.json();
        if (!response.ok)
            throw new Error(data.error || '项目操作失败，请重试。');
        return data;
    }

    const json = payload => ({ method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });

    function action(text, handler, primary = false) {
        const button = node('button', primary ? 'btn-primary' : 'btn-secondary', text);
        button.type = 'button';
        button.addEventListener('click', () => Promise.resolve().then(handler).catch(showError));
        return button;
    }

    function showError(error) {
        message.textContent = error.message || '操作失败，请重试。';
        message.setAttribute('role', 'alert');
    }

    function setBody(...children) {
        closeMilestoneModal();
        body.replaceChildren(...children);
        message.textContent = '';
        message.removeAttribute('role');
        body.scrollTop = 0;
    }

    function close() {
        if (busy)
            return;
        closeMilestoneModal();
        sequence++;
        modal?.classList.add('hidden');
        returnFocus?.focus();
    }

    function closeMilestoneModal() {
        if (activeMilestoneModal) {
            activeMilestoneModal.element?.remove();
            activeMilestoneModal = null;
        }
    }

    function ensure() {
        if (modal)
            return;
        modal = node('div', 'modal-overlay hidden');
        modal.id = 'agent-projects-modal';
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
        modal.setAttribute('aria-labelledby', 'agent-projects-title');

        const panel = node('section', 'workspace-modal agent-projects-dialog');
        const header = node('header', 'workspace-modal-header');
        heading = node('h3', '', '项目空间');
        heading.id = 'agent-projects-title';
        header.append(heading, action('关闭', close));

        message = node('p', 'agent-projects-message');
        message.setAttribute('aria-live', 'polite');
        body = node('div', 'workspace-modal-body agent-projects-body');

        panel.append(header, message, body);
        modal.append(panel);
        document.body.append(modal);

        modal.addEventListener('keydown', event => {
            if (event.key === 'Escape') {
                event.preventDefault();
                if (activeMilestoneModal) {
                    closeMilestoneModal();
                } else {
                    close();
                }
            }
            if (event.key === 'Tab') {
                const targetScope = activeMilestoneModal?.element || modal;
                const elements = [...targetScope.querySelectorAll('button,input,select,textarea,a[href]')].filter(el => !el.disabled && el.offsetParent !== null);
                if (!elements.length)
                    return;
                const first = elements[0], last = elements.at(-1);
                if (event.shiftKey && document.activeElement === first) {
                    event.preventDefault();
                    last?.focus();
                } else if (!event.shiftKey && document.activeElement === last) {
                    event.preventDefault();
                    first?.focus();
                }
            }
        });
    }

    async function load(operation, render) {
        const token = ++sequence, userId = actor();
        message.textContent = '正在加载…';
        message.removeAttribute('role');
        try {
            const data = await operation();
            if (token !== sequence || userId !== actor() || modal.classList.contains('hidden'))
                return;
            render(data);
            message.textContent = '';
        } catch (error) {
            if (token === sequence && userId === actor())
                showError(error);
        }
    }

    const statusLabel = value => ({ pending: '未开始', active: '进行中', blocked: '受阻', completed: '已完成', archived: '已归档', verified: '已核验', unavailable: '来源不可用' }[value] || window.Pivot.legacy.agentStatusLabel?.(value) || value);

    function statusBadge(status, label) {
        const badge = node('span', `agent-projects-badge agent-projects-badge--${status || 'default'}`);
        badge.textContent = label || statusLabel(status);
        return badge;
    }

    function table(headers, rows) {
        const wrapper = node('div', 'table-container'), tbl = node('table', 'data-table compact-table'), head = node('thead'), tr = node('tr');
        headers.forEach(text => tr.append(node('th', '', text)));
        head.append(tr);
        tbl.append(head);
        const tbody = node('tbody');
        rows.forEach(cells => {
            const row = node('tr');
            cells.forEach(value => {
                const cell = node('td');
                if (value instanceof Node)
                    cell.append(value);
                else
                    cell.textContent = String(value ?? '');
                row.append(cell);
            });
            tbody.append(row);
        });
        tbl.append(tbody);
        wrapper.append(tbl);
        return wrapper;
    }

    async function list() {
        current = null;
        heading.textContent = '项目空间';
        await load(() => request(`?limit=20&offset=${offset}&status=${filter}&query=${encodeURIComponent(query)}`), data => {
            const toolbar = node('div', 'agent-projects-toolbar');
            const search = node('input', 'form-input');
            search.placeholder = '搜索项目名称';
            search.value = query;
            search.setAttribute('aria-label', '搜索项目名称');

            const status = node('select', 'form-input');
            [['', '全部状态'], ['active', '进行中'], ['archived', '已归档']].forEach(([value, label]) => {
                const option = node('option', '', label);
                option.value = value;
                status.append(option);
            });
            status.value = filter;

            const searchNow = () => {
                query = search.value;
                filter = status.value;
                offset = 0;
                return list();
            };

            search.addEventListener('keydown', event => {
                if (event.key === 'Enter')
                    searchNow();
            });
            status.addEventListener('change', searchNow);

            toolbar.append(search, status, action('查询', searchNow), action('新建项目', () => edit(null), true));

            const paging = node('div', 'agent-projects-toolbar');
            paging.append(
                node('span', '', `共 ${data.total} 个项目`),
                action('上一页', () => {
                    offset = Math.max(0, offset - 20);
                    return list();
                }),
                action('下一页', () => {
                    if (offset + 20 < data.total) {
                        offset += 20;
                        return list();
                    }
                })
            );

            const content = data.data.length
                ? table(['项目', '状态', '操作'], data.data.map(item => [
                    item.title,
                    statusBadge(item.status, item.status === 'archived' ? '已归档' : '进行中'),
                    action('查看', () => detail(item.id))
                ]))
                : (() => {
                    const empty = node('div', 'agent-projects-empty-milestones');
                    empty.append(node('p', '', '暂无项目。创建项目后可统一维护资料、工作规则和里程碑。'));
                    return empty;
                })();

            setBody(toolbar, content, paging);
        });
    }

    async function detail(id, page = 0) {
        await load(() => request(`/${encodeURIComponent(id)}?limit=20&offset=${page}`), data => {
            current = data.project;
            heading.textContent = current.title;

            const toolbar = node('div', 'agent-projects-toolbar');
            toolbar.append(
                action('返回项目列表', list),
                action('编辑项目', () => edit(current)),
                action(current.status === 'archived' ? '恢复项目' : '归档项目', () => save(current, { status: current.status === 'archived' ? 'active' : 'archived' }))
            );
            if (current.status === 'active')
                toolbar.append(action('创建项目任务', () => start(current), true));

            const descBox = current.description ? node('p', 'agent-projects-text', current.description) : null;

            const rulesSection = node('div', 'agent-projects-section');
            rulesSection.append(node('h4', '', '工作规则'), node('p', 'agent-projects-text', current.instructions || '尚未设置项目规则。'));

            const collectionsSection = node('div', 'agent-projects-section');
            const collTags = node('div', 'agent-projects-tags');
            if (data.collections.length) {
                data.collections.forEach(item => collTags.append(node('span', 'agent-projects-tag', item.name)));
            } else {
                collTags.append(node('span', 'agent-projects-text', '未绑定知识库集合'));
            }
            collectionsSection.append(node('h4', '', '资料范围'), collTags);

            const milestonesTable = table(
                ['里程碑', '状态', '到期日期', '确认依据'],
                current.milestones.map(item => [
                    item.title,
                    statusBadge(item.verificationStatus === 'unavailable' ? 'unavailable' : item.status, item.verificationStatus === 'unavailable' ? '完成依据已失效' : statusLabel(item.status)),
                    item.dueDate || '—',
                    item.runId ? `关联任务：${item.runId}` : item.note || '—'
                ])
            );
            const milestonesSection = node('div', 'agent-projects-section');
            milestonesSection.append(node('h4', '', '里程碑'), milestonesTable);

            const tasksTable = table(
                ['任务', '状态', '验收', '操作'],
                data.tasks.map(item => [
                    item.title,
                    statusBadge(item.status),
                    statusBadge(item.outcome_status || 'pending', statusLabel(item.outcome_status || '待核验')),
                    action('查看', async () => {
                        await window.Pivot.moduleApi('workspaces.navigation').openAgentWorkbench?.({ tab: 'tasks' });
                        await window.Pivot.legacy.openAgentRun?.(item.id);
                    })
                ])
            );
            const tasksSection = node('div', 'agent-projects-section');
            tasksSection.append(node('h4', '', '任务'), tasksTable);

            const filesTable = table(
                ['文件', '版本', '操作'],
                data.artifacts.map(item => [
                    item.title,
                    item.version || '—',
                    item.available ? action('查看', () => window.Pivot.openArtifact?.(item.id)) : '不可访问'
                ])
            );
            const filesSection = node('div', 'agent-projects-section');
            filesSection.append(node('h4', '', '关联文件与交付物'), filesTable);

            const paging = node('div', 'agent-projects-toolbar');
            paging.append(
                node('span', '', `任务 ${data.taskTotal} 项；项目产物 ${data.artifactTotal} 项`),
                action('上一页', () => detail(id, Math.max(0, page - 20))),
                action('下一页', () => detail(id, page + 20 < Math.max(data.taskTotal, data.artifactTotal) ? page + 20 : page))
            );

            const elements = [toolbar];
            if (descBox)
                elements.push(descBox);
            elements.push(rulesSection, collectionsSection, milestonesSection, tasksSection, filesSection, paging);
            setBody(...elements);
        });
    }

    function field(label, type, value, max) {
        const wrapper = node('label', 'agent-projects-field'), input = node(type === 'textarea' ? 'textarea' : 'input', 'form-input');
        if (type !== 'textarea')
            input.type = type;
        input.value = value || '';
        if (max)
            input.maxLength = max;
        wrapper.append(node('span', '', label), input);
        return { wrapper, input };
    }

    async function edit(project) {
        await load(async () => {
            const results = await Promise.all([apiFetch(`${API_BASE}/agents/context-packs/collections`), apiFetch(`${API_BASE}/agents/artifacts?limit=100`)]);
            const data = await Promise.all(results.map(response => response.json()));
            if (results.some(response => !response.ok))
                throw new Error('项目资料或文件列表加载失败，请重试。');
            const tasks = project ? await request(`/${encodeURIComponent(project.id)}?limit=100`) : { tasks: [] };
            return { collections: data[0].data || [], artifacts: data[1].artifacts || data[1].data || [], tasks: tasks.tasks };
        }, ({ collections, artifacts, tasks }) => {
            heading.textContent = project ? '编辑项目' : '新建项目';
            const form = node('form', 'agent-projects-form');
            const title = field('项目名称', 'text', project?.title, 160);
            const description = field('项目说明', 'textarea', project?.description, 2000);
            const instructions = field('工作规则', 'textarea', project?.instructions, 8000);
            title.input.required = true;

            const sources = node('select', 'form-input');
            sources.multiple = true;
            sources.size = 5;
            sources.setAttribute('aria-label', '项目资料范围');
            const all = new Map(collections.map(item => [Number(item.id), item]));
            (project?.collectionIds || []).forEach(id => {
                if (!all.has(id))
                    all.set(id, { id, name: '资料已失效，请移除' });
            });
            for (const item of all.values()) {
                const option = node('option', '', item.name);
                option.value = item.id;
                option.selected = project?.collectionIds.includes(Number(item.id)) || false;
                sources.append(option);
            }

            const artifactIds = node('select', 'form-input');
            artifactIds.multiple = true;
            artifactIds.size = 5;
            artifactIds.setAttribute('aria-label', '关联已有文件');
            const fileOptions = new Map(artifacts.map(item => [Number(item.id), item]));
            (project?.artifactIds || []).forEach(id => {
                if (!fileOptions.has(id))
                    fileOptions.set(id, { id, title: '原关联文件不在当前列表，可保留或取消选择' });
            });
            for (const item of fileOptions.values()) {
                const option = node('option', '', item.title || item.name || '结果文件');
                option.value = item.id;
                option.selected = project?.artifactIds.includes(Number(item.id)) || false;
                artifactIds.append(option);
            }

            // 里程碑数据状态
            const milestoneData = (project?.milestones || []).map(m => ({
                id: m.id,
                title: m.title || '',
                dueDate: m.dueDate || '',
                note: m.note || '',
                runId: m.runId || '',
                status: m.status || 'pending'
            }));

            // 里程碑专区与卡片列表
            const milestonesSection = node('div', 'agent-projects-section agent-projects-milestones-section');
            const milestonesHeader = node('div', 'agent-projects-section-header');
            const milestonesTitle = node('h4', '', '项目里程碑');
            const milestonesCount = node('span', 'agent-projects-counter', `${milestoneData.length} / 32`);
            milestonesHeader.append(milestonesTitle, milestonesCount);

            const milestonesList = node('div', 'agent-projects-milestone-list');

            function renderMilestones() {
                milestonesCount.textContent = `${milestoneData.length} / 32`;
                if (!milestoneData.length) {
                    const empty = node('div', 'agent-projects-empty-milestones');
                    empty.append(node('p', '', '暂无里程碑。点击下方「添加里程碑」规划阶段目标与核验要求。'));
                    milestonesList.replaceChildren(empty);
                    return;
                }
                const cards = milestoneData.map((item, index) => {
                    const card = node('div', 'agent-projects-milestone-card');
                    const cardHeader = node('div', 'agent-projects-milestone-card-header');
                    const cardTitle = node('strong', 'agent-projects-milestone-card-title', item.title || '（未命名里程碑）');
                    cardHeader.append(cardTitle, statusBadge(item.status));

                    const meta = node('div', 'agent-projects-milestone-meta');
                    if (item.dueDate)
                        meta.append(node('span', 'agent-projects-milestone-meta-item', `到期：${item.dueDate}`));
                    if (item.runId)
                        meta.append(node('span', 'agent-projects-milestone-meta-item', `关联任务：${item.runId}`));
                    if (item.note)
                        meta.append(node('span', 'agent-projects-milestone-meta-item', `说明：${item.note}`));

                    const actions = node('div', 'agent-projects-milestone-actions');
                    actions.append(
                        action('编辑', () => openMilestoneDialog(index)),
                        action('删除', () => {
                            milestoneData.splice(index, 1);
                            renderMilestones();
                        })
                    );

                    card.append(cardHeader);
                    if (meta.children.length)
                        card.append(meta);
                    card.append(actions);
                    return card;
                });
                milestonesList.replaceChildren(...cards);
            }

            renderMilestones();
            milestonesSection.append(milestonesHeader, milestonesList);

            // 里程碑子弹窗管理
            function openMilestoneDialog(editIndex = -1) {
                if (editIndex === -1 && milestoneData.length >= 32)
                    throw new Error('里程碑最多32项。');

                closeMilestoneModal();

                const currentItem = editIndex >= 0
                    ? { ...milestoneData[editIndex] }
                    : { title: '', dueDate: '', note: '', runId: '', status: 'pending' };

                const overlay = node('div', 'agent-projects-milestone-overlay');
                overlay.setAttribute('role', 'dialog');
                overlay.setAttribute('aria-modal', 'true');
                overlay.setAttribute('aria-label', editIndex >= 0 ? '编辑里程碑' : '添加里程碑');

                const dialog = node('div', 'agent-projects-milestone-dialog');
                const dlgHeader = node('div', 'agent-projects-milestone-header');
                const dlgTitle = node('h4', '', editIndex >= 0 ? '编辑里程碑' : '添加里程碑');
                const closeBtn = node('button', 'agent-projects-close-btn', '×');
                closeBtn.type = 'button';
                closeBtn.setAttribute('aria-label', '关闭');
                closeBtn.addEventListener('click', closeMilestoneModal);
                dlgHeader.append(dlgTitle, closeBtn);

                const dlgBody = node('div', 'agent-projects-milestone-body');
                const nameField = field('名称', 'text', currentItem.title, 200);
                nameField.input.setAttribute('aria-label', '名称');
                nameField.input.placeholder = '输入里程碑名称';
                nameField.input.required = true;

                const stateSelect = node('select', 'form-input');
                stateSelect.setAttribute('aria-label', '里程碑状态');
                ['pending', 'active', 'blocked', 'completed'].forEach(value => {
                    const opt = node('option', '', statusLabel(value));
                    opt.value = value;
                    stateSelect.append(opt);
                });
                stateSelect.value = currentItem.status || 'pending';
                const stateField = node('label', 'agent-projects-field');
                stateField.append(node('span', '', '里程碑状态'), stateSelect);

                const dueField = field('到期日期', 'date', currentItem.dueDate);
                dueField.input.setAttribute('aria-label', '到期日期');

                const runSelect = node('select', 'form-input');
                runSelect.setAttribute('aria-label', '关联已核验任务');
                runSelect.append(new Option('人工确认（不关联任务）', ''));
                tasks.filter(task => task.outcome_status === 'verified' && task.status === 'completed')
                    .forEach(task => runSelect.append(new Option(task.title, task.id)));
                if (currentItem.runId && !Array.from(runSelect.options).some(o => o.value === currentItem.runId))
                    runSelect.append(new Option('原关联任务（保存时重新检查）', currentItem.runId));
                runSelect.value = currentItem.runId || '';
                const runField = node('label', 'agent-projects-field');
                runField.append(node('span', '', '关联已核验任务'), runSelect);

                const noteField = field('人工确认或阻塞说明', 'textarea', currentItem.note, 1000);
                noteField.input.setAttribute('aria-label', '人工确认或阻塞说明');

                dlgBody.append(nameField.wrapper, stateField, dueField.wrapper, runField, noteField.wrapper);

                const dlgFooter = node('div', 'agent-projects-milestone-footer');
                const cancelBtn = node('button', 'btn-secondary', '取消');
                cancelBtn.type = 'button';
                cancelBtn.addEventListener('click', closeMilestoneModal);

                const saveBtn = node('button', 'btn-primary', editIndex >= 0 ? '保存修改' : '确定');
                saveBtn.type = 'button';

                function commitMilestone() {
                    const titleText = nameField.input.value.trim();
                    if (!titleText) {
                        nameField.input.focus();
                        showError(new Error('请输入里程碑名称。'));
                        return false;
                    }
                    const updated = {
                        id: currentItem.id,
                        title: titleText,
                        dueDate: dueField.input.value,
                        note: noteField.input.value,
                        runId: runSelect.value,
                        status: stateSelect.value
                    };
                    if (editIndex >= 0) {
                        milestoneData[editIndex] = updated;
                    } else {
                        milestoneData.push(updated);
                    }
                    renderMilestones();
                    closeMilestoneModal();
                    return true;
                }

                saveBtn.addEventListener('click', commitMilestone);
                dlgFooter.append(cancelBtn, saveBtn);

                dialog.append(dlgHeader, dlgBody, dlgFooter);
                overlay.append(dialog);

                body.append(overlay);
                activeMilestoneModal = {
                    element: overlay,
                    commit: commitMilestone,
                    getName: () => nameField.input.value.trim()
                };

                nameField.input.focus();
            }

            const buttons = node('div', 'agent-projects-toolbar');
            const submit = node('button', 'btn-primary', '保存项目');
            submit.type = 'submit';
            buttons.append(action('取消', () => project ? detail(project.id) : list()), submit);

            form.append(
                title.wrapper,
                description.wrapper,
                instructions.wrapper,
                node('label', '', '资料范围（最多12个集合）'),
                sources,
                node('label', '', '关联已有文件（最近100个，可选）'),
                artifactIds,
                milestonesSection,
                action('添加里程碑', () => openMilestoneDialog(-1)),
                buttons
            );

            form.addEventListener('submit', async event => {
                event.preventDefault();
                if (busy)
                    return;

                // 兼容：若此时里程碑子弹窗仍打开且有输入名称，自动提交该项
                if (activeMilestoneModal) {
                    if (activeMilestoneModal.getName()) {
                        activeMilestoneModal.commit();
                    } else {
                        closeMilestoneModal();
                    }
                }

                const data = {
                    title: title.input.value,
                    description: description.input.value,
                    instructions: instructions.input.value,
                    collectionIds: [...sources.selectedOptions].map(option => Number(option.value)),
                    artifactIds: [...artifactIds.selectedOptions].map(option => Number(option.value)),
                    milestones: milestoneData.map(item => ({
                        id: item.id,
                        title: item.title,
                        dueDate: item.dueDate,
                        note: item.note,
                        runId: item.runId,
                        status: item.status
                    }))
                };
                await save(project, data).catch(showError);
            });

            setBody(form);
            title.input.focus();
        });
    }

    async function save(project, patch) {
        if (busy)
            return;
        busy = true;
        const userId = actor();
        const token = sequence;
        modal.querySelectorAll('button,input,select,textarea').forEach(button => button.disabled = true);
        try {
            const options = json({ ...patch, expectedVersion: project?.version });
            if (!project)
                options.method = 'POST';
            const data = await request(project ? `/${encodeURIComponent(project.id)}` : '', options);
            if (token !== sequence || actor() !== userId)
                return;
            await detail(data.project.id);
            await refreshSelect();
        } finally {
            busy = false;
            modal.querySelectorAll('button,input,select,textarea').forEach(button => button.disabled = false);
        }
    }

    async function refreshSelect() {
        const select = document.getElementById('agent-project-select');
        if (!select)
            return;
        const selection = ++selectionSequence, userId = actor(), selected = select.value;
        select.disabled = true;
        try {
            const data = await request('?status=active&limit=100');
            if (actor() !== userId || selection !== selectionSequence)
                return;
            select.replaceChildren(new Option('不使用项目', ''), ...data.data.map(item => new Option(item.title, item.id)));
            if (data.data.some(item => item.id === selected))
                select.value = selected;
        } catch (error) {
            if (actor() !== userId || selection !== selectionSequence)
                return;
            select.replaceChildren(new Option('项目加载失败，请打开项目空间重试', ''));
            throw error;
        } finally {
            if (actor() === userId && selection === selectionSequence)
                select.disabled = false;
        }
    }

    async function start(project) {
        await window.Pivot.moduleApi('workspaces.navigation').openAgentWorkbench?.({ tab: 'tasks', create: true });
        await refreshSelect();
        const select = document.getElementById('agent-project-select');
        if (!select)
            throw new Error('任务创建入口未就绪，请重试。');
        select.value = project.id;
        const sources = document.getElementById('agent-context-collections');
        if (sources)
            [...sources.options].forEach(option => option.selected = false);
        close();
        window.Pivot.legacy.setTaskComposerOpen?.(true);
        document.getElementById('agent-goal-input')?.focus();
    }

    function open(projectId) {
        if (busy)
            return;
        ensure();
        returnFocus = document.activeElement;
        busy = false;
        modal.classList.remove('hidden');
        (projectId ? detail(projectId) : list()).catch(showError);
        modal.querySelector('button')?.focus();
    }

    document.addEventListener('click', event => {
        const button = event.target.closest('[data-open-projects]');
        if (button)
            open(button.dataset.projectId || '');
    });

    function reset() {
        closeMilestoneModal();
        sequence++;
        selectionSequence++;
        busy = false;
        current = null;
        modal?.classList.add('hidden');
        body?.replaceChildren();
        if (heading)
            heading.textContent = '项目空间';
        if (message) {
            message.textContent = '';
            message.removeAttribute('role');
        }
        const select = document.getElementById('agent-project-select');
        select?.replaceChildren(new Option('不使用项目', ''));
    }

    window.Pivot.exposeModule('agent.projects', { open, refreshSelect, reset });
})();
