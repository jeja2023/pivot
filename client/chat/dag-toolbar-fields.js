/* DAG 字段辅助函数（拆自 dag-toolbar.js） */




function normalizeFieldKey(name = '') {
        return String(name || '')
            .trim()
            .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
            .replace(/[\s.-]+/g, '_')
            .toLowerCase();
    }

function fieldLookupKeys(name = '') {
        const raw = String(name || '').trim();
        const normalized = normalizeFieldKey(raw);
        return [...new Set([raw, normalized])].filter(Boolean);
    }

function readFieldOverride(map, name) {
        if (!map || !name) return '';
        const keys = fieldLookupKeys(name);
        for (const key of keys) {
            if (Object.prototype.hasOwnProperty.call(map, key)) return map[key];
        }
        return '';
    }

function readToolFieldOverride(map, name, tool) {
        if (!map || !tool) return '';
        const shortName = toolShortName(tool);
        const fullName = toolValue(tool);
        const toolMaps = [map[shortName], map[fullName]].filter(Boolean);
        for (const toolMap of toolMaps) {
            const value = readFieldOverride(toolMap, name);
            if (value) return value;
        }
        return '';
    }

function hasChineseText(value = '') {
        return /[\u4e00-\u9fff]/.test(String(value || ''));
    }

function normalizeSchemaType(schema = {}) {
        const type = Array.isArray(schema?.type) ? schema.type[0] : schema?.type;
        return String(type || '').trim() || 'string';
    }

const TOOL_PRIMARY_FIELD_NAMES = {
        'agent.llm': ['prompt', 'model', 'systemPrompt'],
        'agent.content_review': ['records', 'model', 'idField', 'titleField', 'contentField', 'instructions', 'reportTitle'],
        'agent.delegate': ['task', 'context', 'agentName', 'role', 'instructions', 'model'],
        'agent.handoff': ['fromAgent', 'toAgent', 'summary'],
        'agent.code': ['code', 'vars'],
        'agent.http': ['url', 'method', 'body', 'credentialSecret'],
        'agent.browser': ['url', 'action', 'target', 'screenshot'],
        'agent.merge': ['fields'],
        'workflow.input': ['label', 'name', 'type', 'required', 'defaultValue', 'description'],
        'workflow.output': ['name', 'value', 'tableTitle', 'tableColumns', 'fileRef'],
        'workflow.condition': ['value', 'operator', 'compareTo'],
        'workflow.approval': ['title', 'summary', 'instructions', 'approvers', 'approverUnits', 'mode', 'timeoutHours', 'timeoutAction'],
        'workflow.foreach': ['items', 'code', 'vars', 'stopOnError'],
        'workflow.subworkflow': ['workflowId', 'goal', 'inputs'],
        'workflow.delay': ['durationMs', 'reason'],
        'report.compose': ['title', 'summary', 'sections', 'includeToc'],
        'rag.search': ['query', 'topK'],
        'sessions.search': ['query'],
        'knowledge.graph.query': ['query'],
        'viz.build_chart': ['rows', 'chartType', 'title', 'xAxis', 'yAxis', 'groupBy', 'aggregation'],
        'viz.build_table': ['rows', 'columns', 'title'],
        'reports.read_file_summary': ['path', 'sheet', 'sampleRows'],
        'reports.query_table': ['path', 'sheet', 'columns', 'filters', 'limit'],
        'reports.compare_files': ['leftPath', 'rightPath', 'sheet', 'sampleRows'],
        'doc.extract_outline': ['text', 'maxHeadings'],
        'doc.extract_key_values': ['text', 'maxItems'],
        'doc.chunk_text': ['text', 'maxChars'],
        'data.filter_rows': ['rows', 'filters', 'matchMode', 'limit'],
        'data.group_summary': ['rows', 'groupBy', 'valueField', 'aggregation', 'limit'],
        'data.profile_rows': ['rows', 'limit'],
        'data.normalize_fields': ['rows', 'renameMap', 'trimStrings', 'limit']
    };

