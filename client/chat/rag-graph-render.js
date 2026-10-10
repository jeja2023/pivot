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
        const chunkText = String(row.excerpt_text || row.chunk_text || '').trim();
        const lines = [
            `起点：${row.source_name || '-'}`,
            `关系：${relationText}${row.relation_type && row.relation_type !== relationText ? `（${row.relation_type}）` : ''}`,
            `终点：${row.target_name || '-'}`,
            `状态：${row.status || 'active'}`,
            `来源：${row.doc_name || '知识图谱'}`,
            `可信度：${Number(row.confidence || 0).toFixed(2)}`,
            row.description ? `描述：${row.description}` : '',
            row.id ? `关系 ID：${row.id}` : ''
        ].filter(Boolean);
        if (chunkText) {
            lines.splice(Math.max(lines.length - (row.id ? 1 : 0), 0), 0, `内容：${chunkText}`);
        }
        return lines.join('\n');
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
        const buildGraphNodeTooltip = options.buildGraphNodeTooltip || (() => '');
        return entities.map(entity => {
            const entityTooltip = buildGraphNodeTooltip(entity, Number(entity.relation_count || 0), false);
            return `
        <button class="rag-graph-entity ${Number(entity.id) === selectedEntityId ? 'active' : ''}" data-entity-id="${entity.id}" data-graph-node-tooltip="${escapeAttr(entityTooltip)}" aria-label="${escapeAttr(entityTooltip)}">
            <span>
                <strong>${escapeHtml(entity.name)}</strong>
                <small>${describeEntityMeta(entity, graphTypeLabel, escapeHtml)}</small>
            </span>
            <em aria-label="${escapeAttr(formatConfidence(entity))}">${escapeHtml(formatConfidence(entity))}</em>
        </button>
    `;
        }).join('') || emptyHtml;
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
            return `<button class="rag-graph-node rag-graph-map-node ${isCenter ? 'center' : ''}" data-entity-id="${node.id}" data-graph-node-tooltip="${escapeAttr(nodeTooltip)}" style="left:${pos.x.toFixed(2)}%;top:${pos.y.toFixed(2)}%;">
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
            const sourceSnippet = String(row.excerpt_text || row.chunk_text || '').trim().slice(0, 180);
            return `
        <article class="rag-graph-relation ${layout.graphRelationTone(row.relation_type)} is-${escapeAttr(status)}" data-relation-id="${row.id}" data-graph-relation-tooltip="${escapeAttr(relationTooltip)}">
            <header>
                <strong>
                    <span>${escapeHtml(row.source_name)}</span>
                    <b>${escapeHtml(graphRelationLabel(row.relation_type))}</b>
                    <span>${escapeHtml(row.target_name)}</span>
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
        const escapeAttr = options.escapeAttr || (value => String(value ?? ''));
        const graphRelationLabel = options.graphRelationLabel || (value => String(value ?? ''));
        const graphTypeLabel = options.graphTypeLabel || (value => String(value ?? ''));
        const messages = options.messages || {};
        const entities = Array.isArray(result.entities) ? result.entities : [];
        const paths = Array.isArray(result.paths) ? result.paths : [];
        if (!String(result.query || '').trim()) return '';

        const hintText = result.answerHint || (paths.length
            ? (messages.defaultPathHint || '已找到关联关系路径，点击节点或路径可在画布中定位。')
            : (messages.emptyPath || '未找到明确关系路径，建议更换关键词。'));

        const entityChipsHtml = entities.slice(0, 8)
            .map(entity => `
                <button type="button" class="btn-secondary rag-graph-query-chip" data-entity-id="${escapeAttr(entity.id || '')}" data-entity-name="${escapeAttr(entity.name || '')}" title="在画布中定位此实体">
                    <span class="rag-graph-query-chip-name">${escapeHtml(entity.name)}</span>
                    <span class="rag-graph-query-chip-type">${escapeHtml(graphTypeLabel(entity.type || 'concept'))}</span>
                </button>
            `)
            .join('');

        const pathCardsHtml = paths.slice(0, 10)
            .map(path => {
                const docLabel = path.docName || messages.defaultSource || '知识图谱';
                const sourceTitle = `在画布中定位「${path.source || ''}」`;
                const targetTitle = `在画布中定位「${path.target || ''}」`;
                return `
                <div class="rag-graph-path-card" data-source="${escapeAttr(path.source || '')}" data-target="${escapeAttr(path.target || '')}" data-relation-id="${escapeAttr(path.relationId || '')}">
                    <div class="rag-graph-path-flow">
                        <button type="button" class="btn-secondary rag-graph-path-node source" data-entity-name="${escapeAttr(path.source || '')}" title="${escapeAttr(sourceTitle)}">
                            ${escapeHtml(path.source || '')}
                        </button>
                        <div class="rag-graph-path-connector">
                            <span class="rag-graph-path-pill">${escapeHtml(graphRelationLabel(path.relationType))}</span>
                            <span class="rag-graph-path-arrow">➔</span>
                        </div>
                        <button type="button" class="btn-secondary rag-graph-path-node target" data-entity-name="${escapeAttr(path.target || '')}" title="${escapeAttr(targetTitle)}">
                            ${escapeHtml(path.target || '')}
                        </button>
                    </div>
                    <div class="rag-graph-path-meta">
                        <span class="rag-graph-path-doc" title="${escapeAttr(docLabel)}">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>
                            <span>${escapeHtml(docLabel)}</span>
                        </span>
                        <span class="rag-graph-path-conf">可信度 <b>${Number(path.confidence || 0).toFixed(2)}</b></span>
                    </div>
                    ${path.description ? `<div class="rag-graph-path-desc">${escapeHtml(path.description)}</div>` : ''}
                </div>
            `;
            })
            .join('');

        return `
            <div class="rag-graph-query-banner">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="rag-graph-query-banner-icon"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>
                <span>${escapeHtml(hintText)}</span>
            </div>
            ${entityChipsHtml ? `
                <div class="rag-graph-query-group">
                    <div class="rag-graph-query-group-label">
                        <span>匹配实体</span>
                        <small>${entities.length}</small>
                    </div>
                    <div class="rag-graph-query-entities">${entityChipsHtml}</div>
                </div>
            ` : ''}
            <div class="rag-graph-query-group">
                <div class="rag-graph-query-group-label">
                    <span>关联路径</span>
                    <small>${paths.length}</small>
                </div>
                ${pathCardsHtml ? `
                    <div class="rag-graph-query-paths">${pathCardsHtml}</div>
                ` : `
                    <div class="rag-graph-query-empty">
                        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="10"></circle><line x1="8" y1="12" x2="16" y2="12"></line></svg>
                        <span>${escapeHtml(messages.emptyPath || '未找到关联关系路径')}</span>
                        <small>建议缩短查询词或更换关键词</small>
                    </div>
                `}
            </div>
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
        let aliases = [];
        try { aliases = Array.isArray(entity.aliases) ? entity.aliases : JSON.parse(entity.aliases || '[]'); } catch (_) {}
        const mergeOptionsHtml = mergeCandidates
            .map(item => `<option value="${escapeAttr(item.id)}">${escapeHtml(item.name)}（${escapeHtml(graphTypeLabel(item.type))}）</option>`)
            .join('');
        return `
        <div class="rag-graph-editor-grid">
            <label>${escapeHtml(messages.nameLabel || '')}<input id="rag-graph-edit-name" class="form-input" value="${escapeAttr(entity.name || '')}"></label>
            <label>${escapeHtml(messages.typeLabel || '')}<select id="rag-graph-edit-type" class="form-input">${typeOptionsHtml}</select></label>
            <label>${escapeHtml(messages.aliasesLabel || '别名')}<input id="rag-graph-edit-aliases" class="form-input" value="${escapeAttr((Array.isArray(aliases) ? aliases : []).join('、'))}" placeholder="别名之间用顿号或逗号分隔"></label>
            <label>${escapeHtml(messages.mergeTargetLabel || '')}<input id="rag-graph-merge-target" class="form-input" list="rag-graph-merge-candidates" placeholder="${escapeAttr(messages.mergeTargetPlaceholder || '')}"></label>
            <datalist id="rag-graph-merge-candidates">${mergeOptionsHtml}</datalist>
            <label class="rag-graph-editor-wide">${escapeHtml(messages.descriptionLabel || '')}<textarea id="rag-graph-edit-description" class="form-input" rows="2">${escapeHtml(entity.description || '')}</textarea></label>
            <label class="rag-graph-editor-wide"><input id="rag-graph-edit-frozen" type="checkbox" ${entity.frozen ? 'checked' : ''}> ${escapeHtml(messages.freezeLabel || '冻结人工校准，后续抽取不覆盖')}</label>
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
            <label>${escapeHtml(messages.stanceLabel || '证据立场')}<select id="rag-graph-edit-relation-stance" class="form-input"><option value="supports" ${relation.stance === 'contradicts' ? '' : 'selected'}>支持关系</option><option value="contradicts" ${relation.stance === 'contradicts' ? 'selected' : ''}>存在矛盾</option></select></label>
            <label class="rag-graph-editor-wide">${escapeHtml(messages.descriptionLabel || '')}<textarea id="rag-graph-edit-relation-description" class="form-input" rows="2">${escapeHtml(relation.description || '')}</textarea></label>
            <label class="rag-graph-editor-wide"><input id="rag-graph-edit-relation-frozen" type="checkbox" ${relation.frozen ? 'checked' : ''}> ${escapeHtml(messages.freezeLabel || '冻结人工校准，后续抽取不覆盖')}</label>
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
        const closeQueryLabel = messages.closeQueryLabel || '关闭查询结果';
        return `
        <div class="modal rag-graph-modal">
            <div class="rag-detail-header">
                <div>
                    <h3 id="rag-graph-modal-title">${escapeHtml(messages.title || '')}</h3>
                    <p id="rag-graph-modal-description" class="model-modal-desc">${escapeHtml(messages.description || '')}</p>
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
            <div id="rag-graph-query-panel" class="rag-graph-query-panel" hidden>
                <div class="rag-graph-query-head">
                    <div class="rag-graph-query-title-wrap">
                        <span class="rag-graph-query-icon">
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><path d="m21 21-4.35-4.35"></path></svg>
                        </span>
                        <strong class="rag-graph-query-title">${escapeHtml(messages.queryResultsTitle || '图谱路径查询')}</strong>
                        <div id="rag-graph-query-counts" class="rag-graph-query-counts"></div>
                    </div>
                    <button type="button" id="rag-graph-query-close-btn" class="workspace-modal-close btn-secondary rag-graph-query-close" title="${escapeAttr(closeQueryLabel)}" aria-label="${escapeAttr(closeQueryLabel)}">×</button>
                </div>
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
