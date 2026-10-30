'use strict';

// 少数 Windows 运行环境会把原生诊断写到 npm 的 stdout，导致 electron-builder
// 对大型依赖树进入逐字符 JSON 回退。仅移除已知的尾部诊断，不修改依赖数据。
const RUNTIME_DIAGNOSTIC = /(?:\r?\n\[0x[0-9a-f]+\] ANOMALY: use of REX\.w is meaningless \(default operand size is 64\))+(?:\r?\n)?\s*$/i;

function stripKnownRuntimeDiagnostic(output) {
    return String(output).replace(RUNTIME_DIAGNOSTIC, '\n');
}

function installCollectorGuard(Collector) {
    const original = Collector.prototype.extractJsonFromPollutedOutput;
    Collector.prototype.extractJsonFromPollutedOutput = function extractGuarded(output) {
        return original.call(this, stripKnownRuntimeDiagnostic(output));
    };
}

if (require.main !== module) {
    const { NodeModulesCollector } = require('app-builder-lib/out/node-module-collector/nodeModulesCollector');
    installCollectorGuard(NodeModulesCollector);
}

module.exports = { installCollectorGuard, stripKnownRuntimeDiagnostic };
