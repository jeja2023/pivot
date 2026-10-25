(function () {
    'use strict';
    function create(context) {
        const { dialog, closeDialog, request, json, escape } = context; const $ = id => document.getElementById(id);
        let sources = []; let selected; let preview; let generation = 0;
        return {
            stop() { generation++; sources = []; selected = null; preview = null; },
            async action(name) {
                const current = ++generation; const dialogSequence = context.state.dialogSequence;
                if (name === 'dataset-mapping') {
                    sources = (await request('/data-sources')).rows; if (current !== generation || context.state.dialogSequence !== dialogSequence) return true;
                    void dialog('从数据集生成导图', `<p>可使用本人或有权限读取的共享数据。受限字段不会出现在映射选项中。</p><label>数据集<select class="form-input" id="mindmap-source-dataset">${sources.map(source => `<option value="${escape(source.id)}">${escape(source.name)}</option>`).join('')}</select></label><button class="btn-primary" type="button" data-mm-action="dataset-configure"${sources.length ? '' : ' disabled'}>配置层级</button>`); return true;
                }
                if (name === 'dataset-configure') {
                    selected = sources.find(source => source.id === $('mindmap-source-dataset').value); if (!selected) throw new Error('请选择有效数据集。');
                    const fields = selected.columns.map(field => `<option value="${escape(field.key)}">${escape(field.name)}</option>`).join('');
                    void dialog('配置数据层级', `<p>维度按从上到下的顺序生成层级。自动刷新会在当前导图打开时每分钟检查来源，并替换生成的分支，请使用副本进行独立创作。</p>${[1,2,3,4,5].map(index => `<label>第 ${index} 层维度<select class="form-input" id="mindmap-source-level-${index}"><option value="">${index === 1 ? '请选择' : '不使用'}</option>${fields}</select></label>`).join('')}<label>统计方式<select class="form-input" id="mindmap-source-aggregation"><option value="count">记录数</option><option value="sum">求和</option><option value="avg">平均</option><option value="min">最小值</option><option value="max">最大值</option></select></label><label>度量字段<select class="form-input" id="mindmap-source-metric"><option value="">记录数无需选择</option>${fields}</select></label><label>最大组数<input class="form-input" type="number" min="1" max="500" value="100" id="mindmap-source-limit"></label><label><input type="checkbox" id="mindmap-source-auto"> 打开时自动刷新数据分支</label><button class="btn-primary" type="button" data-mm-action="dataset-preview">生成预览</button>`); return true;
                }
                if (name === 'dataset-preview') {
                    const dimensions = [1,2,3,4,5].map(index => $(`mindmap-source-level-${index}`).value).filter(Boolean);
                    const input = { datasetId: selected.id, mapping: { dimensions, aggregation: $('mindmap-source-aggregation').value, metric: $('mindmap-source-metric').value, limit: Number($('mindmap-source-limit').value) }, refreshMode: $('mindmap-source-auto').checked ? 'auto' : 'manual' };
                    preview = (await request('/from-dataset', json(input))).document; if (current !== generation || context.state.dialogSequence !== dialogSequence) return true;
                    void dialog('核对数据导图', `<p>${escape(preview.source.description)}</p><pre>${escape(window.Pivot.moduleApi('mindmaps.document').markdown(preview))}</pre><button class="btn-primary" type="button" data-mm-action="dataset-save">保存为个人导图</button>`); return true;
                }
                if (name === 'dataset-save') { if (!preview) throw new Error('请先生成预览。'); await context.create(preview); preview = null; closeDialog(); return true; }
                return false;
            }
        };
    }
    window.Pivot.exposeModule('mindmaps.dataSource', { create });
})();
