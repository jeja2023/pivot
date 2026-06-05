/* 知识图谱布局辅助函数 Knowledge graph layout helpers */



(function () {
    function graphRelationTone(type) {
        return ({
            responsible_for: 'is-owner',
            belongs_to: 'is-belong',
            depends_on: 'is-depend',
            contains: 'is-contain',
            affects: 'is-affect'
        })[type] || 'is-related';
    }

    function getGraphRelationEndpointIds(row = {}) {
        return {
            sourceId: Number(row.source_entity_id),
            targetId: Number(row.target_entity_id)
        };
    }

    function buildGraphNodeLayout(nodes, centerId) {
        const centerNode = nodes.find(node => Number(node.id) === centerId) || nodes[0];
        const neighbors = nodes
            .filter(node => Number(node.id) !== Number(centerNode?.id))
            .slice(0, 12);
        const layoutNodes = centerNode ? [centerNode, ...neighbors] : neighbors;
        const positions = new Map();
        if (centerNode) positions.set(Number(centerNode.id), { x: 50, y: 50, role: 'center' });
        const count = neighbors.length;
        neighbors.forEach((node, index) => {
            const angle = (-Math.PI / 2) + (Math.PI * 2 * index / Math.max(count, 1));
            const radiusX = count <= 6 ? 31 : 37;
            const radiusY = count <= 6 ? 27 : 34;
            positions.set(Number(node.id), {
                x: Math.max(12, Math.min(88, 50 + Math.cos(angle) * radiusX)),
                y: Math.max(14, Math.min(86, 50 + Math.sin(angle) * radiusY)),
                role: 'neighbor'
            });
        });
        return { layoutNodes, positions };
    }

    function clampGraphZoom(scale, minZoom, maxZoom) {
        return Math.min(maxZoom, Math.max(minZoom, scale));
    }

    function createGraphDegreeMap(relations = []) {
        const degreeMap = new Map();
        relations.forEach(row => {
            const { sourceId, targetId } = getGraphRelationEndpointIds(row);
            degreeMap.set(sourceId, (degreeMap.get(sourceId) || 0) + 1);
            degreeMap.set(targetId, (degreeMap.get(targetId) || 0) + 1);
        });
        return degreeMap;
    }

    function collectVisibleGraphEdges(relations = [], positions, limit = 24) {
        return relations
            .filter(row => {
                const { sourceId, targetId } = getGraphRelationEndpointIds(row);
                return positions.has(sourceId) && positions.has(targetId);
            })
            .slice(0, Math.max(0, limit));
    }

    function buildGraphEdgePathData(graphEdges = [], positions) {
        return graphEdges.map((row, index) => {
            const { sourceId, targetId } = getGraphRelationEndpointIds(row);
            const sourcePos = positions.get(sourceId);
            const targetPos = positions.get(targetId);
            const midX = (sourcePos.x + targetPos.x) / 2;
            const midY = (sourcePos.y + targetPos.y) / 2;
            const offset = index % 2 === 0 ? 5 : -5;
            const controlX = midX + ((targetPos.y - sourcePos.y) / 100) * offset;
            const controlY = midY - ((targetPos.x - sourcePos.x) / 100) * offset;
            return {
                row,
                className: graphRelationTone(row.relation_type),
                d: `M ${sourcePos.x.toFixed(2)} ${sourcePos.y.toFixed(2)} Q ${controlX.toFixed(2)} ${controlY.toFixed(2)} ${targetPos.x.toFixed(2)} ${targetPos.y.toFixed(2)}`
            };
        });
    }

    function buildGraphEdgeLabelData(graphEdges = [], positions, limit = 12) {
        return graphEdges.slice(0, Math.max(0, limit)).map(row => {
            const { sourceId, targetId } = getGraphRelationEndpointIds(row);
            const sourcePos = positions.get(sourceId);
            const targetPos = positions.get(targetId);
            return {
                row,
                className: graphRelationTone(row.relation_type),
                x: (sourcePos.x + targetPos.x) / 2,
                y: (sourcePos.y + targetPos.y) / 2
            };
        });
    }

    window.Pivot = window.Pivot || {};
    window.Pivot.ragGraphLayout = {
        buildGraphEdgeLabelData,
        buildGraphEdgePathData,
        buildGraphNodeLayout,
        clampGraphZoom,
        collectVisibleGraphEdges,
        createGraphDegreeMap,
        getGraphRelationEndpointIds,
        graphRelationTone
    };
})();
