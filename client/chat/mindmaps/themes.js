(function () {
    'use strict';
    function create(context) {
        const { state, dialog, closeDialog, request, json, escape } = context;
        const schema = window.Pivot.moduleApi('mindmaps.document');
        const $ = id => document.getElementById(id);
        let themes = [];

        function apply(pack) {
            const next = schema.normalize(state.document);
            next.presentation.themeId = 'custom';
            next.presentation.customTheme = schema.themePack(pack);
            state.editor.update(next);
            context.changed(next);
            closeDialog();
        }

        const current = () => {
            const palette = schema.palette(state.document);
            return schema.themePack({
                version: 1,
                label: palette.label,
                root: palette.root,
                line: palette.line,
                background: palette.background,
                ...(palette.styles ? { styles: palette.styles } : {})
            });
        };

        return {
            async action(name, button) {
                if (name === 'theme-library') {
                    const sequence = state.dialogSequence;
                    themes = (await request('/themes')).rows;
                    if (sequence !== state.dialogSequence) return true;
                    const curr = current();
                    const rows = themes.length ? themes.map(theme => {
                        let c = theme.content;
                        if (typeof c === 'string') {
                            try { c = JSON.parse(c); } catch (_) { c = {}; }
                        }
                        const root = c?.root || '#4338ca';
                        const line = c?.line || '#6366f1';
                        const bg = c?.background || '#ffffff';
                        return `<tr>
                            <td class="mm-col-theme-name">
                                <div class="mm-theme-name-cell">
                                    <span class="mm-theme-avatar" aria-hidden="true">
                                        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                                            <circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/>
                                            <circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/>
                                            <circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/>
                                            <circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/>
                                            <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.563-2.512 5.563-5.563C22 6.5 17.5 2 12 2z"/>
                                        </svg>
                                    </span>
                                    <strong class="mm-theme-item-name" title="${escape(theme.name)}">${escape(theme.name)}</strong>
                                </div>
                            </td>
                            <td class="mm-col-theme-palette">
                                <div class="mm-theme-color-chips">
                                    <span class="mm-color-dot" data-color="${root}" title="中心节点: ${root}"></span>
                                    <span class="mm-color-dot" data-color="${line}" title="分支线条: ${line}"></span>
                                    <span class="mm-color-dot mm-dot-bordered" data-color="${bg}" title="画布背景: ${bg}"></span>
                                </div>
                            </td>
                            <td class="mm-col-theme-actions text-center">
                                <div class="mm-theme-btns-cell">
                                    <button class="btn-secondary mm-btn-apply" type="button" data-mm-action="theme-use" data-mm-theme="${theme.id}">应用</button>
                                    <button class="btn-danger mm-btn-del" type="button" data-mm-action="theme-delete" data-mm-theme="${theme.id}" title="删除此主题">删除</button>
                                </div>
                            </td>
                        </tr>`;
                    }).join('') : `<tr><td colspan="3"><div class="mm-empty-box"><span class="mm-empty-icon"><svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 10 10 0 0 0 9.5-13.5"/></svg></span><span class="mm-empty-text">暂无已保存的个人主题</span><span class="mm-empty-hint">点击上方【保存当前主题】即可将当前导图配色方案收藏至此</span></div></td></tr>`;

                    const modalHtml = `
<div class="mm-modal-form mm-theme-library-modal">
    <div class="mm-modal-subtitle">主题按当前账号云端保存，可跨导图复用；支持受控颜色、字体、节点形状与间距。</div>

    <div class="mm-section-card mm-theme-current-card">
        <div class="mm-theme-current-info">
            <div class="mm-theme-current-title-row">
                <span class="mm-theme-current-badge">当前配色</span>
                <strong class="mm-theme-current-label">${escape(curr.label || '当前导图主题')}</strong>
            </div>
            <div class="mm-theme-color-chips">
                <span class="mm-color-dot" data-color="${curr.root}" title="中心节点: ${curr.root}"></span>
                <span class="mm-color-dot" data-color="${curr.line}" title="分支线条: ${curr.line}"></span>
                <span class="mm-color-dot mm-dot-bordered" data-color="${curr.background || '#ffffff'}" title="画布背景: ${curr.background || '#ffffff'}"></span>
            </div>
        </div>
        <div class="mm-theme-current-btns">
            <button class="btn-primary mm-action-btn mm-btn-save-theme" type="button" data-mm-action="theme-save" title="将当前导图配色方案保存至云端个人主题库">
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
                <span>保存当前主题</span>
            </button>
            <button class="btn-secondary mm-action-btn" type="button" data-mm-action="theme-export" title="导出为 .json 主题包文件到本地">
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                <span>下载主题包</span>
            </button>
        </div>
    </div>

    <div class="mm-theme-list-section">
        <div class="mm-section-header">
            <span class="mm-section-title">已保存的主题 (${themes.length})</span>
            <span class="mm-section-hint">点击【应用】即时套用至当前思维导图</span>
        </div>
        <div class="mm-modal-table-wrap mm-theme-table-wrap">
            <table class="data-table mm-modal-table">
                <thead>
                    <tr>
                        <th class="mm-col-theme-name">主题名称</th>
                        <th class="mm-col-theme-palette">色彩样本</th>
                        <th class="mm-col-theme-actions text-center">操作</th>
                    </tr>
                </thead>
                <tbody>
                    ${rows}
                </tbody>
            </table>
        </div>
    </div>

    <div class="mm-section-card mm-theme-import-card">
        <div class="mm-section-header">
            <span class="mm-section-title">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                <span>导入主题包</span>
            </span>
            <span class="mm-section-hint">支持不超过 16KB 的 JSON 导图主题包</span>
        </div>
        <div class="mm-theme-import-row">
            <div class="mm-file-input-wrapper">
                <input type="file" class="form-input mm-file-native" id="mindmap-theme-file" accept=".json">
            </div>
            <button class="btn-secondary mm-import-submit-btn" type="button" data-mm-action="theme-import">
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
                <span>检查并应用导入文件</span>
            </button>
        </div>
    </div>
</div>`;
                    void dialog('个人主题库', modalHtml);
                    setTimeout(() => {
                        const body = $('mindmap-dialog-body');
                        if (body) {
                            body.querySelectorAll('.mm-color-dot[data-color]').forEach(dot => {
                                dot.style.backgroundColor = dot.getAttribute('data-color');
                            });
                        }
                    }, 0);
                    return true;
                }
                if (name === 'theme-save') { await request('/themes', json({ theme: current() })); closeDialog(); return true; }
                if (name === 'theme-use') { const theme = themes.find(t => t.id === button.dataset.mmTheme); if (!theme) throw new Error('主题不存在。'); apply(theme.content); return true; }
                if (name === 'theme-delete') { await request(`/themes/${button.dataset.mmTheme}`, { method: 'DELETE' }); closeDialog(); return true; }
                if (name === 'theme-export') { const url = URL.createObjectURL(new Blob([JSON.stringify(current(), null, 2)], { type: 'application/json' })); const link = document.createElement('a'); link.href = url; link.download = '思维导图主题.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); return true; }
                if (name === 'theme-import') { const file = $('mindmap-theme-file').files[0]; if (!file || file.size > 16384) throw new Error('请选择不超过 16KiB 的主题 JSON 文件。'); const sequence = state.dialogSequence; let theme; try { theme = schema.themePack(JSON.parse(await file.text())); } catch (error) { throw new Error(`主题检查失败：${error.message}`); } if (sequence !== state.dialogSequence) return true; apply(theme); return true; }
                return false;
            }
        };
    }
    window.Pivot.exposeModule('mindmaps.themes', { create });
})();
