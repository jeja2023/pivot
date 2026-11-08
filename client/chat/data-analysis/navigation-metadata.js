(function () {
    const app = window.Pivot.legacy.PivotDataAnalysis;
    app.analysisTabHeaders = {
            transactions: { title: '资金分析', desc: '确认交易映射与收支口径，按币种精确核算借贷与对手方，发掘可穿透追溯的异常资金流向。' },
            overview: {
                title: '\u6570\u636e\u603b\u89c8',
                desc: '\u4e0a\u4f20\u8868\u683c\u6570\u636e\uff0c\u5bfc\u5165\u6570\u636e\u96c6\uff0c\u5e76\u5bf9\u6570\u636e\u96c6\u8fdb\u884c\u9884\u89c8\u548c\u7ba1\u7406\u3002'
            },
            governance: {
                title: '字段治理',
                desc: '统一维护字段定义、敏感级别、计算字段、共享范围、指标口径和跨数据集模型。'
            },
            modeling: { title: '数据建模', desc: '从事实粒度出发维护表、关联、维度和指标，检查发布后复用同一分析口径。' },
            cleaning: {
                title: '数据清洗',
                desc: '识别缺失、重复、格式与离群问题，按可预览、可回放的规则生成新的清洗后数据集。'
            },
            chart: {
                title: '图表生成',
                desc: '选择分类与数值字段，自适应聚合生成柱状图、折线图、面积图或饼图。'
            },
            compare: {
                title: '数据比对',
                desc: '选择两个不同的数据集及对应主键，进行存在性比对与字段差异分析。'
            },
            query: {
                title: '数据查询',
                desc: '使用只读 SQL 语句对当前数据集进行自定义数据查询与高级筛选。'
            },
            pivot: {
                title: '数据透视',
                desc: '配置行维度、列维度及值字段对数据进行多维交叉聚合与透视分析。'
            },
            ai: {
                title: '智能分析',
                desc: '调用大语言模型智能分析数据集，提供分析方向、推荐图表与报告摘要等深度洞察。'
            },
            assets: {
                title: '分析资产',
                desc: '保存、共享和复跑当前图表、透视表与查询结果，沉淀可复用的分析成果。'
            },
            dashboards: {
                title: '仪表盘',
                desc: '组合分析资产形成协作看板，并配置刷新计划、快照和阈值告警。'
            },
            history: {
                title: '历史记录',
                desc: '查看当前数据集在图表生成、数据透视、数据比对、导出和 SQL 查询中的历史记录。'
            }
        };
})();
