// 可观测性桥接（路线 B：手工 span + 句柄穿线 + 脱敏）—— 统一出口。
// 对标 claude-code: src/services/langfuse/index.ts
//
// 后端：Phoenix（PHOENIX_ENABLED=1）与 Langfuse（LANGFUSE_PUBLIC_KEY+SECRET_KEY）
// 可单开可双开 —— 同一份 OpenInference span 扇出到两边，详见 tracing.ts 的属性对照表。
// 目录名仍叫 phoenix/ 是历史包袱（当时只有一个后端），实际是 backend-agnostic 的。
//
// 用法见 query.ts 接线点 + /Bridge/可观测性桥接-通俗讲解.md
export {
  initPhoenix,
  shutdownPhoenix,
  isPhoenixEnabled,
  isPhoenixActive,
  isLangfuseEnabled,
  getActiveBackends,
} from './client'
export { createTrace, recordLLMObservation, recordToolObservation, createChildSpan, endTrace } from './tracing'
export type { PhoenixTrace } from './tracing'
export { sanitizeToolInput, sanitizeToolOutput, sanitizeGlobal } from './sanitize'