const TOOL_HIDDEN_FIELD_NAMES = {
        'agent.llm': ['responseFormat'],
        'agent.content_review': ['rows', 'data'],
        'workflow.output': ['format', 'presentation'],
        'workflow.approval': ['timeoutMs'],
        'workflow.subworkflow': ['version']
    };

const GENERIC_ADVANCED_FIELD_NAMES = new Set([
        'candidate_limit', 'chunk_tokens', 'overlap_tokens', 'max_tokens', 'max_steps',
        'max_summary_chars', 'concurrency', 'temperature', 'timeout_ms', 'task_id',
        'credential_header', 'credential_prefix', 'callback_base_url', 'callback_credential',
        'im_server_id', 'im_target_type', 'im_target', 'approver_user_ids', 'approval_levels',
        'entity_limit', 'relation_limit', 'sort_by', 'sort_order'
    ]);

function isWizardFieldHidden(name, tool = null) {
        const hidden = TOOL_HIDDEN_FIELD_NAMES[toolShortName(tool)] || [];
        const key = normalizeFieldKey(name);
        return hidden.some(item => normalizeFieldKey(item) === key);
    }

function partitionWizardFields(entries = [], required = new Set(), tool = null) {
        const visible = entries.filter(([name]) => !isWizardFieldHidden(name, tool));
        const preferredNames = TOOL_PRIMARY_FIELD_NAMES[toolShortName(tool)] || [];
        const preferred = new Set(preferredNames.map(normalizeFieldKey));
        const primary = [];
        const advanced = [];
        visible.forEach((entry, index) => {
            const [name, schema] = entry;
            const key = normalizeFieldKey(name);
            const explicitlyPrimary = preferred.has(key);
            const requiredField = required.has(name);
            const genericPrimary = !preferred.size
                && !GENERIC_ADVANCED_FIELD_NAMES.has(key)
                && (requiredField || !Object.prototype.hasOwnProperty.call(schema || {}, 'default') || index < 4);
            (explicitlyPrimary || requiredField || genericPrimary ? primary : advanced).push(entry);
        });
        return { primary, advanced, all: [...primary, ...advanced] };
    }

function friendlySchemaTypeLabel(schema = {}) {
        const rawType = Array.isArray(schema?.type) ? schema.type : [schema?.type || 'value'];
        const map = {
            array: '列表',
            boolean: '开关',
            integer: '整数',
            number: '数字',
            object: '对象',
            string: '文本',
            value: '任意值'
        };
        return rawType.map(type => map[String(type || 'value')] || '任意值').join(' / ');
    }

function genericFieldLabel(name = '') {
        const raw = String(name || '').trim();
        if (!raw) return '参数';
        return `参数：${raw}`;
    }

function genericFieldDescription(name, schema = {}) {
        const type = normalizeSchemaType(schema);
        if (type === 'boolean') return '开启或关闭该选项。';
        if (type === 'integer' || type === 'number') return '填写数字，具体范围以工具要求为准。';
        if (type === 'array') return '填写结构化列表，或插入上游节点输出。';
        if (type === 'object') return '填写结构化对象，用于传递高级配置。';
        if (/id$/i.test(String(name || ''))) return '填写对应对象的标识。';
        return '填写文本内容，可直接输入或插入变量。';
    }

function friendlyFieldLabel(name, schema = {}, tool = null) {
        if (isDatabaseConnectionField(name, tool)) return '数据库连接';
        const toolOverride = readToolFieldOverride(TOOL_FIELD_LABEL_OVERRIDES, name, tool);
        if (toolOverride) return toolOverride;
        const globalOverride = readFieldOverride(FIELD_LABEL_OVERRIDES, name);
        if (globalOverride) return globalOverride;
        const explicitTitle = String(schema?.title || '').trim();
        if (hasChineseText(explicitTitle)) return explicitTitle;
        return genericFieldLabel(name);
    }

