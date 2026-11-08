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
    window.Pivot.exposeModule('apps.presentations.templatePreview', { render: renderTemplateThumbnail });
})();
