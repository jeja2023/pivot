(function () {
    'use strict';
    const byId = id => document.getElementById(id);
    const DEFAULT_TOKEN_BUDGET = 1000000;
    function node(tag, className = '', text = '') {
        const element = document.createElement(tag); if (className) element.className = className; if (text) element.textContent = text; return element;
    }
    function svgIcon(paths, size = 16) {
        const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        el.setAttribute('width', String(size)); el.setAttribute('height', String(size));
        el.setAttribute('viewBox', '0 0 24 24'); el.setAttribute('fill', 'none');
        el.setAttribute('stroke', 'currentColor'); el.setAttribute('stroke-width', '2');
        el.setAttribute('stroke-linecap', 'round'); el.setAttribute('stroke-linejoin', 'round');
        for (const [tag, attrs] of paths) {
            const child = document.createElementNS('http://www.w3.org/2000/svg', tag);
            for (const [k, v] of Object.entries(attrs)) child.setAttribute(k, v);
            el.appendChild(child);
        }
        return el;
    }
    function formatBytes(bytes) {
        if (!bytes || bytes <= 0) return '0 B';
        const units = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(1024));
        return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + units[i];
    }
    function field(label, key, type = 'text', options) {
        const wrapper = node('label', 'presentation-master-field modal-form-field'), input = node(options ? 'select' : type === 'textarea' ? 'textarea' : 'input', 'form-input');
        input.id = 'presentation-master-' + key;
        if (options) Object.entries(options).forEach(([value, text]) => input.appendChild(new Option(text, value)));
        else if (type === 'textarea') input.rows = 2;
        else input.type = type;
        const caption = node('span', 'modal-form-label', label);
        wrapper.append(caption, input); return wrapper;
    }
    function section(title, iconPaths, className = '') {
        const element = node('section', 'presentation-master-section ' + className);
        const header = node('div', 'presentation-master-section-head');
        if (iconPaths) header.appendChild(svgIcon(iconPaths, 16));
        header.appendChild(node('h4', '', title));
        element.appendChild(header); return element;
    }
    function fileField(label, key, accept, hint, fileTypeLabel) {
        const wrapper = node('div', 'presentation-master-field modal-form-field'), caption = node('span', 'modal-form-label', label);
        const input = node('input', 'hidden'); input.type = 'file'; input.id = 'presentation-master-' + key;
        input.accept = accept; input.multiple = true; input.setAttribute('aria-label', label);
        caption.id = input.id + '-label'; wrapper.setAttribute('role', 'group'); wrapper.setAttribute('aria-labelledby', caption.id);

        const dropzone = node('div', 'presentation-master-dropzone');
        const dropMain = node('div', 'presentation-master-dropzone-main');
        const dropIcon = svgIcon([['path', { d: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4' }], ['polyline', { points: '17 8 12 3 7 8' }], ['line', { x1: '12', y1: '3', x2: '12', y2: '15' }]], 20);
        const dropText = node('div', 'presentation-master-dropzone-content');
        const dropPrompt = node('p', 'presentation-master-dropzone-title', '拖拽文件至此或点击右侧选择');
        const dropSub = node('p', 'presentation-master-dropzone-subtitle', fileTypeLabel || '支持格式：' + accept);
        const selection = node('span', 'presentation-master-file-selection', '未选择任何文件');
        selection.id = input.id + '-selection';
        selection.setAttribute('aria-live', 'polite');
        dropText.append(dropPrompt, dropSub, selection);
        dropMain.append(dropIcon, dropText);

        const picker = node('div', 'presentation-master-dropzone-actions');
        const browse = node('button', 'btn-secondary presentation-master-browse-btn', '选择文件');
        const clear = node('button', 'btn-secondary presentation-master-clear-btn hidden', '清除');
        browse.type = clear.type = 'button';
        browse.setAttribute('aria-label', '选择' + label);
        clear.setAttribute('aria-label', '清除' + label);
        const note = node('small', 'presentation-master-hint', hint);
        note.id = input.id + '-hint';
        browse.setAttribute('aria-describedby', note.id + ' ' + selection.id);
        picker.append(browse, clear);

        dropzone.append(dropMain, picker);

        const fileList = node('div', 'presentation-master-file-list hidden');

        dropzone.addEventListener('click', event => {
            if (event.target.closest('button')) return;
            input.click();
        });
        dropzone.addEventListener('dragover', event => { event.preventDefault(); dropzone.classList.add('is-dragover'); });
        dropzone.addEventListener('dragleave', () => dropzone.classList.remove('is-dragover'));
        dropzone.addEventListener('drop', event => {
            event.preventDefault(); dropzone.classList.remove('is-dragover');
            if (event.dataTransfer?.files?.length) {
                input.files = event.dataTransfer.files;
                input.dispatchEvent(new Event('change'));
            }
        });

        browse.addEventListener('click', () => input.click());
        clear.addEventListener('click', () => { resetFiles(key); browse.focus(); });

        function renderFileList(files) {
            fileList.replaceChildren();
            if (!files.length) { fileList.classList.add('hidden'); return; }
            fileList.classList.remove('hidden');
            files.forEach((file, index) => {
                const item = node('div', 'presentation-master-file-item');
                const ext = file.name.split('.').pop()?.toUpperCase() || 'FILE';
                const extBadge = node('span', 'presentation-master-ext-badge', ext);
                const info = node('div', 'presentation-master-file-info');
                const fileName = node('span', 'presentation-master-file-name', file.name);
                fileName.title = file.name;
                const fileSize = node('span', 'presentation-master-file-size', formatBytes(file.size));
                info.append(fileName, fileSize);
                const removeBtn = node('button', 'presentation-master-file-remove', '×');
                removeBtn.type = 'button'; removeBtn.title = '移除此文件';
                removeBtn.setAttribute('aria-label', '移除文件 ' + file.name);
                removeBtn.addEventListener('click', event => {
                    event.stopPropagation();
                    if (typeof globalThis.DataTransfer === 'function') {
                        const dt = new globalThis.DataTransfer();
                        for (let i = 0; i < input.files.length; i++) {
                            if (i !== index) dt.items.add(input.files[i]);
                        }
                        input.files = dt.files;
                        input.dispatchEvent(new Event('change'));
                    }
                });
                item.append(extBadge, info, removeBtn);
                fileList.appendChild(item);
            });
        }

        input.addEventListener('change', () => {
            const files = [...input.files];
            selection.textContent = files.length ? `已选择${files.length}个文件：${files.map(file => file.name).join('、')}` : '未选择任何文件';
            selection.classList.toggle('is-selected', files.length > 0);
            dropzone.classList.toggle('has-files', files.length > 0);
            clear.classList.toggle('hidden', !files.length);
            renderFileList(files);
        });

        wrapper.append(caption, input, dropzone, fileList, note);
        return wrapper;
    }
    function resetFiles(key) {
        for (const name of key ? [key] : ['material-files', 'source']) {
            const input = byId('presentation-master-' + name);
            if (input) { input.value = ''; input.dispatchEvent(new Event('change')); }
        }
    }
    function reset() {
        for (const key of ['title', 'instruction', 'material', 'audience', 'purpose', 'duration']) byId('presentation-master-' + key).value = '';
        for (const [key, value] of Object.entries({ pages: '8', budget: String(DEFAULT_TOKEN_BUDGET), steps: '80', operation: 'generate', profile: 'default', consumption: 'presentation' })) byId('presentation-master-' + key).value = value;
        byId('presentation-master-operation').disabled = false;
        byId('presentation-master-profile').disabled = false;
        byId('presentation-master-budget').closest('details').open = false;
        resetFiles();
        updateTemplateLock(false);
    }
    function addSuggestions(input, suggestions, label) {
        const chips = node('div', 'presentation-master-chips');
        chips.setAttribute('role', 'group'); chips.setAttribute('aria-label', label);
        for (const [name, text] of suggestions) {
            const chip = node('button', 'presentation-master-chip', name);
            chip.type = 'button'; chip.title = '添加：' + text;
            chip.addEventListener('click', () => {
                const current = input.value.trim();
                if (!current.includes(text)) {
                    const next = current ? current + '\n' + text : text;
                    if (next.length > input.maxLength) { input.focus(); return; }
                    input.value = next;
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                }
                input.focus();
            });
            chips.appendChild(chip);
        }
        input.parentElement.appendChild(chips);
    }
    function updateTemplateLock(locked) {
        const lockNotice = byId('presentation-master-lock-notice');
        if (lockNotice) lockNotice.classList.toggle('hidden', !locked);
    }
    function mount() {
        const form = node('div', 'presentation-master-form');
        const columns = node('div', 'presentation-master-columns');

        const requirements = section('制作要求与目标定位', [['path', { d: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z' }], ['polyline', { points: '14 2 14 8 20 8' }], ['line', { x1: '16', y1: '13', x2: '8', y2: '13' }], ['line', { x1: '16', y1: '17', x2: '8', y2: '17' }], ['polyline', { points: '10 9 9 9 8 9' }]]);
        const settings = node('div', 'presentation-master-grid');
        settings.append(field('文稿名称', 'title'), field('制作模型', 'model', 'text', {}));
        window.Pivot.moduleApi('apps.presentations.goals').mount(settings, 'presentation-master');
        settings.querySelectorAll('.presentation-master-field').forEach(wrapper => {
            wrapper.classList.add('modal-form-field');
            const span = wrapper.querySelector('span');
            if (span) span.classList.add('modal-form-label');
        });

        const audienceWrapper = settings.querySelector('#presentation-master-audience')?.parentElement;
        if (audienceWrapper) {
            const chips = node('div', 'presentation-master-chips');
            ['决策层', '评审组', '汇报', '内训', '客户'].forEach((shortLabel, idx) => {
                const fullTags = ['决策层', '评审组', '业务汇报', '团队内训', '外部客户'];
                const tag = fullTags[idx];
                const chip = node('button', 'presentation-master-chip', shortLabel);
                chip.type = 'button';
                chip.title = '填入受众：' + tag;
                chip.addEventListener('click', () => {
                    const audienceInput = byId('presentation-master-audience');
                    if (!audienceInput) return;
                    const current = audienceInput.value.trim();
                    if (!current) audienceInput.value = tag;
                    else if (!current.includes(tag)) audienceInput.value = current + '、' + tag;
                    audienceInput.focus();
                });
                chips.appendChild(chip);
            });
            audienceWrapper.appendChild(chips);
        }

        const purpose = settings.querySelector('#presentation-master-purpose');
        const consumption = settings.querySelector('#presentation-master-consumption').parentElement, duration = settings.querySelector('#presentation-master-duration').parentElement;
        const pages = field('目标页数（1至40）', 'pages', 'number');
        const pagesTip = node('span', 'presentation-master-badge-tip', '建议8~16页');
        pages.querySelector('.modal-form-label')?.appendChild(pagesTip);

        settings.insertBefore(pages, purpose.parentElement);
        settings.append(purpose.parentElement, field('制作要求', 'instruction', 'textarea'));
        addSuggestions(purpose, [
            ['工作汇报', '让受众了解工作进展、成果和下一步计划。'],
            ['决策支持', '帮助受众了解备选方案、利弊和需要决策的事项。'],
            ['项目评审', '说明项目目标、实施进展、风险及应对措施。'],
            ['培训讲解', '帮助受众理解核心知识并掌握实际操作方法。']
        ], '整稿目的快捷输入');
        addSuggestions(settings.querySelector('#presentation-master-instruction'), [
            ['提炼重点', '围绕主题提炼重点，按逻辑组织内容，每页突出一个核心观点。'],
            ['依据材料', '以提供的材料为依据，保留关键数字和结论，不编造未提供的事实。'],
            ['图表呈现', '适合比较的数据使用清晰图表，并标注指标和单位。'],
            ['简洁风格', '采用简洁、专业的视觉风格，保持字体和版式一致。']
        ], '制作要求快捷输入');
        requirements.append(settings);

        const sources = section('参考材料与多媒体素材', [['path', { d: 'M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z' }]]);
        const materialFiles = fileField('文件材料', 'material-files', '.doc,.docx,.pdf,.txt,.md', '最多10份，单份≤10MB；读取文字内容（扫描件请先识别，图片/嵌入附件不参与解析）。', '支持 Word (.doc/.docx)、PDF、TXT、Markdown');
        sources.append(materialFiles, field('补充文字材料（可选）', 'material', 'textarea'), fileField('原稿与图片、音视频', 'source', '.pptx,.png,.jpg,.jpeg,.webp,.wav,.mp3,.ogg,.mp4', '可选，最多21个文件；演示原稿（.pptx）用于编辑，图片和音视频作为制作素材。', '支持 PPTX 原稿、图片 (PNG/JPG/WEBP)、音视频 (WAV/MP3/MP4)'));

        columns.append(requirements, sources);

        const generation = section('生成策略与高级配置', [['path', { d: 'M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16z' }], ['path', { d: 'M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4z' }], ['line', { x1: '12', y1: '2', x2: '12', y2: '4' }], ['line', { x1: '12', y1: '20', x2: '12', y2: '22' }], ['line', { x1: '20', y1: '12', x2: '22', y2: '12' }], ['line', { x1: '2', y1: '12', x2: '4', y2: '12' }]], 'presentation-master-section-wide');
        const lockNotice = node('div', 'presentation-master-lock-notice hidden');
        lockNotice.id = 'presentation-master-lock-notice';
        lockNotice.append(
            svgIcon([['rect', { x: '3', y: '11', width: '18', height: '11', rx: '2', ry: '2' }], ['path', { d: 'M7 11V7a5 5 0 0 1 10 0v4' }]], 13),
            node('span', '', '已由当前制作模板锁定最佳工作方式与生成方案')
        );
        generation.querySelector('.presentation-master-section-head').appendChild(lockNotice);

        const modes = node('div', 'presentation-master-grid-4');
        modes.append(field('工作方式', 'operation', 'text', { generate: '生成完整演示', create_template: '创建可复用模板', edit_native: '保留原稿设计并编辑' }),
            field('生成方式', 'profile', 'text', { default: '先确认方案再制作', quick: '快速制作（跳过方案确认）', beautify: '美化已有内容', image_to_pptx: '根据图片重建' }), consumption, duration);

        const advanced = node('details', 'presentation-master-advanced'), limits = node('div', 'presentation-master-grid');
        advanced.appendChild(node('summary', '', '高级设置 · 模型预算与执行轮次'));
        limits.append(field('累计模型预算（令牌）', 'budget', 'number'), field('执行轮次上限（5至160）', 'steps', 'number'));
        advanced.append(limits); generation.append(modes, advanced);

        form.append(columns, generation);

        for (const [key, value, min, max] of [['pages', 8, 1, 40], ['budget', DEFAULT_TOKEN_BUDGET, 10000], ['steps', 80, 5, 160]]) {
            const input = form.querySelector('#presentation-master-' + key); input.value = value; input.min = min; if (max !== undefined) input.max = max; input.step = 1;
        }
        for (const [key, max] of [['title', 120], ['instruction', 16000], ['material', 120000]]) form.querySelector('#presentation-master-' + key).maxLength = max;
        form.querySelector('#presentation-master-title').placeholder = '演示文稿主题（如：2026年度业务规划与关键决策）';
        form.querySelector('#presentation-master-instruction').placeholder = '说明主题、重点章节、风格要求（如沉稳严谨、现代简约）及需保留的关键数字或结论';
        form.querySelector('#presentation-master-purpose').placeholder = '希望受众看完后了解什么或采取什么行动';
        form.querySelector('#presentation-master-material').placeholder = '可直接粘贴事实论据、经营数据或核心结论，与上传的文件材料一起作为制作依据';
        return form;
    }
    function snapshot() {
        const files = [...byId('presentation-master-material-files').files];
        if (files.length > 10) throw new Error('单次最多上传10份文件材料，请减少后重试。');
        for (const file of files) {
            if (!/\.(docx?|pdf|txt|md)$/i.test(file.name)) throw new Error('文件材料格式不支持，请选择提示中列出的文档或文本文件。');
            if (file.size > 10 * 1024 * 1024) throw new Error(`材料“${file.name}”超过10兆字节，请拆分后上传。`);
        }
        return { files, text: byId('presentation-master-material').value.trim() };
    }
    async function extract(snapshot, requestJson, { signal, ensureCurrent }) {
        const materials = snapshot.text ? [{ title: '本次补充文字', text: snapshot.text }] : [];
        for (const file of snapshot.files) {
            ensureCurrent();
            const body = new FormData(); body.append('file', file);
            const { material } = await requestJson('/api/apps/presentations/materials/extract', { method: 'POST', body, signal });
            ensureCurrent();
            if (material?.truncated || material?.text?.length > 120000) throw new Error(`材料“${file.name}”超过十二万字，请拆分后上传，避免遗漏内容。`);
            if (!material?.text?.trim()) throw new Error(`材料“${file.name}”未提取到文字，请检查内容或先进行文字识别。`);
            materials.push({ ...material, id: `file_${materials.length + 1}`, title: file.name, locator: `文件 ${file.name}` });
        }
        return materials;
    }
    window.Pivot.exposeModule('apps.presentations.masterForm', { mount, snapshot, extract, reset, resetFiles, updateTemplateLock });
})();
