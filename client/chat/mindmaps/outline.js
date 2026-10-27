(function () {
    'use strict';
    const schema = window.Pivot.moduleApi('mindmaps.document');
    const $ = id => document.getElementById(id);

    function create(context) {
        const { state, fail } = context;

        function updateOutlineNodeText(nodeId, newText) {
            const trimmed = (newText || '').trim();
            if (!trimmed || !state.document?.tree) return;
            if (trimmed.length > (schema.LIMITS?.text || 120)) {
                fail(new Error(`节点文字长度不能超过 ${schema.LIMITS?.text || 120} 字符`));
                return;
            }
            const next = schema.normalize(state.document);
            let target = null;
            (function walk(n) {
                if (n.id === nodeId) { target = n; return; }
                n.children.forEach(walk);
            })(next.tree);
            if (!target || target.text === trimmed) return;
            target.text = trimmed;
            state.editor.update(next);
            if (state.editor.selection() === nodeId) {
                if ($('mindmap-selection')) $('mindmap-selection').textContent = trimmed;
                if ($('mindmap-node-text')) $('mindmap-node-text').value = trimmed;
            }
            if (nodeId === next.tree.id && $('mindmap-doc-title')) {
                $('mindmap-doc-title').textContent = trimmed;
                $('mindmap-doc-title').title = trimmed;
            }
        }

        function startOutlineInlineEdit(button, node) {
            if (!button || !button.isConnected) return;
            const parent = button.parentElement;
            if (!parent || parent.querySelector('.xmind-outline-input')) return;

            const originalText = node.text;
            const input = document.createElement('input');
            input.type = 'text';
            input.className = 'xmind-outline-input';
            input.value = originalText;
            input.maxLength = schema.LIMITS?.text || 120;
            input.setAttribute('aria-label', `编辑节点 ${originalText}`);

            let committed = false;
            const finish = (saveValue) => {
                if (committed) return;
                committed = true;
                input.remove();
                button.style.display = '';
                if (saveValue && input.value.trim() && input.value.trim() !== originalText) {
                    updateOutlineNodeText(node.id, input.value.trim());
                } else {
                    button.focus();
                }
            };

            input.addEventListener('keydown', event => {
                if (event.key === 'Enter') {
                    event.preventDefault();
                    event.stopPropagation();
                    finish(true);
                } else if (event.key === 'Escape') {
                    event.preventDefault();
                    event.stopPropagation();
                    finish(false);
                }
            });
            input.addEventListener('blur', () => finish(true));

            button.style.display = 'none';
            parent.insertBefore(input, button);
            input.focus();
            input.select();
        }

        function renderOutline() {
            const host = $('mindmap-outline');
            if (!host) return;
            host.replaceChildren();
            const selectedId = state.editor?.selection?.() || null;
            function visit(node, parent) {
                const item = document.createElement('li');
                item.setAttribute('role', 'treeitem');
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'xmind-outline-node-btn';
                button.title = `${node.text} (双击直接修改名称)`;
                button.dataset.mmNode = node.id;
                if (node.id === selectedId) button.classList.add('is-active');

                const textSpan = document.createElement('span');
                textSpan.className = 'xmind-outline-node-text';
                textSpan.textContent = node.text;
                button.appendChild(textSpan);

                const editIcon = document.createElement('span');
                editIcon.className = 'xmind-outline-edit-icon';
                editIcon.title = '编辑名称';
                editIcon.setAttribute('aria-label', '编辑名称');
                PivotSafeHtml.setHtml(editIcon, '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>', { USE_PROFILES: { html: true, svg: true } });
                editIcon.addEventListener('click', event => {
                    event.preventDefault();
                    event.stopPropagation();
                    startOutlineInlineEdit(button, node);
                });
                button.appendChild(editIcon);

                button.addEventListener('dblclick', event => {
                    event.preventDefault();
                    event.stopPropagation();
                    startOutlineInlineEdit(button, node);
                });
                button.addEventListener('keydown', event => {
                    if ((event.key === 'F2' || (event.key === 'Enter' && button.classList.contains('is-active'))) && !event.isComposing) {
                        event.preventDefault();
                        event.stopPropagation();
                        startOutlineInlineEdit(button, node);
                    }
                });

                item.appendChild(button);
                if (node.children && node.children.length) {
                    const list = document.createElement('ul');
                    list.setAttribute('role', 'group');
                    node.children.forEach(child => visit(child, list));
                    item.appendChild(list);
                }
                parent.appendChild(item);
            }
            if (state.document?.tree) {
                const list = document.createElement('ul');
                visit(state.document.tree, list);
                host.appendChild(list);
            }
        }

        return { renderOutline, startOutlineInlineEdit, updateOutlineNodeText };
    }

    window.Pivot.exposeModule('mindmaps.outline', { create });
})();
