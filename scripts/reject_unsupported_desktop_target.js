const target = String(process.argv[2] || 'unknown');

console.error([
    `暂不支持构建 ${target} 正式客户端。`,
    '当前 Electron Builder、Electron 官方运行时、DuckDB、Sharp 与 Playwright Chromium 均未提供完整 LoongArch64 发布链。',
    '请使用 Web/PWA，或先完成龙芯专用 Electron 与全部原生依赖适配后再启用该目标。'
].join('\n'));
process.exit(1);
