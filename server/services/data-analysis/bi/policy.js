'use strict';

const BI_POLICY = Object.freeze({
    schemaVersion: 1,
    semanticVersion: 'bi-semantic-v1',
    compilerVersion: 'bi-compiler-v1',
    numericPolicyVersion: 'bi-decimal-v1',
    normalizationVersion: 'bi-canonical-v1',
    defaultTimezone: 'Asia/Shanghai',
    maxRelations: 8,
    maxKeyPairs: 3,
    maxDimensions: 5,
    maxMetrics: 10,
    maxDerivedDepth: 3,
    maxExpressionNodes: 100,
    maxFilters: 20,
    maxSetValues: 1000,
    maxParameters: 2000,
    maxRequestBytes: 1024 * 1024,
    maxDecimalPrecision: 38
});

module.exports = { BI_POLICY };
