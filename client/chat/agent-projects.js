/* 项目空间复用工作台、任务创建和产物预览；异步结果绑定当前账号与打开序列。 */
/* global apiFetch, API_BASE */
(() => {
    let modal, body, message, heading, sequence = 0, busy = false, returnFocus = null, current = null, offset = 0, filter = '', query = '', selectionSequence = 0;
    const node = (tag, className = '', text = '') => {
        const el = document.createElement(tag);
        el.className = className;
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
    const json = body => ({ method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
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
        body.replaceChildren(...children);
        message.textContent = '';
        body.scrollTop = 0;
    }
    function close() {
        if (busy)
            return;
        sequence++;
        modal?.classList.add('hidden');
        returnFocus?.focus();
    }
    function ensure() {
        if (modal)
            return;
        modal = node('div', 'modal-overlay hidden');
        modal.id = 'agent-projects-modal';
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
        modal.setAttribute('aria-labelledby', 'agent-projects-title');
        const panel = node('section', 'workspace-modal agent-projects-dialog'), header = node('header', 'workspace-modal-header');
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
                close();
            }
            if (event.key === 'Tab') {
                const elements = [...modal.querySelectorAll('button,input,select,textarea,a[href]')].filter(el => !el.disabled && el.offsetParent !== null);
                const first = elements[0], last = elements.at(-1);
                if (event.shiftKey && document.activeElement === first) {
                    event.preventDefault();
                    last?.focus();
                }
                else if (!event.shiftKey && document.activeElement === last) {
                    event.preventDefault();
                    first?.focus();
                }
            }
        });
    }
    async function load(operation, render) {
        const token = ++sequence, userId = actor();
        message.textContent = '正在加载…';
        try {
            const data = await operation();
            if (token !== sequence || userId !== actor() || modal.classList.contains('hidden'))
                return;
            render(data);
            message.textContent = '';
        }
        catch (error) {
            if (token === sequence && userId === actor())
                showError(error);
        }
    }
    function table(headers, rows) {
        const wrapper = node('div', 'table-container'), table = node('table', 'data-table compact-table'), head = node('thead'), tr = node('tr');
        headers.forEach(text => tr.append(node('th', '', text)));
        head.append(tr);
        table.append(head);
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
        table.append(tbody);
        wrapper.append(table);
        return wrapper;
    }
    async function list() {
        current = null;
        heading.textContent = '项目空间';
        await load(() => request(`?limit=20&offset=${offset}&status=${filter}&query=${encodeURIComponent(query)}`), data => {
            const toolbar = node('div', 'agent-projects-toolbar'), search = node('input', 'form-input');
            search.placeholder = '搜索项目名称';
            search.value = query;
            search.setAttribute('aria-label', '搜索项目名称');
            const status = node('select', 'form-input');
            [['', '全部项目'], ['active', '进行中'], ['archived', '已归档']].forEach(([value, label]) => {
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
            paging.append(node('span', '', `共 ${data.total} 个项目`), action('上一页', () => {
                offset = Math.max(0, offset - 20);
                return list();
            }), action('下一页', () => {
                if (offset + 20 < data.total) {
                    offset += 20;
                    return list();
                }
            }));
            setBody(toolbar, data.data.length ? table(['项目', '状态', '操作'], data.data.map(item => [item.title, item.status === 'archived' ? '已归档' : '进行中', action('查看', () => detail(item.id))])) : node('p', '', '暂无项目。创建项目后可统一维护资料、工作规则和里程碑。'), paging);
        });
    }
    const statusLabel = value => ({ pending: '未开始', active: '进行中', blocked: '受阻', completed: '已完成', archived: '已归档', verified: '已核验', unavailable: '来源不可用' }[value] || window.Pivot.legacy.agentStatusLabel?.(value) || value);
    async function detail(id, page = 0) {
        await load(() => request(`/${encodeURIComponent(id)}?limit=20&offset=${page}`), data => {
            current = data.project;
            heading.textContent = current.title;
            const toolbar = node('div', 'agent-projects-toolbar');
            toolbar.append(action('返回项目列表', list), action('编辑项目', () => edit(current)), action(current.status === 'archived' ? '恢复项目' : '归档项目', () => save(current, { status: current.status === 'archived' ? 'active' : 'archived' })));
            if (current.status === 'active')
                toolbar.append(action('创建项目任务', () => start(current), true));
            const rules = node('p', 'agent-projects-text', current.instructions || '尚未设置项目规则。'), files = table(['文件', '版本', '操作'], data.artifacts.map(item => [item.title, item.version || '—', item.available ? action('查看', () => window.Pivot.openArtifact?.(item.id)) : '不可访问']));
            const milestones = table(['里程碑', '状态', '到期日期', '确认依据'], current.milestones.map(item => [item.title, item.verificationStatus === 'unavailable' ? '完成依据已失效' : statusLabel(item.status), item.dueDate || '—', item.runId ? `关联任务：${item.runId}` : item.note || '—']));
            const tasks = table(['任务', '状态', '验收', '操作'], data.tasks.map(item => [item.title, statusLabel(item.status), statusLabel(item.outcome_status || '待核验'), action('查看', async () => {
                    await window.Pivot.moduleApi('workspaces.navigation').openAgentWorkbench?.({ tab: 'tasks' });
                    await window.Pivot.legacy.openAgentRun?.(item.id);
                })]));
            const paging = node('div', 'agent-projects-toolbar');
            paging.append(node('span', '', `任务 ${data.taskTotal} 项；项目产物 ${data.artifactTotal} 项`), action('上一页', () => detail(id, Math.max(0, page - 20))), action('下一页', () => detail(id, page + 20 < Math.max(data.taskTotal, data.artifactTotal) ? page + 20 : page)));
            setBody(toolbar, node('p', 'agent-projects-text', current.description), node('h4', '', '工作规则'), rules, node('h4', '', '资料范围'), node('p', '', data.collections.map(item => item.name).join('、') || '未绑定知识库集合'), node('h4', '', '里程碑'), milestones, node('h4', '', '任务'), tasks, node('h4', '', '关联文件与交付物'), files, paging);
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
            const form = node('form', 'agent-projects-form'), title = field('项目名称', 'text', project?.title, 160), description = field('项目说明', 'textarea', project?.description, 2000), instructions = field('工作规则', 'textarea', project?.instructions, 8000);
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
            const milestones = node('div', 'agent-projects-milestones'), rows = [];
            function addMilestone(item = {}) {
                const row = node('fieldset', 'agent-projects-milestone'), legend = node('legend', '', '里程碑'), name = field('名称', 'text', item.title, 200), due = field('到期日期', 'date', item.dueDate), note = field('人工确认或阻塞说明', 'textarea', item.note, 1000), run = node('select', 'form-input'), state = node('select', 'form-input');
                run.setAttribute('aria-label', '关联已核验任务');
                run.append(new Option('人工确认（不关联任务）', ''));
                tasks.filter(task => task.outcome_status === 'verified' && task.status === 'completed').forEach(task => run.append(new Option(task.title, task.id)));
                if (item.runId && !Array.from(run.options).some(option => option.value === item.runId))
                    run.append(new Option('原关联任务（保存时重新检查）', item.runId));
                run.value = item.runId || '';
                state.setAttribute('aria-label', '里程碑状态');
                ['pending', 'active', 'blocked', 'completed'].forEach(value => {
                    const option = node('option', '', statusLabel(value));
                    option.value = value;
                    state.append(option);
                });
                state.value = item.status || 'pending';
                const entry = { id: item.id, title: name.input, dueDate: due.input, note: note.input, runId: run, status: state, row };
                rows.push(entry);
                row.append(legend, name.wrapper, state, due.wrapper, note.wrapper, run, action('移除里程碑', () => {
                    rows.splice(rows.indexOf(entry), 1);
                    row.remove();
                }));
                milestones.append(row);
            }
            (project?.milestones || []).forEach(addMilestone);
            const buttons = node('div', 'agent-projects-toolbar'), submit = node('button', 'btn-primary', '保存项目');
            submit.type = 'submit';
            buttons.append(action('取消', () => project ? detail(project.id) : list()), submit);
            form.append(title.wrapper, description.wrapper, instructions.wrapper, node('label', '', '资料范围（最多12个集合）'), sources, node('label', '', '关联已有文件（最近100个，可选）'), artifactIds, node('h4', '', '里程碑'), milestones, action('添加里程碑', () => {
                if (rows.length >= 32)
                    throw new Error('里程碑最多32项。');
                addMilestone();
            }), buttons);
            form.addEventListener('submit', async (event) => {
                event.preventDefault();
                if (busy)
                    return;
                const data = { title: title.input.value, description: description.input.value, instructions: instructions.input.value, collectionIds: [...sources.selectedOptions].map(option => Number(option.value)), artifactIds: [...artifactIds.selectedOptions].map(option => Number(option.value)), milestones: rows.map(item => ({ id: item.id, title: item.title.value, dueDate: item.dueDate.value, note: item.note.value, runId: item.runId.value, status: item.status.value })) };
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
        }
        finally {
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
        }
        catch (error) {
            if (actor() !== userId || selection !== selectionSequence)
                return;
            select.replaceChildren(new Option('项目加载失败，请打开项目空间重试', ''));
            throw error;
        }
        finally {
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
        sequence++;
        selectionSequence++;
        busy = false;
        current = null;
        modal?.classList.add('hidden');
        body?.replaceChildren();
        if (heading)
            heading.textContent = '项目空间';
        if (message)
            message.textContent = '';
        const select = document.getElementById('agent-project-select');
        select?.replaceChildren(new Option('不使用项目', ''));
    }
    window.Pivot.exposeModule('agent.projects', { open, refreshSelect, reset });
})();
