'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { installCertificateOutputGuard, stripKnownRuntimeDiagnostic } = require('../scripts/electron_builder_json_guard');
const { NodeModulesCollector } = require('app-builder-lib/out/node-module-collector/nodeModulesCollector');

test('打包器可解析追加本机原生诊断的 npm 依赖清单', () => {
    const data = { dependencies: { pivot: { version: '1.0.0' } }, description: '含中文' };
    const input = JSON.stringify(data) + '\n[0x7FFD5205CEE0] ANOMALY: use of REX.w is meaningless (default operand size is 64)\r\n';
    const collector = new NodeModulesCollector('.', {});
    assert.deepEqual(collector.extractJsonFromPollutedOutput(input), data);
    assert.deepEqual(collector.extractJsonFromPollutedOutput(JSON.stringify(data)), data);
    assert.equal(stripKnownRuntimeDiagnostic('valid\nother warning\n'), 'valid\nother warning\n');
});

test('证书枚举仅清除已知诊断且保留签名器的选择逻辑', async () => {
    class Manager {
        async getCertificateFromStoreInfo(options, vm) {
            const value = await vm.exec('pwsh', ['-Command', 'Get-ChildItem -Recurse Cert: -CodeSigningCert']);
            return { options, certificates: JSON.parse(value) };
        }
    }
    installCertificateOutputGuard(Manager);
    const vm = { exec: async () => '[{"Thumbprint":"abc"}]\n[0x7FFD5205CEE0] ANOMALY: use of REX.w is meaningless (default operand size is 64)\n' };
    const options = { signtoolOptions: { certificateSha1: 'abc' } };
    assert.deepEqual(await new Manager().getCertificateFromStoreInfo(options, vm), { options, certificates: [{ Thumbprint: 'abc' }] });
});
