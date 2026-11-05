import mermaid from 'mermaid';

// 仅向固定的隔离渲染页提供运行时，主聊天页不加载图形解析依赖。
globalThis.Pivot ||= {};
globalThis.Pivot.vendor ||= {};
globalThis.Pivot.vendor.mermaid = mermaid;
