(function () {
    'use strict';
    const byId = id => document.getElementById(id);
    function node(tag, className = '', text = '') {
        const element = document.createElement(tag); element.className = className; element.textContent = text; return element;
    }
    function field(label, key, type = 'text', options) {
        const wrapper = node('label', 'presentation-master-field modal-form-field'), input = node(options ? 'select' : type === 'textarea' ? 'textarea' : 'input', 'form-input');
        input.id = 'presentation-master-' + key;
        if (options) Object.entries(options).forEach(([value, text]) => input.appendChild(new Option(text, value)));
        else if (type === 'textarea') input.rows = 3;
        else input.type = type;
        wrapper.append(node('span', 'modal-form-label', label), input); return wrapper;
    }
    function section(title, className = '') {
        const element = node('section', 'presentation-master-section ' + className);
        element.appendChild(node('h4', '', title)); return element;
    }
    function fileField(label, key, accept, hint) {
        const wrapper = node('div', 'presentation-master-field modal-form-field'), caption = node('span', 'modal-form-label', label);
        const input = node('input', 'hidden'); input.type = 'file'; input.id = 'presentation-master-' + key;
        input.accept = accept; input.multiple = true; input.setAttribute('aria-label', label);
        caption.id = input.id + '-label'; wrapper.setAttribute('role', 'group'); wrapper.setAttribute('aria-labelledby', caption.id);
        const picker = node('div', 'presentation-master-file-picker'), browse = node('button', 'btn-secondary', '选择文件'), clear = node('button', 'btn-secondary hidden', '清除选择');
        browse.type = clear.type = 'button'; browse.setAttribute('aria-label', '选择' + label); clear.setAttribute('aria-label', '清除' + label);
        const note = node('small', 'presentation-master-hint', hint), selection = node('span', 'presentation-master-file-selection', '未选择任何文件');
        note.id = input.id + '-hint'; selection.id = input.id + '-selection'; browse.setAttribute('aria-describedby', note.id + ' ' + selection.id);
        selection.setAttribute('aria-live', 'polite');
        browse.addEventListener('click', () => input.click());
        clear.addEventListener('click', () => { resetFiles(key); browse.focus(); });
        input.addEventListener('change', () => {
            const files = [...input.files]; selection.textContent = files.length ? `已选择${files.length}个文件：${files.map(file => file.name).join('、')}` : '未选择任何文件';
            clear.classList.toggle('hidden', !files.length);
        });
        picker.append(browse, selection, clear); wrapper.append(caption, input, picker, note); return wrapper;
    }
    function resetFiles(key) {
        for (const name of key ? [key] : ['material-files', 'source']) {
            const input = byId('presentation-master-' + name); input.value = ''; input.dispatchEvent(new Event('change'));
        }
    }
    function mount() {
        const form = node('div', 'presentation-master-form'), requirements = section('制作要求'), settings = node('div', 'presentation-master-grid');
        settings.append(field('文稿名称', 'title'), field('制作模型', 'model', 'text', {}));
        window.Pivot.moduleApi('apps.presentations.goals').mount(settings, 'presentation-master');
        settings.querySelectorAll('.presentation-master-field').forEach(wrapper => {
            wrapper.classList.add('modal-form-field'); wrapper.querySelector('span').classList.add('modal-form-label');
        });
        const purpose = settings.querySelector('#presentation-master-purpose');
        const consumption = settings.querySelector('#presentation-master-consumption').parentElement, duration = settings.querySelector('#presentation-master-duration').parentElement;
        const pages = field('目标页数（1至40）', 'pages', 'number');
        settings.insertBefore(pages, purpose.parentElement);
        settings.append(purpose.parentElement, field('制作要求', 'instruction', 'textarea'));
        requirements.append(settings);
        const sources = section('参考材料'), materialFiles = fileField('文件材料', 'material-files', '.doc,.docx,.pdf,.txt,.md', '支持文字文档（.doc、.docx）、文本型文档（.pdf）、纯文本（.txt）和标记文本（.md）。最多10份，单份不超过10兆字节。读取文字内容；扫描件请先识别，文档中的图片和嵌入附件不参与解析。');
        sources.append(materialFiles, field('补充文字材料（可选）', 'material', 'textarea'), fileField('原稿与图片、音视频', 'source', '.pptx,.png,.jpg,.jpeg,.webp,.wav,.mp3,.ogg,.mp4', '可选，最多21个文件；演示原稿（.pptx）用于编辑，图片和音视频作为制作素材。'));
        const generation = section('生成设置'), modes = node('div', 'presentation-master-grid');
        modes.append(field('工作方式', 'operation', 'text', { generate: '生成完整演示', create_template: '创建可复用模板', edit_native: '保留原稿设计并编辑' }),
            field('生成方式', 'profile', 'text', { default: '先确认方案再制作', quick: '快速制作（跳过方案确认）', beautify: '美化已有内容', image_to_pptx: '根据图片重建' }), consumption, duration);
        const advanced = node('details', 'presentation-master-advanced'), limits = node('div', 'presentation-master-grid');
        advanced.appendChild(node('summary', '', '高级设置 · 模型预算与执行轮次'));
        limits.append(field('累计模型预算（令牌）', 'budget', 'number'), field('执行轮次上限（5至160）', 'steps', 'number'));
        advanced.append(limits); generation.append(modes, advanced);
        const sidebar = node('div', 'presentation-master-sidebar'); sidebar.append(sources, generation);
        form.append(requirements, sidebar);
        for (const [key, value, min, max] of [['pages', 8, 1, 40], ['budget', 400000, 10000, 500000], ['steps', 80, 5, 160]]) {
            const input = form.querySelector('#presentation-master-' + key); input.value = value; input.min = min; input.max = max; input.step = 1;
        }
        for (const [key, max] of [['title', 120], ['instruction', 16000], ['material', 120000]]) form.querySelector('#presentation-master-' + key).maxLength = max;
        form.querySelector('#presentation-master-instruction').placeholder = '说明主题、重点内容、风格及希望保留的数字或结论';
        form.querySelector('#presentation-master-purpose').placeholder = '希望受众看完后了解什么或采取什么行动';
        form.querySelector('#presentation-master-material').placeholder = '可粘贴事实、数据或说明，与上传的文件材料一起作为制作依据';
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
    window.Pivot.exposeModule('apps.presentations.masterForm', { mount, snapshot, extract, resetFiles });
})();
