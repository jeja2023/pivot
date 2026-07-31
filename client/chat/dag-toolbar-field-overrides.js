/* DAG 字段标签、说明与占位文案覆盖（拆自 dag-toolbar-fields.js） */




/* Field helpers extracted from dag-toolbar.js. */

const FIELD_LABEL_OVERRIDES = {
        aggregation: '聚合方式',
        apiKey: 'API 密钥',
        api_key: 'API 密钥',
        body: '请求内容',
        candidateLimit: '候选数量上限',
        candidate_limit: '候选数量上限',
        chartType: '图表类型',
        chart_type: '图表类型',
        collection: '集合',
        columns: '字段列表',
        content: '内容',
        countAlias: '数量列别名',
        count_alias: '数量列别名',
        data: '数据',
        file: '文件',
        filename: '文件名',
        filters: '筛选条件',
        footer: '页脚',
        groupAlias: '分组列别名',
        group_alias: '分组列别名',
        groupBy: '分组字段',
        group_by: '分组字段',
        headers: '请求头',
        input: '输入内容',
        instructions: '指令',
        items: '条目列表',
        language: '语言',
        leftPath: '左侧文件路径',
        left_path: '左侧文件路径',
        limit: '返回数量',
        markdown: 'Markdown 内容',
        matchMode: '匹配方式',
        match_mode: '匹配方式',
        maxChars: '最大字符数',
        max_chars: '最大字符数',
        maxHeadings: '最大标题数',
        max_headings: '最大标题数',
        maxItems: '最大条目数',
        max_items: '最大条目数',
        maxTokens: '最大输出长度',
        max_tokens: '最大输出长度',
        message: '消息内容',
        method: '请求方法',
        mode: '处理模式',
        model: '模型',
        path: '文件路径',
        pipeline: '聚合管道',
        pretty: '美化 JSON',
        prompt: '提示词',
        query: '检索问题 / 查询条件',
        renameMap: '字段重命名规则',
        rename_map: '字段重命名规则',
        responseFormat: '响应格式',
        response_format: '响应格式',
        rightPath: '右侧文件路径',
        right_path: '右侧文件路径',
        rows: '数据行',
        sampleRows: '样本行数',
        sample_rows: '样本行数',
        schema: '数据库 Schema / 命名空间',
        sections: '报告段落',
        sheet: '工作表',
        sortBy: '排序依据',
        sort_by: '排序依据',
        sortOrder: '排序方向',
        sort_order: '排序方向',
        sql: 'SQL 语句',
        stream: '流式输出',
        subtitle: '副标题',
        systemPrompt: '系统提示词',
        system_prompt: '系统提示词',
        table: '数据表',
        target: '接收对象',
        targetType: '接收对象类型',
        target_type: '接收对象类型',
        temperature: '随机性',
        text: '文本内容',
        title: '标题',
        tools: '工具列表',
        topK: '返回片段数',
        top_k: '返回片段数',
        trimStrings: '去除首尾空格',
        trim_strings: '去除首尾空格',
        url: '链接地址',
        value: '待处理内容',
        valueField: '指标字段',
        value_field: '指标字段',
        xAxis: '横轴字段',
        x_axis: '横轴字段',
        yAxis: '纵轴字段',
        y_axis: '纵轴字段'
    };

