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