function friendlyFieldDescription(name, schema = {}, tool = null) {
        if (isDatabaseConnectionField(name, tool)) return '选择本节点要读取的具体数据库连接。';
        const toolOverride = readToolFieldOverride(TOOL_FIELD_DESCRIPTION_OVERRIDES, name, tool);
        if (toolOverride) return toolOverride;
        const globalOverride = readFieldOverride(FIELD_DESCRIPTION_OVERRIDES, name);
        if (globalOverride) return globalOverride;
        const explicit = String(schema?.description || '').trim();
        if (hasChineseText(explicit)) return explicit;
        return genericFieldDescription(name, schema);
    }

function friendlyFieldPlaceholder(name, schema = {}, required = false, tool = null) {
        if (isDatabaseConnectionField(name, tool)) return '选择数据库连接';
        const toolOverride = readToolFieldOverride(TOOL_FIELD_PLACEHOLDER_OVERRIDES, name, tool);
        const globalOverride = readFieldOverride(FIELD_PLACEHOLDER_OVERRIDES, name);
        const type = normalizeSchemaType(schema);
        const fallback = type === 'array'
            ? '填写结构化列表'
            : type === 'object'
                ? '填写结构化对象'
                : type === 'integer' || type === 'number'
                    ? '填写数字'
                    : '填写文本';
        const placeholder = toolOverride || globalOverride || fallback;
        return `${required ? '必填：' : '可选：'}${placeholder}`;
    }

function friendlyEnumOptionLabel(name, option) {
        const key = `${normalizeFieldKey(name)}:${String(option)}`;
        const map = {
            'aggregation:avg': '平均值',
            'aggregation:count': '计数',
            'aggregation:max': '最大值',
            'aggregation:min': '最小值',
            'aggregation:sum': '求和',
            'chart_type:area': '面积图',
            'chart_type:bar': '柱状图',
            'chart_type:line': '折线图',
            'chart_type:pie': '饼图',
            'match_mode:contains': '包含匹配',
            'match_mode:exact': '精确匹配',
            'mode:lower': '转小写',
            'mode:plain': '保持原样',
            'mode:upper': '转大写',
            'response_format:json': '结构化数据',
            'response_format:markdown': '格式化文本',
            'response_format:text': '纯文本',
            'format:json': '结构化数据',
            'format:markdown': '格式化文本',
            'format:text': '纯文本',
            'action:inspect': '查看页面',
            'action:click': '点击目标',
            'role:researcher': '研究员',
            'role:analyst': '分析师',
            'role:reviewer': '审阅员',
            'role:writer': '写作者',
            'role:custom': '自定义角色',
            'presentation:default': '默认结果',
            'presentation:table': '表格',
            'presentation:file': '文件产物',
            'sort_by:label': '按标签',
            'sort_by:value': '按数值',
            'sort_order:asc': '升序',
            'sort_order:desc': '降序',
            'target_type:group': '群组',
            'target_type:user': '用户'
        };
        return map[key] || String(option);
    }

function schemaExampleValue(schema = {}, key = '') {
        if (Object.prototype.hasOwnProperty.call(schema, 'default')) return schema.default;
        if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
        const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
        if (type === 'integer' || type === 'number') return schema.minimum || 0;
        if (type === 'boolean') return false;
        if (type === 'array') return [];
        if (type === 'object') {
            const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
            return Object.fromEntries(Object.entries(props).slice(0, 6).map(([name, child]) => [name, schemaExampleValue(child, name)]));
        }
        if (/query|keyword|prompt|text|title|name/i.test(key)) return '';
        return '';
    }

function buildToolInputTemplate(tool) {
        const schema = getToolSchema(tool);
        const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
        const required = Array.isArray(schema.required) ? new Set(schema.required) : new Set();
        const entries = Object.entries(props).filter(([name, child]) => required.has(name) || Object.prototype.hasOwnProperty.call(child || {}, 'default'));
        const selected = entries.length ? entries : Object.entries(props).slice(0, 8);
        return Object.fromEntries(selected.map(([name, child]) => [name, schemaExampleValue(child, name)]));
    }
