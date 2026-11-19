(function () {
    'use strict';
    function renderTemplateThumbnail(template) {
        const definition = template?.definition || {};
        const layouts = Array.isArray(definition.layouts) ? definition.layouts : [];
        const layout = layouts.find(item => item.legacyLayoutId === 'cover' || /封面|cover/i.test(item.name || '')) || layouts[0] || {};
        const masters = Array.isArray(definition.masters) ? definition.masters : [];
        const master = masters.find(item => item.id === layout.masterId) || masters[0] || {};
        const thumbnail = document.createElement('div'); thumbnail.className = 'presentation-template-thumbnail';
        thumbnail.style.aspectRatio = template.aspectRatio === '4:3' ? '4 / 3' : '16 / 9';
        thumbnail.style.background = master.background?.fill || definition.theme?.colors?.background || '';
        const addItem = (item, className) => {
            const node = document.createElement('i'); node.className = className;
            node.style.left = `${Math.max(0, Math.min(100, Number(item.x || 0) / (template.aspectRatio === '4:3' ? 9.6 : 12.8)))}%`;
            node.style.top = `${Math.max(0, Math.min(100, Number(item.y || 0) / 7.2))}%`;
            node.style.width = `${Math.max(1, Math.min(100, Number(item.width || 100) / (template.aspectRatio === '4:3' ? 9.6 : 12.8)))}%`;
            node.style.height = `${Math.max(1, Math.min(100, Number(item.height || 60) / 7.2))}%`;
            if (item.type === 'shape') node.style.background = item.style?.fill || definition.theme?.colors?.secondary || '';
            if (item.type === 'text') node.style.background = item.style?.color || definition.theme?.colors?.text || '';
            thumbnail.appendChild(node);
        };
        const decorations = [...(master.decorations || []), ...(layout.decorations || [])];
        const placeholders = layout.placeholders || [];
        if (decorations.length || placeholders.length) {
            decorations.slice(0, 12).forEach(item => addItem(item, 'presentation-template-thumbnail-decoration'));
            placeholders.slice(0, 12).forEach(item => addItem(item, 'presentation-template-thumbnail-slot'));
        } else {
            const colors = definition.theme?.colors || template.theme?.colors || {};
            if (colors.primary) {
                const accentBar = document.createElement('i');
                accentBar.className = 'presentation-template-thumbnail-accent';
                accentBar.style.left = '12%';
                accentBar.style.top = '20%';
                accentBar.style.width = '18%';
                accentBar.style.height = '4%';
                accentBar.style.borderRadius = '1px';
                accentBar.style.background = colors.accent || colors.primary;

                const titleBar = document.createElement('i');
                titleBar.className = 'presentation-template-thumbnail-title';
                titleBar.style.left = '12%';
                titleBar.style.top = '34%';
                titleBar.style.width = '56%';
                titleBar.style.height = '14%';
                titleBar.style.borderRadius = '2px';
                titleBar.style.background = colors.primary;

                const subBar = document.createElement('i');
                subBar.className = 'presentation-template-thumbnail-sub';
                subBar.style.left = '12%';
                subBar.style.top = '56%';
                subBar.style.width = '36%';
                subBar.style.height = '8%';
                subBar.style.borderRadius = '1px';
                subBar.style.background = colors.secondary || colors.text || colors.primary;
                subBar.style.opacity = '0.75';

                thumbnail.append(accentBar, titleBar, subBar);
            }
        }
        return thumbnail;
    }
    function openCatalogPreview({ template, request, node, actions, back }) {
        const section = node('section', 'presentation-catalog-preview workspace-modal-body');
        const controls = node('div', 'presentation-catalog-preview-toolbar');
        const title = node('h4', '', template.name);
        title.tabIndex = -1;
        const backButton = node('button', 'btn-secondary', '返回列表');
        backButton.type = 'button';
        backButton.addEventListener('click', back);
        controls.append(backButton, title);

        const isStyle = template.ownerType === 'engine';
        const description = node('p', '', isStyle
            ? '风格示例 · 实际配色与排版由制作内容决定。'
            : '版式预览 · 依据此版本的母版和可用素材渲染，文字为示例。');
        const stage = node('div', 'presentation-catalog-preview-stage');
        const status = node('p', 'presentation-catalog-preview-status');
        status.setAttribute('role', 'status');
        const retry = node('button', 'btn-secondary hidden', '重试预览');
        retry.type = 'button';
        const image = node('img', 'hidden');
        const layouts = template.definition?.layouts || [];
        let select;
        if (!isStyle && layouts.length) {
            select = node('select', 'form-input presentation-catalog-preview-layout');
            select.setAttribute('aria-label', '预览版式');
            for (const layout of layouts) select.appendChild(new Option(layout.name || layout.id, layout.id));
            select.value = (layouts.find(item => item.legacyLayoutId === 'cover' || /封面|cover/i.test(item.name)) || layouts[0]).id;
            select.addEventListener('change', load);
            controls.appendChild(select);
        }

        let pending, src;
        function releaseImage() {
            image.removeAttribute('src');
            image.classList.add('hidden');
            if (src) URL.revokeObjectURL(src);
            src = '';
        }
        async function load() {
            pending?.abort();
            const current = pending = new AbortController();
            releaseImage();
            if (document.activeElement === retry) title.focus();
            retry.classList.add('hidden');
            status.textContent = '正在加载模板预览…';
            status.classList.remove('hidden');
            const params = new URLSearchParams({ version: String(template.version) });
            if (select?.value) params.set('layout', select.value);
            try {
                const result = await request('/api/apps/presentations/template-catalog/' + encodeURIComponent(template.id) + '/preview?' + params, { signal: current.signal });
                if (current.signal.aborted) return;
                if (result.status === 404) {
                    const response = await result.json().catch(() => ({}));
                    if (current.signal.aborted) return;
                    const code = response.code || response.error?.code;
                    if (code === 'PRESENTATION_TEMPLATE_NOT_FOUND' || code === 'PRESENTATION_LAYOUT_NOT_FOUND') {
                        status.textContent = '此版式或模板版本已不可用。请选择其他版式，或重新打开模板库。';
                    } else {
                        status.textContent = '当前服务未提供模板预览接口，请更新或重启服务后重试。';
                        retry.classList.remove('hidden');
                    }
                    return;
                }
                if (!result.ok) throw new Error('模板预览请求失败');
                const blob = await result.blob();
                if (current.signal.aborted) return;
                if (blob.type !== 'image/png') throw new Error('预览图片格式无效');
                image.alt = template.name + ' · ' + (select?.selectedOptions[0]?.textContent || (isStyle ? '风格示例' : '版式'));
                image.src = src = URL.createObjectURL(blob);
                await image.decode();
                if (current.signal.aborted) return;
                image.classList.remove('hidden');
                status.classList.add('hidden');
            } catch (_) {
                if (current.signal.aborted) return;
                releaseImage();
                status.textContent = '模板预览加载失败，可重试或返回列表。';
                retry.classList.remove('hidden');
            }
        }
        retry.addEventListener('click', load);
        stage.append(image, status, retry);
        section.append(controls, description, stage, actions);
        return { section, start() { title.focus(); void load(); }, close() { pending?.abort(); releaseImage(); section.remove(); } };
    }

    window.Pivot.exposeModule('apps.presentations.templatePreview', { render: renderTemplateThumbnail, openCatalogPreview });
})();
