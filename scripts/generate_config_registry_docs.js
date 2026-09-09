'use strict';

const { assertRegistryArtifacts, writeRegistryArtifacts } = require('../server/config/env-registry');

if (process.argv.includes('--check')) {
    assertRegistryArtifacts();
    console.log('类型化配置注册表文档与环境模板检查通过。');
} else {
    writeRegistryArtifacts();
    console.log('类型化配置注册表已生成 .env.example 片段和文档。');
}
