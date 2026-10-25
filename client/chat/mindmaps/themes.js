(function () {
    'use strict';
    function create(context) {
        const { state, dialog, closeDialog, request, json, escape } = context; const schema = window.Pivot.moduleApi('mindmaps.document'); const $ = id => document.getElementById(id); let themes = [];
        function apply(pack) { const next = schema.normalize(state.document); next.presentation.themeId = 'custom'; next.presentation.customTheme = schema.themePack(pack); state.editor.update(next); context.changed(next); closeDialog(); }
        return { async action(name, button) {
            if (name === 'theme-library') {
                const sequence = state.dialogSequence; themes = (await request('/themes')).rows; if (sequence !== state.dialogSequence) return true;
                const rows = themes.map(theme => `<tr><td>${escape(theme.name)}</td><td><button class="btn-secondary" type="button" data-mm-action="theme-use" data-mm-theme="${theme.id}">应用</button><button class="btn-danger" type="button" data-mm-action="theme-delete" data-mm-theme="${theme.id}">删除</button></td></tr>`).join('');
                void dialog('个人主题库', `<p>主题按账号保存，可在多份导图之间复用。主题包仅包含受控颜色、字体、节点形状与间距。</p><button class="btn-primary" type="button" data-mm-action="theme-save">保存当前主题</button><button class="btn-secondary" type="button" data-mm-action="theme-export">下载主题包</button><label>导入主题包<input type="file" class="form-input" id="mindmap-theme-file" accept=".json"></label><button class="btn-secondary" type="button" data-mm-action="theme-import">检查并应用导入文件</button><div class="table-container"><table class="data-table"><thead><tr><th>名称</th><th>操作</th></tr></thead><tbody>${rows || '<tr><td colspan="2">暂无个人主题</td></tr>'}</tbody></table></div>`); return true;
            }
            const current = () => { const palette = schema.palette(state.document); return schema.themePack({ version: 1, label: palette.label, root: palette.root, line: palette.line, background: palette.background, ...(palette.styles ? { styles: palette.styles } : {}) }); };
            if (name === 'theme-save') { await request('/themes', json({ theme: current() })); closeDialog(); return true; }
            if (name === 'theme-use') { const theme = themes.find(theme => theme.id === button.dataset.mmTheme); if (!theme) throw new Error('主题不存在。'); apply(theme.content); return true; }
            if (name === 'theme-delete') { await request(`/themes/${button.dataset.mmTheme}`, { method: 'DELETE' }); closeDialog(); return true; }
            if (name === 'theme-export') { const url = URL.createObjectURL(new Blob([JSON.stringify(current(), null, 2)], { type: 'application/json' })); const link = document.createElement('a'); link.href = url; link.download = '思维导图主题.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); return true; }
            if (name === 'theme-import') { const file = $('mindmap-theme-file').files[0]; if (!file || file.size > 16384) throw new Error('请选择不超过 16KiB 的主题 JSON 文件。'); const sequence = state.dialogSequence; let theme; try { theme = schema.themePack(JSON.parse(await file.text())); } catch (error) { throw new Error(`主题检查失败：${error.message}`); } if (sequence !== state.dialogSequence) return true; apply(theme); return true; }
            return false;
        } };
    }
    window.Pivot.exposeModule('mindmaps.themes', { create });
})();
