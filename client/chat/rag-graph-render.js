/* 知识图谱渲染辅助函数 Knowledge graph render helpers */



(function () {
    const layout = window.Pivot?.ragGraphLayout || {};
    const GRAPH_TYPE_LABELS = {
        department: '部门',
        system: '系统',
        process: '流程',
        policy: '制度',
        project: '项目',
        role: '角色',
        concept: '概念'
    };
    const GRAPH_RELATION_LABELS = {
        related_to: '相关',
        responsible_for: '负责',
        belongs_to: '归属',
        depends_on: '依赖',
        contains: '包含',
        affects: '影响'
    };
    const GRAPH_RELATION_ORDER = ['related_to', 'responsible_for', 'belongs_to', 'depends_on', 'contains', 'affects'];

    function graphTypeLabel(type) {
        return GRAPH_TYPE_LABELS[type] || type || '概念';
    }

    function graphRelationLabel(type) {
        return GRAPH_RELATION_LABELS[type] || type || '相关';
    }

    function getGraphNodeName(node) {
        return String(node?.name || '').trim() || `实体 ${node?.id || '-'}`;
    }

    function buildGraphNodeTooltip(node, relationCount, isCenter) {
        return [
            `实体名称：${getGraphNodeName(node)}`,
            `实体类型：${graphTypeLabel(node?.type)}`,
            isCenter ? '图谱位置：中心实体' : `直接关系：${Number(relationCount || 0)} 条`,
            node?.id ? `实体 ID：${node.id}` : '',
            node?.confidence !== undefined && node?.confidence !== null ? `可信度：${Number(node.confidence || 0).toFixed(2)}` : '',
            node?.description ? `描述：${node.description}` : ''
        ].filter(Boolean).join('\n');
    }

    function buildGraphRelationTooltip(row = {}) {
        const relationText = graphRelationLabel(row.relation_type);
        return [
            `起点：${row.source_name || '-'}`,
            `关系：${relationText}${row.relation_type && row.relation_type !== relationText ? `（${row.relation_type}）` : ''}`,
            `终点：${row.target_name || '-'}`,
            `状态：${row.status || 'active'}`,
            `来源：${row.doc_name || '知识图谱'}`,
            `可信度：${Number(row.confidence || 0).toFixed(2)}`,
            row.description ? `描述：${row.description}` : '',
            row.id ? `关系 ID：${row.id}` : ''
        ].filter(Boolean).join('\n');
    }

    function buildGraphSummaryHtml(summary = {}, options = {}) {
        const escapeHtml = options.escapeHtml || (value => String(value ?? ''));
        const graphTypeLabel = options.graphTypeLabel || (value => String(value ?? ''));
        const labels = options.labels || {};
        const topTypes = Array.isArray(summary.topTypes) ? summary.topTypes : [];
        const quality = summary.quality || {};
        const qualityLevel = ['good', 'warning', 'risk'].includes(String(quality.level || '')) ? quality.level : 'good';
        return `
        <span class="rag-graph-summary-main"><b>${Number(summary.entities || 0)}</b><small>${escapeHtml(labels.entities || '')}</small></span>
        <span class="rag-graph-summary-main"><b>${Number(summary.relations || 0)}</b><small>${escapeHtml(labels.relations || '')}</small></span>
        <span class="rag-graph-summary-main rag-graph-summary-quality is-${qualityLevel}"><b>${Number(quality.qualityScore ?? 0)}</b><small>${escapeHtml(labels.quality || '')}</small></span>
        <span><small>${escapeHtml(labels.pending || '')}</small><b>${Number(summary.pendingRelations || quality.pendingRelations || 0)}</b></span>
        <span><small>${escapeHtml(labels.orphans || '')}</small><b>${Number(quality.orphanEntities || 0)}</b></span>
        <span class="rag-graph-summary-main"><b>${Number(summary.mentions || 0)}</b><small>${escapeHtml(labels.mentions || '')}</small></span>
        ${topTypes.slice(0, 5).map(item => `<span><small>${escapeHtml(graphTypeLabel(item.type))}</small><b>${Number(item.count || 0)}</b></span>`).join('')}
    `;
    }

    function buildGraphEntitiesHtml(entities = [], options = {}) {
        const escapeHtml = options.escapeHtml || (value => String(value ?? ''));
        const escapeAttr = options.escapeAttr || escapeHtml;
        const graphTypeLabel = options.graphTypeLabel || (value => String(value ?? ''));
        const selectedEntityId = Number(options.selectedEntityId || 0);
        const messages = options.messages || {};
        const emptyHtml = messages.emptyHtml || '';
        const describeEntityMeta = messages.describeEntityMeta || (() => '');
        const formatConfidence = messages.formatConfidence || (value => String(value ?? ''));
        return entities.map(entity => `
        <button class="rag-graph-entity ${Number(entity.id) === selectedEntityId ? 'active' : ''}" data-entity-id="${entity.id}">
            <span>
                <strong>${escapeHtml(entity.name)}</strong>
                <small>${describeEntityMeta(entity, graphTypeLabel, escapeHtml)}</small>
            </span>
            <em title="${escapeAttr(formatConfidence(entity))}">${escapeHtml(formatConfidence(entity))}</em>
        </button>
    `).join('') || emptyHtml;
    }

    function buildGraphCanvasMarkup(graph = {}, options = {}) {
        const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
        const relations = Array.isArray(graph.relations) ? graph.relations : [];
        if (!nodes.length) {
            return { hasNodes: false, html: options.messages?.emptyHtml || '' };
        }
        const escapeHtml = options.escapeHtml || (value => String(value ?? ''));
        const escapeAttr = options.escapeAttr || (value => String(value ?? ''));
        const graphTypeLabel = options.graphTypeLabel || (value => String(value ?? ''));
        const graphRelationLabel = options.graphRelationLabel || (value => String(value ?? ''));
        const getGraphNodeName = options.getGraphNodeName || (node => String(node?.name || ''));
        const buildGraphNodeTooltip = options.buildGraphNodeTooltip || (() => '');
        const messages = options.messages || {};
        const centerId = Number(options.centerId || graph.center?.id || 0);
        const { layoutNodes, positions } = layout.buildGraphNodeLayout(nodes, centerId);
        const degreeMap = layout.createGraphDegreeMap(relations);
        const graphEdges = layout.collectVisibleGraphEdges(relations, positions, 24);
        const edgePathsHtml = layout.buildGraphEdgePathData(graphEdges, positions)
            .map(edge => `<path class="rag-graph-link ${edge.className}" d="${edge.d}" marker-end="url(#rag-graph-arrow)"></path>`)
            .join('');
        const edgeLabelsHtml = layout.buildGraphEdgeLabelData(graphEdges, positions, 12)
            .map(edge => `<span class="rag-graph-edge-label ${edge.className}" style="left:${edge.x.toFixed(2)}%;top:${edge.y.toFixed(2)}%;">${escapeHtml(graphRelationLabel(edge.row.relation_type))}</span>`)
            .join('');
        const nodeButtonsHtml = layoutNodes.map(node => {
            const pos = positions.get(Number(node.id));
            const isCenter = Number(node.id) === centerId;
            const relationCount = degreeMap.get(Number(node.id)) || 0;
            const nodeMeta = messages.describeNodeMeta
                ? messages.describeNodeMeta({ isCenter, relationCount })
                : '';
            const nodeTooltip = buildGraphNodeTooltip(node, relationCount, isCenter);
            return `<button class="rag-graph-node rag-graph-map-node ${isCenter ? 'center' : ''}" data-entity-id="${node.id}" data-graph-node-tooltip="${escapeAttr(nodeTooltip)}" style="left:${pos.x.toFixed(2)}%;top:${pos.y.toFixed(2)}%;" title="${escapeAttr(nodeTooltip)}">
            <span>${escapeHtml(graphTypeLabel(node.type))}</span>
            <strong>${escapeHtml(getGraphNodeName(node))}</strong>
            <small>${escapeHtml(nodeMeta)}</small>
        </button>`;
        }).join('') || (messages.emptyRelationsHtml || '');
        const hiddenCount = Math.max(0, relations.length - graphEdges.length);
        const footerStatus = hiddenCount > 0
            ? (messages.describeFooterStatusCollapsed ? messages.describeFooterStatusCollapsed(hiddenCount) : '')
            : (messages.footerStatusExpanded || '');
        return {
            hasNodes: true,
            html: `
        <div class="rag-graph-map">
            <div class="rag-graph-map-stage">
                <svg class="rag-graph-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
                    <defs>
                        <marker id="rag-graph-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="4.5" markerHeight="4.5" orient="auto-start-reverse">
                            <path d="M 0 0 L 10 5 L 0 10 z"></path>
                        </marker>
                    </defs>
                    ${edgePathsHtml}
                </svg>
                ${edgeLabelsHtml}
                ${nodeButtonsHtml}
            </div>
            <div class="rag-graph-map-controls" aria-label="${escapeAttr(messages.mapAriaLabel || '')}">
                <button type="button" class="btn-secondary" data-graph-zoom-action="out" title="${escapeAttr(messages.zoomOutTitle || '')}">-</button>
                <span id="rag-graph-zoom-value">100%</span>
                <button type="button" class="btn-secondary" data-graph-zoom-action="in" title="${escapeAttr(messages.zoomInTitle || '')}">+</button>
                <button type="button" class="btn-secondary" data-graph-zoom-action="reset" title="${escapeAttr(messages.resetTitle || '')}">1:1</button>
            </div>
        </div>
        <div class="rag-graph-map-footer">
            <span>${escapeHtml(messages.describeFooterCounts ? messages.describeFooterCounts(layoutNodes.length, graphEdges.length) : '')}</span>
            <span>${escapeHtml(footerStatus)}</span>
        </div>
    `
        };
    }

    function buildGraphRelationsHtml(relations = [], options = {}) {
        const escapeHtml = options.escapeHtml || (value => String(value ?? ''));
        const escapeAttr = options.escapeAttr || (value => String(value ?? ''));
        const graphRelationLabel = options.graphRelationLabel || (value => String(value ?? ''));
        const buildGraphRelationTooltip = options.buildGraphRelationTooltip || (() => '');
        const messages = options.messages || {};
        const emptyHtml = messages.emptyHtml || '';
        const formatConfidence = messages.formatConfidence || (value => String(value ?? ''));
        const sourceFallback = messages.sourceFallback || '';
        const describeSource = messages.describeSource || (row => row.doc_name || sourceFallback);
        const editLabel = messages.editLabel || '';
        const deleteLabel = messages.deleteLabel || '';
        const confirmLabel = messages.confirmLabel || '';
        const statusLabel = messages.statusLabel || (value => String(value || 'active'));
        return relations.map(row => {
            const relationTooltip = buildGraphRelationTooltip(row);
            const sourceText = describeSource(row);
            const rawStatus = String(row.status || 'active');
            const status = ['active', 'pending', 'deleted'].includes(rawStatus) ? rawStatus : 'active';
            const sourceSnippet = String(row.chunk_text || '').trim().slice(0, 180);
            return `
        <article class="rag-graph-relation ${layout.graphRelationTone(row.relation_type)} is-${escapeAttr(status)}" data-relation-id="${row.id}" data-graph-relation-tooltip="${escapeAttr(relationTooltip)}" title="${escapeAttr(relationTooltip)}">
            <header>
                <strong>
                    <span title="${escapeAttr(row.source_name || '')}">${escapeHtml(row.source_name)}</span>
                    <b>${escapeHtml(graphRelationLabel(row.relation_type))}</b>
                    <span title="${escapeAttr(row.target_name || '')}">${escapeHtml(row.target_name)}</span>
                </strong>
                <span class="rag-graph-confidence">${escapeHtml(formatConfidence(row))} · ${escapeHtml(statusLabel(status))}</span>
            </header>
            <div class="rag-graph-relation-foot">
                <p>
                    <span>${escapeHtml(sourceText)}</span>
                    ${row.description ? `<span>${escapeHtml(row.description)}</span>` : ''}
                </p>
                <div class="rag-graph-actions">
                    ${status === 'pending' ? `<button class="btn-secondary rag-graph-confirm-relation-btn" data-relation-id="${row.id}">${escapeHtml(confirmLabel)}</button>` : ''}
                    <button class="btn-secondary rag-graph-edit-relation-btn" data-relation-id="${row.id}">${escapeHtml(editLabel)}</button>
                    <button class="btn-danger rag-graph-delete-relation-btn" data-relation-id="${row.id}">${escapeHtml(deleteLabel)}</button>
                </div>
            </div>
            ${sourceSnippet ? `<p class="rag-graph-source-snippet">${escapeHtml(sourceSnippet)}</p>` : ''}
        </article>
    `;
        }).join('') || emptyHtml;
    }

    function buildGraphSelectOptionsHtml(values = [], selectedValue = '', options = {}) {
        const escapeHtml = options.escapeHtml || (value => String(value ?? ''));
        const escapeAttr = options.escapeAttr || (value => String(value ?? ''));
        const getLabel = options.getLabel || (value => String(value ?? ''));
        const selectedKey = String(selectedValue ?? '');
        return values.map(value => {
            const key = String(value ?? '');
            return `<option value="${escapeAttr(key)}" ${key === selectedKey ? 'selected' : ''}>${escapeHtml(getLabel(value))}</option>`;
        }).join('');
    }

    function buildGraphTypeOptionsHtml(selectedType = 'concept', options = {}) {
        const values = [...Object.keys(GRAPH_TYPE_LABELS)];
        if (selectedType && !values.includes(selectedType)) values.push(selectedType);
        return buildGraphSelectOptionsHtml(values, selectedType, {
            ...options,
            getLabel: graphTypeLabel
        });
    }

    function buildGraphRelationOptionsHtml(selectedType = 'related_to', options = {}) {
        const values = [...GRAPH_RELATION_ORDER];
        if (selectedType && !values.includes(selectedType)) values.push(selectedType);
        return buildGraphSelectOptionsHtml(values, selectedType, {
            ...options,
            getLabel: graphRelationLabel
        });
    }

    function buildGraphRelationFilterOptionsHtml(options = {}) {
        const escapeHtml = options.escapeHtml || (value => String(value ?? ''));
        return [
            `<option value="">${escapeHtml(options.emptyLabel || '')}</option>`,
            buildGraphRelationOptionsHtml('', options)
        ].join('');
    }

    function buildGraphQueryResultHtml(result = {}, options = {}) {
        const escapeHtml = options.escapeHtml || (value => String(value ?? ''));
        const graphRelationLabel = options.graphRelationLabel || (value => String(value ?? ''));
        const messages = options.messages || {};
        const entities = Array.isArray(result.entities) ? result.entities : [];
        const paths = Array.isArray(result.paths) ? result.paths : [];
        if (!String(result.query || '').trim()) return '';
        const entityHtml = entities.slice(0, 6)
            .map(entity => `<span>${escapeHtml(entity.name)}<small>${escapeHtml(entity.type || 'concept')}</small></span>`)
            .join('');
        const pathHtml = paths.slice(0, 8)
            .map(path => `
                <div class="rag-graph-path">
                    <strong>${escapeHtml(path.source || '')}</strong>
                    <b>${escapeHtml(graphRelationLabel(path.relationType))}</b>
                    <strong>${escapeHtml(path.target || '')}</strong>
                    <small>${escapeHtml(path.docName || messages.defaultSource || '')} · ${Number(path.confidence || 0).toFixed(2)}</small>
                </div>
            `)
            .join('');
        return `
            <div class="rag-graph-query-meta">
                <span>${escapeHtml(messages.hintLabel || '')}${escapeHtml(result.answerHint || '')}</span>
                <span>${escapeHtml(messages.entityLabel || '')}${entities.length}</span>
                <span>${escapeHtml(messages.pathLabel || '')}${paths.length}</span>
            </div>
            ${entityHtml ? `<div class="rag-graph-query-entities">${entityHtml}</div>` : ''}
            ${pathHtml || `<div class="rag-debug-empty">${escapeHtml(messages.emptyPath || '')}</div>`}
        `;
    }

    function buildGraphTypeFilterOptionsHtml(options = {}) {
        const escapeHtml = options.escapeHtml || (value => String(value ?? ''));
        return [
            `<option value="">${escapeHtml(options.emptyLabel || '')}</option>`,
            buildGraphTypeOptionsHtml('', options)
        ].join('');
    }

    function buildGraphEntityEditorHtml(entity = {}, options = {}) {
        const escapeHtml = options.escapeHtml || (value => String(value ?? ''));
        const escapeAttr = options.escapeAttr || (value => String(value ?? ''));
        const graphTypeLabel = options.graphTypeLabel || (value => String(value ?? ''));
        const mergeCandidates = Array.isArray(options.mergeCandidates) ? options.mergeCandidates : [];
        const typeOptionsHtml = options.typeOptionsHtml || '';
        const messages = options.messages || {};
        const mergeOptionsHtml = mergeCandidates
            .map(item => `<option value="${escapeAttr(item.id)}">${escapeHtml(item.name)}（${escapeHtml(graphTypeLabel(item.type))}）</option>`)
            .join('');
        return `
        <div class="rag-graph-editor-grid">
            <label>${escapeHtml(messages.nameLabel || '')}<input id="rag-graph-edit-name" class="form-input" value="${escapeAttr(entity.name || '')}"></label>
            <label>${escapeHtml(messages.typeLabel || '')}<select id="rag-graph-edit-type" class="form-input">${typeOptionsHtml}</select></label>
            <label>${escapeHtml(messages.mergeTargetLabel || '')}<input id="rag-graph-merge-target" class="form-input" list="rag-graph-merge-candidates" placeholder="${escapeAttr(messages.mergeTargetPlaceholder || '')}"></label>
            <datalist id="rag-graph-merge-candidates">${mergeOptionsHtml}</datalist>
            <label class="rag-graph-editor-wide">${escapeHtml(messages.descriptionLabel || '')}<textarea id="rag-graph-edit-description" class="form-input" rows="2">${escapeHtml(entity.description || '')}</textarea></label>
        </div>
        <div class="rag-graph-editor-actions">
            <button id="rag-graph-save-entity-btn" class="btn-secondary" data-entity-id="${escapeAttr(entity.id)}">${escapeHtml(messages.saveLabel || '')}</button>
            <button id="rag-graph-merge-entity-btn" class="btn-secondary" data-source-entity-id="${escapeAttr(entity.id)}">${escapeHtml(messages.mergeLabel || '')}</button>
            <button id="rag-graph-cancel-editor-btn" class="btn-secondary">${escapeHtml(messages.cancelLabel || '')}</button>
        </div>
    `;
    }

    function buildGraphRelationEditorHtml(relation = {}, options = {}) {
        const escapeHtml = options.escapeHtml || (value => String(value ?? ''));
        const escapeAttr = options.escapeAttr || (value => String(value ?? ''));
        const relationOptionsHtml = options.relationOptionsHtml || '';
        const messages = options.messages || {};
        return `
        <div class="rag-graph-editor-grid">
            <label>${escapeHtml(messages.sourceLabel || '')}<input class="form-input" value="${escapeAttr(relation.source_name || '')}" readonly></label>
            <label>${escapeHtml(messages.typeLabel || '')}<select id="rag-graph-edit-relation-type" class="form-input">${relationOptionsHtml}</select></label>
            <label>${escapeHtml(messages.targetLabel || '')}<input class="form-input" value="${escapeAttr(relation.target_name || '')}" readonly></label>
            <label class="rag-graph-editor-wide">${escapeHtml(messages.descriptionLabel || '')}<textarea id="rag-graph-edit-relation-description" class="form-input" rows="2">${escapeHtml(relation.description || '')}</textarea></label>
        </div>
        <div class="rag-graph-editor-actions">
            <button id="rag-graph-save-relation-btn" class="btn-secondary" data-relation-id="${escapeAttr(relation.id)}">${escapeHtml(messages.saveLabel || '')}</button>
            <button id="rag-graph-cancel-editor-btn" class="btn-secondary">${escapeHtml(messages.cancelLabel || '')}</button>
        </div>
    `;
    }

    function buildGraphModalShellHtml(options = {}) {
        const escapeHtml = options.escapeHtml || (value => String(value ?? ''));
        const escapeAttr = options.escapeAttr || (value => String(value ?? ''));
        const messages = options.messages || {};
        const typeFilterOptionsHtml = options.typeFilterOptionsHtml || '';
        return `
        <div class="modal rag-graph-modal">
            <div class="rag-detail-header">
                <div>
                    <h3>${escapeHtml(messages.title || '')}</h3>
                    <p class="model-modal-desc">${escapeHtml(messages.description || '')}</p>
                </div>
                <button type="button" id="rag-graph-close-btn" class="btn-danger-outline">${escapeHtml(messages.closeLabel || '')}</button>
            </div>
            <div class="rag-graph-topbar">
                <div id="rag-graph-summary" class="rag-graph-summary"></div>
                <div class="rag-graph-toolbar">
                    <input id="rag-graph-search" class="form-input" placeholder="${escapeAttr(messages.searchPlaceholder || '')}">
                    <select id="rag-graph-type" class="form-input">${typeFilterOptionsHtml}</select>
                    <select id="rag-graph-quality" class="form-input">
                        <option value="">${escapeHtml(messages.qualityAllLabel || '')}</option>
                        <option value="orphan">${escapeHtml(messages.qualityOrphanLabel || '')}</option>
                        <option value="low">${escapeHtml(messages.qualityLowLabel || '')}</option>
                    </select>
                    <button id="rag-graph-search-btn" class="btn-secondary">${escapeHtml(messages.searchLabel || '')}</button>
                    <input id="rag-graph-query" class="form-input" placeholder="${escapeAttr(messages.queryPlaceholder || '')}">
                    <button id="rag-graph-query-btn" class="btn-secondary">${escapeHtml(messages.queryLabel || '')}</button>
                </div>
            </div>
            <div class="rag-graph-query-panel">
                <div id="rag-graph-query-results" class="rag-graph-query-results"></div>
            </div>
            <div class="rag-graph-layout">
                <section class="rag-graph-panel">
                    <div class="rag-graph-panel-head">
                        <strong>${escapeHtml(messages.entitiesTitle || '')}</strong>
                        <span id="rag-graph-entity-count">0</span>
                    </div>
                    <div id="rag-graph-entities" class="rag-graph-entity-list"></div>
                </section>
                <section class="rag-graph-panel rag-graph-canvas-panel">
                    <div class="rag-graph-panel-head">
                        <strong>${escapeHtml(messages.canvasTitle || '')}</strong>
                        <div class="rag-graph-panel-actions">
                            <button id="rag-graph-edit-entity-btn" class="btn-secondary hidden">${escapeHtml(messages.editEntityLabel || '')}</button>
                            <button id="rag-graph-rebuild-doc-btn" class="btn-secondary hidden">${escapeHtml(messages.rebuildDocLabel || '')}</button>
                        </div>
                    </div>
                    <div id="rag-graph-canvas" class="rag-graph-canvas"></div>
                </section>
                <section class="rag-graph-panel">
                    <div class="rag-graph-panel-head">
                        <strong>${escapeHtml(messages.relationsTitle || '')}</strong>
                        <span id="rag-graph-relation-count">0</span>
                    </div>
                    <div class="rag-graph-filter-row">
                        <select id="rag-graph-relation-status" class="form-input">
                            <option value="active">${escapeHtml(messages.statusActiveLabel || '')}</option>
                            <option value="all">${escapeHtml(messages.statusAllLabel || '')}</option>
                            <option value="pending">${escapeHtml(messages.statusPendingLabel || '')}</option>
                        </select>
                        <select id="rag-graph-relation-type" class="form-input">${options.relationFilterOptionsHtml || ''}</select>
                        <input id="rag-graph-min-confidence" class="form-input" type="number" min="0" max="1" step="0.05" placeholder="${escapeAttr(messages.minConfidencePlaceholder || '')}">
                    </div>
                    <div id="rag-graph-relations" class="rag-graph-relation-list"></div>
                </section>
            </div>
        </div>
    `;
    }

    function buildGraphEditorModalShellHtml(options = {}) {
        const escapeHtml = options.escapeHtml || (value => String(value ?? ''));
        const messages = options.messages || {};
        return `
        <div class="modal rag-graph-editor-modal" role="dialog" aria-modal="true" aria-labelledby="rag-graph-editor-title">
            <div class="rag-graph-editor-modal-head">
                <div>
                    <h3 id="rag-graph-editor-title">${escapeHtml(messages.title || '')}</h3>
                    <p id="rag-graph-editor-subtitle" class="model-modal-desc"></p>
                </div>
                <button type="button" id="rag-graph-editor-close-btn" class="btn-danger-outline">${escapeHtml(messages.closeLabel || '')}</button>
            </div>
            <div id="rag-graph-editor-body" class="rag-graph-editor-modal-body"></div>
        </div>
    `;
    }

    window.Pivot = window.Pivot || {};
    window.Pivot.ragGraphRender = {
        buildGraphCanvasMarkup,
        buildGraphEntitiesHtml,
        buildGraphEntityEditorHtml,
        buildGraphEditorModalShellHtml,
        buildGraphModalShellHtml,
        buildGraphNodeTooltip,
        buildGraphRelationTooltip,
        buildGraphQueryResultHtml,
        buildGraphRelationFilterOptionsHtml,
        buildGraphRelationOptionsHtml,
        buildGraphRelationEditorHtml,
        buildGraphRelationsHtml,
        buildGraphSelectOptionsHtml,
        buildGraphTypeFilterOptionsHtml,
        buildGraphTypeOptionsHtml,
        buildGraphSummaryHtml
        ,
        getGraphNodeName,
        graphRelationLabel,
        graphTypeLabel
    };
})();