const TOOL_FIELD_LABEL_OVERRIDES = {
        'rag.search': {
            query: '知识库检索问题',
            topK: '返回片段数',
            top_k: '返回片段数',
            candidateLimit: '候选片段上限',
            candidate_limit: '候选片段上限'
        },
        'agent.llm': {
            prompt: '用户提示词',
            systemPrompt: '系统提示词',
            system_prompt: '系统提示词',
            model: '节点模型',
            temperature: '随机性',
            maxTokens: '最大输出长度',
            max_tokens: '最大输出长度',
            responseFormat: '输出格式',
            response_format: '输出格式'
        },
        'sessions.search': {
            query: '会话关键词'
        },
        'reports.list_files': {
            query: '文件关键词',
            limit: '文件数量上限'
        },
        'reports.read_file_summary': {
            path: '报表文件路径',
            sheet: '工作表名称',
            sampleRows: '样本行数',
            sample_rows: '样本行数'
        },
        'reports.query_table': {
            path: '报表文件路径',
            columns: '返回字段',
            filters: '筛选条件',
            limit: '返回行数'
        },
        'reports.compare_files': {
            leftPath: '左侧报表路径',
            left_path: '左侧报表路径',
            rightPath: '右侧报表路径',
            right_path: '右侧报表路径'
        },
        'db.run_readonly_query': {
            sql: '高级 SQL 语句',
            limit: '最大返回行数'
        },
        'db.group_count': {
            table: '统计数据表',
            groupBy: '分组统计字段',
            group_by: '分组统计字段',
            limit: '分组数量上限'
        },
        'viz.build_chart': {
            rows: '图表数据行',
            xAxis: '横轴字段',
            x_axis: '横轴字段',
            yAxis: '数值字段',
            y_axis: '数值字段',
            groupBy: '系列分组字段',
            group_by: '系列分组字段',
            limit: '图表数据上限'
        },
        'viz.build_table': {
            rows: '表格数据行',
            columns: '展示字段',
            limit: '展示行数'
        },
        'format.to_markdown_table': {
            rows: '表格数据行',
            columns: '展示字段',
            limit: '展示行数'
        },
        'format.to_json': {
            value: '要转换的内容',
            pretty: '格式化输出'
        },
        'format.extract_json': {
            text: '包含 JSON 的文本'
        },
        'format.normalize_text': {
            text: '待规范化文本'
        },
        'im.send_user_message': {
            target: '接收用户',
            title: '消息标题',
            message: '消息正文'
        },
        'im.send_group_message': {
            target: '接收群组',
            title: '消息标题',
            message: '消息正文'
        },
        'im.send_markdown': {
            target: '接收对象',
            targetType: '接收对象类型',
            target_type: '接收对象类型',
            markdown: 'Markdown 消息'
        }
    };

