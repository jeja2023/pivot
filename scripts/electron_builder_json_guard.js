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

function installCertificateOutputGuard(Manager) {
    const original = Manager.prototype.getCertificateFromStoreInfo;
    Manager.prototype.getCertificateFromStoreInfo = function getGuardedCertificate(options, vm) {
        // 只处理 electron-builder 的证书枚举输出，保留原有证书选择和签名校验。
        const wrapped = Object.create(vm);
        wrapped.exec = async (...args) => {
            const result = await vm.exec(...args);
            const commandArgs = args[1];
            return Array.isArray(commandArgs) && commandArgs.some(arg => typeof arg === 'string' && arg.includes('Get-ChildItem -Recurse Cert: -CodeSigningCert'))
                ? stripKnownRuntimeDiagnostic(result) : result;
        };
        return original.call(this, options, wrapped);
    };
}

if (require.main !== module) {
    const { NodeModulesCollector } = require('app-builder-lib/out/node-module-collector/nodeModulesCollector');
    const { WindowsSignToolManager } = require('app-builder-lib/out/codeSign/windowsSignToolManager');
    installCollectorGuard(NodeModulesCollector);
    installCertificateOutputGuard(WindowsSignToolManager);
}

module.exports = { installCertificateOutputGuard, installCollectorGuard, stripKnownRuntimeDiagnostic };
