(function () {
    const pivotLegacy = window.Pivot?.legacy;
    if (!pivotLegacy) return;

    function bboxToRect(bbox) {
        if (!Array.isArray(bbox) || !bbox.length) return null;
        if (Array.isArray(bbox[0])) {
            const points = bbox
                .map(point => Array.isArray(point) ? point : [])
                .filter(point => Number.isFinite(Number(point[0])) && Number.isFinite(Number(point[1])));
            if (!points.length) return null;
            const xs = points.map(point => Number(point[0]));
            const ys = points.map(point => Number(point[1]));
            return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(Math.max(...xs) - Math.min(...xs), 1), height: Math.max(Math.max(...ys) - Math.min(...ys), 1) };
        }
        if (bbox.length < 4) return null;
        const [x, y, third, fourth] = bbox.map(Number);
        if (![x, y, third, fourth].every(Number.isFinite)) return null;
        return { x, y, width: Math.max(third > x ? third - x : third, 1), height: Math.max(fourth > y ? fourth - y : fourth, 1) };
    }

    function pct(value, total) {
        return Math.min(Math.max((Number(value || 0) / Math.max(Number(total || 0), 1)) * 100, 0), 100).toFixed(4) + '%';
    }

    function create({ state, esc, activePage, blocksForPage, statusTone, api }) {
        function confidenceThreshold() {
            const value = Number(state.detail?.job?.config?.confidenceThreshold);
            return Number.isFinite(value) && value > 0 ? value : 0.75;
        }

        function coverageSummary(job) {
            const coverage = job?.result?.coverage || {};
            const source = Number(job?.sourcePageCount || coverage.sourcePageCount || 0);
            const planned = Number(job?.plannedPageCount || coverage.plannedPageCount || 0);
            const processed = Number(job?.processedPageCount || coverage.processedPageCount || 0);
            const failed = Number(job?.failedPageCount || coverage.failedPageCount || 0);
            if (!source && !planned) return '';
            const scope = planned && source && planned !== source ? `已选择 ${planned}/${source} 页` : `${source || planned} 页`;
            return `${scope} · 已完成 ${processed}/${planned || source} 页${failed ? ` · 失败 ${failed} 页` : ''}`;
        }

        function renderPageList(pages = []) {
            if (!pages.length) return '<div class="doc-tool-empty-small">暂无页面</div>';
            return pages.map(page => {
                const issueCount = Array.isArray(page.result?.issues) ? page.result.issues.length : 0;
                const confidence = page.confidence === null || page.confidence === undefined ? '未知' : Math.round(page.confidence * 100) + '%';
                return `<button class="ocr-page-pill ${String(activePage()?.id) === String(page.id) ? 'is-active' : ''} ${statusTone(page.ocrStatus)}" type="button" data-ocr-page-id="${esc(page.id)}"><span>第 ${page.pageNumber} 页</span><em>${issueCount ? `待核 ${issueCount}` : confidence}</em></button>`;
            }).join('');
        }

        function renderOverlayBlocks(page) {
            if (!page) return '';
            const width = Number(page.width || 0) || 1;
            const height = Number(page.height || 0) || 1;
            const threshold = confidenceThreshold();
            return blocksForPage(page.id).map(block => {
                const rect = bboxToRect(block.bbox || []);
                if (!rect) return '';
                const confidence = block.confidence === null || block.confidence === undefined ? null : Number(block.confidence);
                const tone = confidence === null ? ' is-unknown' : (confidence < threshold ? ' is-low' : '');
                const style = ['left:' + pct(rect.x, width), 'top:' + pct(rect.y, height), 'width:' + pct(rect.width, width), 'height:' + pct(rect.height, height)].join(';');
                const title = (confidence === null ? '置信度未知' : Math.round(confidence * 100) + '%') + ' ' + String(block.text || '').slice(0, 80);
                return '<button class="ocr-overlay-box' + tone + '" type="button" style="' + style + '" data-ocr-block-id="' + esc(block.id || '') + '" title="' + esc(title) + '"></button>';
            }).join('');
        }

        function renderPagePreview(page) {
            if (!page?.hasImage) return '<div class="doc-tool-empty-detail">暂无页面预览</div>';
            const width = Number(page.width || 0) || 1;
            const height = Number(page.height || 0) || 1;
            const selection = state.regionSelection?.pageId === String(page.id) ? state.regionSelection : null;
            const selectionHtml = selection ? '<div class="ocr-region-selection" style="left:' + pct(selection.x, 1) + ';top:' + pct(selection.y, 1) + ';width:' + pct(selection.width, 1) + ';height:' + pct(selection.height, 1) + '"></div>' : '';
            return '<div class="ocr-preview-canvas" data-ocr-preview-page="' + esc(page.id) + '" style="aspect-ratio:' + width + '/' + height + '"><img alt="页面预览" src="' + api + '/pages/' + encodeURIComponent(page.id) + '/image"><div class="ocr-overlay-layer">' + renderOverlayBlocks(page) + selectionHtml + '</div></div>';
        }

        function renderBlocks(pageId) {
            const blocks = blocksForPage(pageId);
            if (!blocks.length) return '<div class="doc-tool-empty-small">暂无文本块</div>';
            const threshold = confidenceThreshold();
            return blocks.map(block => {
                const confidence = block.confidence === null || block.confidence === undefined ? null : Number(block.confidence);
                const tone = confidence === null ? ' is-unknown' : (confidence < threshold ? ' is-low' : '');
                return '<div class="ocr-block-row' + tone + '" data-ocr-block-id="' + esc(block.id || '') + '"><span>' + (confidence === null ? '未知' : Math.round(confidence * 100) + '%') + '</span><p>' + esc(block.text || '') + '</p></div>';
            }).join('');
        }

        function renderReviewerPanel(job) {
            if (!state.isReviewerPanelOpen || !job) return '';
            const candidates = Array.isArray(state.reviewCandidates) ? state.reviewCandidates : [];
            const info = state.reviewPanelInfo || {};
            if (!candidates.length) {
                const ownerUnit = info.ownerUnit || '';
                const emptyDesc = info.reason === 'NO_OWNER_UNIT' || !ownerUnit
                    ? '当前账号尚未设置所属单位。文字识别的协同复核机制要求在同单位内流转，请先在右上角个人设置或管理后台设置组织单位。'
                    : ('当前所属单位「' + ownerUnit + '」暂无其他已激活的用户账号。分派复核需要同单位的其他同事参与，请在用户管理中创建或配置同事账号。');
                return [
                    '<section class="ocr-reviewer-panel ocr-reviewer-panel-empty">',
                    '    <div class="ocr-text-head">',
                    '        <strong>分派复核人</strong>',
                    '        <span>组织协同复核</span>',
                    '    </div>',
                    '    <div class="ocr-reviewer-empty-state">',
                    '        <div class="ocr-reviewer-empty-icon">',
                    '            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>',
                    '        </div>',
                    '        <div class="ocr-reviewer-empty-content">',
                    '            <strong>当前暂无可分派的复核同事</strong>',
                    '            <p>' + esc(emptyDesc) + '</p>',
                    '        </div>',
                    '    </div>',
                    '    <div class="ocr-review-actions">',
                    '        <button class="btn-secondary" type="button" data-ocr-close-reviewers>关闭</button>',
                    '    </div>',
                    '</section>'
                ].join('');
            }
            const candidateItems = candidates.map(candidate => {
                const checked = state.selectedReviewerIds.has(String(candidate.id)) ? 'checked' : '';
                return [
                    '<label class="ocr-reviewer-item">',
                    '    <input type="checkbox" data-ocr-reviewer-id="' + esc(candidate.id) + '" ' + checked + '>',
                    '    <span>' + esc(candidate.nickname || candidate.username) + '</span>',
                    '    <em>' + esc(candidate.unit || '') + '</em>',
                    '</label>'
                ].join('');
            }).join('');
            return [
                '<section class="ocr-reviewer-panel">',
                '    <div class="ocr-text-head">',
                '        <strong>分派复核人</strong>',
                '        <span>仅显示同单位的可用用户（共 ' + candidates.length + ' 位）</span>',
                '    </div>',
                '    <div class="ocr-reviewer-list">' + candidateItems + '</div>',
                '    <div class="ocr-review-actions">',
                '        <button class="btn-primary" type="button" data-ocr-save-reviewers="' + esc(job.id) + '">确认分派</button>',
                '        <button class="btn-secondary" type="button" data-ocr-close-reviewers>取消</button>',
                '    </div>',
                '</section>'
            ].join('');
        }

        return { coverageSummary, renderBlocks, renderPageList, renderPagePreview, renderReviewerPanel };
    }

    pivotLegacy.PivotOcrReviewViews = { create };
})();