const FIELD_DESCRIPTION_OVERRIDES = {
        aggregation: '选择对数值字段执行求和、计数、平均值、最小值或最大值。',
        apiKey: '用于访问外部服务的密钥，通常不建议在节点参数里明文填写。',
        api_key: '用于访问外部服务的密钥，通常不建议在节点参数里明文填写。',
        candidateLimit: '系统初步召回的候选数量上限，越大越全面但可能更慢。',
        candidate_limit: '系统初步召回的候选数量上限，越大越全面但可能更慢。',
        chartType: '选择柱状图、折线图、面积图或饼图等展示方式。',
        chart_type: '选择柱状图、折线图、面积图或饼图等展示方式。',
        collection: 'MongoDB 集合名称。',
        columns: '需要读取、展示或输出的字段列表，可填写 JSON 数组。',
        filters: '按字段设置筛选条件，可填写 JSON 对象。',
        groupBy: '选择要按哪个字段分组统计。',
        group_by: '选择要按哪个字段分组统计。',
        groupAlias: '结果里分组字段的输出名称，通常保持默认即可。',
        group_alias: '结果里分组字段的输出名称，通常保持默认即可。',
        input: '传给工具或模型的主要输入内容。',
        instructions: '对工具或模型的执行指令。',
        language: '指定输出或处理使用的语言。',
        countAlias: '结果里数量字段的输出名称，通常保持默认即可。',
        count_alias: '结果里数量字段的输出名称，通常保持默认即可。',
        limit: '限制最多返回多少条结果，避免一次拉取过多数据。',
        markdown: '填写 Markdown 正文，支持插入上游变量。',
        matchMode: '选择精确匹配或包含匹配。',
        match_mode: '选择精确匹配或包含匹配。',
        maxChars: '限制每段或每次处理的最大字符数。',
        max_chars: '限制每段或每次处理的最大字符数。',
        maxHeadings: '最多提取多少个标题。',
        max_headings: '最多提取多少个标题。',
        maxItems: '最多提取多少个条目。',
        max_items: '最多提取多少个条目。',
        maxTokens: '限制模型最多输出多少 token。',
        max_tokens: '限制模型最多输出多少 token。',
        message: '要发送给目标用户或群组的正文。',
        model: '选择或填写本节点调用的模型名称。',
        path: '报表、数据文件或文档的路径。',
        pipeline: 'MongoDB 聚合管道，填写 JSON 数组。',
        pretty: '开启后输出带缩进的 JSON，便于阅读。',
        prompt: '写清任务目标、口径、约束和期望输出格式。',
        query: '输入要检索或查询的问题、关键词或条件。',
        renameMap: '字段旧名到新名的映射，填写 JSON 对象。',
        rename_map: '字段旧名到新名的映射，填写 JSON 对象。',
        responseFormat: '指定模型或工具返回内容的格式。',
        response_format: '指定模型或工具返回内容的格式。',
        rows: '表格数据行，通常引用上游节点的 rows 输出。',
        sampleRows: '读取文件摘要时展示的样本行数量。',
        sample_rows: '读取文件摘要时展示的样本行数量。',
        schema: '可选。用于限定数据库命名空间/模式，例如 PostgreSQL 的 public 或 SQL Server 的 dbo；MySQL、SQLite 通常留空。',
        sections: '报告段落配置，填写 JSON 数组。',
        sheet: 'Excel 工作表名称；CSV 文件通常留空。',
        sortBy: '选择按标签还是按数值排序。',
        sort_by: '选择按标签还是按数值排序。',
        sortOrder: '统计结果按升序或降序排列。',
        sort_order: '统计结果按升序或降序排列。',
        sql: '只允许填写 SELECT、WITH、SHOW、DESCRIBE、EXPLAIN 等只读语句。',
        stream: '开启后可流式返回内容；工作流节点通常保持默认即可。',
        table: '选择或输入要读取的数据表。',
        target: '要发送通知的用户、群组或目标标识。',
        targetType: '选择目标是用户还是群组。',
        target_type: '选择目标是用户还是群组。',
        temperature: '控制模型回复随机性，数值越高越发散。',
        text: '待处理的普通文本或 Markdown 内容。',
        title: '输出内容、图表、报告或消息标题。',
        tools: '可供模型或下游步骤调用的工具列表，填写 JSON 数组。',
        topK: '最终返回给下游节点的片段数量。',
        top_k: '最终返回给下游节点的片段数量。',
        trimStrings: '开启后会去除文本字段首尾空格。',
        trim_strings: '开启后会去除文本字段首尾空格。',
        value: '要转换、序列化或继续处理的内容。',
        valueField: '用于聚合计算的数值字段。',
        value_field: '用于聚合计算的数值字段。',
        xAxis: '作为图表横轴分类、时间或名称的字段。',
        x_axis: '作为图表横轴分类、时间或名称的字段。',
        yAxis: '作为图表纵轴数值的字段。',
        y_axis: '作为图表纵轴数值的字段。'
    };

const TOOL_FIELD_DESCRIPTION_OVERRIDES = {
        'rag.search': {
            query: '输入要从知识库里检索的问题或关键词。',
            topK: '最终返回给下游节点的知识片段数量。',
            top_k: '最终返回给下游节点的知识片段数量。',
            candidateLimit: '初步召回的候选片段上限，越大越全面但会更慢。',
            candidate_limit: '初步召回的候选片段上限，越大越全面但会更慢。'
        },
        'agent.llm': {
            prompt: '写清本节点要模型完成的任务，可引用上游节点输出或运行输入。',
            systemPrompt: '限定模型角色、语气、安全边界和输出口径；不填则使用工作流默认提示。',
            system_prompt: '限定模型角色、语气、安全边界和输出口径；不填则使用工作流默认提示。',
            model: '必填。填写本节点调用的模型 ID 或 model_name，工作流运行会从这里读取模型。',
            maxSteps: '本工作流运行允许的最大步骤数，作为运行任务的上限。',
            max_steps: '本工作流运行允许的最大步骤数，作为运行任务的上限。',
            responseFormat: '选择 Markdown、纯文本或 JSON，JSON 模式会要求模型只返回合法 JSON。'
        },
        'sessions.search': {
            query: '输入要查找的历史会话关键词或问题。'
        },
        'reports.query_table': {
            filters: '用字段名和值组成筛选条件，例如按状态、日期或部门过滤。'
        },
        'db.group_count': {
            table: '要做分布统计的数据表。',
            groupBy: '按这个字段分组并统计每组数量。',
            group_by: '按这个字段分组并统计每组数量。'
        },
        'viz.build_chart': {
            rows: '图表来源数据，通常引用上游查询或统计节点的 rows 输出。',
            yAxis: '用于绘制高度、数值或占比的字段；饼图可使用数量字段。',
            y_axis: '用于绘制高度、数值或占比的字段；饼图可使用数量字段。'
        }
    };

