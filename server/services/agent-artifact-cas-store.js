'use strict';

// 保留 Agent CAS 合同，字节写入与受控路径由共享实现提供。
const path = require('node:path');
const { createContentStore } = require('./content-addressed-files');
module.exports = createContentStore({
    rootResolver: () => process.env.PIVOT_ARTIFACT_CAS_DIR || path.join(process.env.DATA_DIR || path.join(__dirname, '../../data'), 'agent-artifact-objects'),
    namespaceLabel: '租户', errorPrefix: 'ARTIFACT_CAS'
});