const FIELD_PLACEHOLDER_OVERRIDES = {
        apiKey: '建议改用系统配置，不在这里明文填写',
        api_key: '建议改用系统配置，不在这里明文填写',
        candidateLimit: '例如 80',
        candidate_limit: '例如 80',
        collection: '输入集合名',
        columns: '例如 ["name", "amount"]',
        filters: '例如 {"status": "active"}',
        groupBy: '选择或输入字段名',
        group_by: '选择或输入字段名',
        input: '输入内容，或插入上游变量',
        instructions: '写清执行要求和输出口径',
        language: '例如 中文',
        limit: '例如 50',
        markdown: '填写 Markdown 正文，或插入上游变量',
        maxChars: '例如 2000',
        max_chars: '例如 2000',
        maxHeadings: '例如 20',
        max_headings: '例如 20',
        maxItems: '例如 50',
        max_items: '例如 50',
        maxTokens: '例如 1024',
        max_tokens: '例如 1024',
        message: '填写要发送的消息内容',
        model: '填写模型名称',
        path: '选择或输入文件路径',
        pipeline: '填写 JSON 数组，例如 [{"$limit": 20}]',
        prompt: '写清任务、口径和输出要求',
        query: '输入要检索的问题或关键词',
        renameMap: '例如 {"old_name": "new_name"}',
        rename_map: '例如 {"old_name": "new_name"}',
        responseFormat: '例如 json 或 markdown',
        response_format: '例如 json 或 markdown',
        rows: '插入上游 rows 变量，或粘贴 JSON 数组',
        sampleRows: '例如 20',
        sample_rows: '例如 20',
        schema: '不确定就留空；PostgreSQL 可填 public，SQL Server 可填 dbo',
        sections: '填写报告段落 JSON 数组',
        sheet: '输入工作表名，CSV 可留空',
        sql: 'SELECT ... FROM ...',
        stream: '不确定时保持默认',
        table: '选择或输入表名',
        target: '输入用户、群组或目标标识',
        temperature: '0 到 2，越高越发散',
        text: '输入文本，或插入上游变量',
        title: '不填则自动生成',
        tools: '填写 JSON 数组，或留空使用默认工具',
        topK: '例如 5',
        top_k: '例如 5',
        value: '输入内容，或插入上游变量',
        valueField: '输入用于计算的字段名',
        value_field: '输入用于计算的字段名',
        xAxis: '输入横轴字段名',
        x_axis: '输入横轴字段名',
        yAxis: '输入数值字段名',
        y_axis: '输入数值字段名'
    };

const TOOL_FIELD_PLACEHOLDER_OVERRIDES = {
        'rag.search': {
            query: '例如：最近 30 天哪个产品线投诉最多？',
            topK: '例如 5',
            top_k: '例如 5',
            candidateLimit: '例如 80',
            candidate_limit: '例如 80'
        },
        'agent.llm': {
            prompt: '例如：请基于 {{nodes.search.output}} 总结关键发现',
            systemPrompt: '例如：你是严谨的数据分析助手，只根据输入回答',
            system_prompt: '例如：你是严谨的数据分析助手，只根据输入回答',
            model: '必填：模型 ID 或 model_name',
            maxSteps: '例如 20',
            max_steps: '例如 20',
            maxTokens: '例如 1200',
            max_tokens: '例如 1200',
            responseFormat: 'markdown / text / json'
        },
        'sessions.search': {
            query: '输入会话关键词'
        },
        'reports.list_files': {
            query: '输入文件名或业务关键词'
        },
        'db.run_readonly_query': {
            sql: '复杂场景示例：SELECT ... FROM ... WHERE ... LIMIT 100'
        },
        'db.group_count': {
            table: '选择统计数据表',
            groupBy: '选择分组字段',
            group_by: '选择分组字段'
        }
    };
