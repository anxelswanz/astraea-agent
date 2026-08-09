// ─────────────────────────────────────────────────────────────────────────────
// 录像机（tracing）—— 手工建 span，用 OpenInference 语义约定标注 AGENT / LLM / TOOL。
// 对标 claude-code: src/services/langfuse/tracing.ts
//
// 层级（手工搭出来）：
//   createTrace()            → AGENT 根 span（每个 query() 调用 = 一个用户 turn）
//     ├─ recordLLMObservation()  → LLM span（每次模型调用）
//     ├─ recordToolObservation() → TOOL span（每个工具）
//     └─ createChildSpan()       → 供子 agent / side-query 挂在主 trace 下
//   endTrace()               → 关根 span
//
// 与 claude-code 的差异：claude-code 用 Langfuse 原生 startObservation(asType)，
// 我们用 OTel span + 属性。好处是同一份 span 能同时喂 Phoenix 和 Langfuse。
//
// ── 属性双写对照表（为什么两边都能读同一个 span）─────────────────────────────
//   属性                        Phoenix   Langfuse   说明
//   session.id                   ✓         ✓        Langfuse 的 TRACE_SESSION_ID 常量就是 "session.id"
//   user.id                      ✓         ✓        同上，TRACE_USER_ID == "user.id"
//   input.value / output.value   ✓         ✓        Langfuse 官方声明支持 OpenInference 这两个
//   llm.model_name               ✓         ✓        Langfuse 认 llm.model_name 为 model
//   llm.token_count.*            ✓         ✓        Langfuse 认 llm.token_count.* 为 usage
//   openinference.span.kind      ✓         ✗        ← Langfuse 不读它，所以要补 langfuse.observation.type
//   metadata（单个 JSON 串）      ✓         ~        ← Langfuse 会塞进 metadata.attributes，不可筛选，
//                                                     所以按 key 铺平成 langfuse.*.metadata.<k>
// 结论：只有最后两行需要额外补写，其余天然兼容。补写对 Phoenix 是无害的多余属性。
// ─────────────────────────────────────────────────────────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any */

import { config } from '../../config'
import { getOtel, getTracer, isPhoenixActive } from './client'
import { sanitizeGlobal, sanitizeToolInput, sanitizeToolOutput } from './sanitize'

/** trace 句柄 —— 在 query() 出生，穿过 ToolContext 传到各调用点。 */
export interface PhoenixTrace {
  /** OTel 根 span（不透明）。 */
  span: any
  /**
   * W3C trace id（32 位 hex）。用于把 Langfuse score 回挂到这条 trace
   * （langfuse.score.create({ traceId, … })）。未激活时为空串。
   */
  traceId: string
  sessionId: string
  userId?: string
}

const MIME_JSON = 'application/json'
const MIME_TEXT = 'text/plain'

// Langfuse 的 OTel 属性名（与 @langfuse/core 的 LangfuseOtelSpanAttributes 枚举一致）。
// 不 import 该包：它只是 @langfuse/otel 的传递依赖，硬编码字符串可让 Langfuse 未安装时
// 本文件依然 typecheck / 运行无碍（与 client.ts 的 fail-open 立场一致）。
const LF_OBSERVATION_TYPE = 'langfuse.observation.type'
const LF_OBSERVATION_METADATA = 'langfuse.observation.metadata'
const LF_TRACE_METADATA = 'langfuse.trace.metadata'
const LF_COMPLETION_START_TIME = 'langfuse.observation.completion_start_time'

/** OpenInference span kind → Langfuse observation type。Langfuse v4 这十种类型里正好都有对应。 */
const LF_TYPE_BY_KIND: Record<string, string> = {
  AGENT: 'agent',
  LLM: 'generation',
  TOOL: 'tool',
  CHAIN: 'chain',
}

// provider → 友好的 LLM span 名（对标 claude-code 的 PROVIDER_GENERATION_NAMES）
const PROVIDER_SPAN_NAMES: Record<string, string> = {
  anthropic: 'ChatAnthropic',
  openai: 'ChatOpenAI',
  deepseek: 'ChatDeepSeek',
  kimi: 'ChatKimi',
  ollama: 'ChatOllama',
  custom: 'ChatCustom',
  codex: 'ChatCodex',
}

function activeModel(): string {
  switch (config.provider) {
    case 'deepseek':
      return config.deepseek.model
    case 'kimi':
      return config.kimi.model
    case 'ollama':
      return config.ollama.model
    case 'openai':
      return config.openai.model
    case 'codex':
      return config.codex.model
    case 'custom':
      return config.custom.model
    default:
      return config.anthropic.model
  }
}

function resolveUserId(): string | undefined {
  return process.env.PHOENIX_USER_ID ?? process.env.USER ?? undefined
}

/** 把任意值转成 {值, MIME}，字符串走 text、其余走 JSON。已脱敏。 */
function asAttrValue(v: unknown): { value: string; mime: string } {
  const safe = sanitizeGlobal(v)
  if (typeof safe === 'string') return { value: safe, mime: MIME_TEXT }
  try {
    return { value: JSON.stringify(safe), mime: MIME_JSON }
  } catch {
    return { value: String(safe), mime: MIME_TEXT }
  }
}

/** 在 parent 之下开一个 OTel span（显式传父上下文，不依赖 async-context 自动传播）。 */
function startChild(parent: any, name: string, startTime?: Date): any {
  const otel = getOtel()
  const tracer = getTracer()
  const parentCtx = otel.trace.setSpan(otel.context.active(), parent)
  return tracer.startSpan(name, startTime ? { startTime } : {}, parentCtx)
}

/** 双写 span 类型：OpenInference 给 Phoenix，langfuse.observation.type 给 Langfuse。 */
function setKind(span: any, kind: string): void {
  const { SemanticConventions } = getOtel()
  span.setAttribute(SemanticConventions.OPENINFERENCE_SPAN_KIND, kind)
  span.setAttribute(LF_OBSERVATION_TYPE, LF_TYPE_BY_KIND[kind] ?? 'span')
}

/**
 * 双写 metadata。
 * Phoenix 吃单个 JSON 串；Langfuse 要 langfuse.{trace,observation}.metadata.<key>
 * 逐 key 铺平才能在面板里当筛选维度用（塞 JSON 串的话只会落进不可筛选的 metadata.attributes）。
 * scope='trace' 仅用于根 span —— Langfuse 的 trace 级 metadata 只从根 span 上取。
 */
function setMetadata(span: any, meta: Record<string, unknown>, scope: 'trace' | 'observation'): void {
  const { SemanticConventions } = getOtel()
  span.setAttribute(SemanticConventions.METADATA, JSON.stringify(meta))

  const prefix = scope === 'trace' ? LF_TRACE_METADATA : LF_OBSERVATION_METADATA
  for (const [k, v] of Object.entries(meta)) {
    if (v === undefined || v === null) continue
    // setAttribute 只接受 string|number|boolean|数组，对象得先序列化。
    span.setAttribute(`${prefix}.${k}`, typeof v === 'object' ? JSON.stringify(v) : (v as any))
  }
}

function setSessionUser(span: any, t: PhoenixTrace): void {
  const { SemanticConventions } = getOtel()
  if (t.sessionId) span.setAttribute(SemanticConventions.SESSION_ID, t.sessionId)
  if (t.userId) span.setAttribute(SemanticConventions.USER_ID, t.userId)
}

// ── 根 trace（一个用户 turn）──────────────────────────────────────────────────

export function createTrace(params: {
  sessionId: string
  input?: unknown
  name?: string
  metadata?: Record<string, unknown>
}): PhoenixTrace | null {
  if (!isPhoenixActive()) return null
  try {
    const otel = getOtel()
    const { SemanticConventions, OpenInferenceSpanKind } = otel
    const tracer = getTracer()
    const span = tracer.startSpan(params.name ?? 'agent-run')
    setKind(span, OpenInferenceSpanKind.AGENT)
    if (params.input !== undefined) {
      const { value, mime } = asAttrValue(params.input)
      span.setAttribute(SemanticConventions.INPUT_VALUE, value)
      span.setAttribute(SemanticConventions.INPUT_MIME_TYPE, mime)
    }
    const userId = resolveUserId()
    const t: PhoenixTrace = {
      span,
      traceId: span.spanContext?.()?.traceId ?? '',
      sessionId: params.sessionId,
      userId,
    }
    setSessionUser(span, t)
    setMetadata(
      span,
      { provider: config.provider, model: activeModel(), agentType: 'main', ...params.metadata },
      'trace',
    )
    return t
  } catch (e) {
    warn('createTrace', e)
    return null
  }
}

// ── LLM span（每次模型调用）────────────────────────────────────────────────────

export function recordLLMObservation(
  trace: PhoenixTrace | null,
  params: {
    input: unknown
    output: unknown
    usage: { input_tokens: number; output_tokens: number }
    model?: string
    startTime?: Date
    endTime?: Date
    /** 首 token 时刻，用于 TTFT。 */
    completionStartTime?: Date
  },
): void {
  if (!trace || !isPhoenixActive()) return
  try {
    const { SemanticConventions, OpenInferenceSpanKind } = getOtel()
    const name = PROVIDER_SPAN_NAMES[config.provider] ?? `Chat_${config.provider}`
    const span = startChild(trace.span, name, params.startTime)
    setKind(span, OpenInferenceSpanKind.LLM)
    setSessionUser(span, trace)

    const model = params.model ?? activeModel()
    span.setAttribute(SemanticConventions.LLM_MODEL_NAME, model)

    const inp = asAttrValue(params.input)
    span.setAttribute(SemanticConventions.INPUT_VALUE, inp.value)
    span.setAttribute(SemanticConventions.INPUT_MIME_TYPE, inp.mime)
    const out = asAttrValue(params.output)
    span.setAttribute(SemanticConventions.OUTPUT_VALUE, out.value)
    span.setAttribute(SemanticConventions.OUTPUT_MIME_TYPE, out.mime)

    const inTok = params.usage.input_tokens ?? 0
    const outTok = params.usage.output_tokens ?? 0
    span.setAttribute(SemanticConventions.LLM_TOKEN_COUNT_PROMPT, inTok)
    span.setAttribute(SemanticConventions.LLM_TOKEN_COUNT_COMPLETION, outTok)
    span.setAttribute(SemanticConventions.LLM_TOKEN_COUNT_TOTAL, inTok + outTok)

    setMetadata(
      span,
      {
        provider: config.provider,
        ...(params.completionStartTime &&
          params.startTime && { ttft_ms: params.completionStartTime.getTime() - params.startTime.getTime() }),
      },
      'observation',
    )
    // Langfuse 用它算 TTFT（Phoenix 那边靠上面 metadata 里的 ttft_ms）。ISO 串是它要的格式。
    if (params.completionStartTime) {
      span.setAttribute(LF_COMPLETION_START_TIME, params.completionStartTime.toISOString())
    }
    span.end(params.endTime)
  } catch (e) {
    warn('recordLLMObservation', e)
  }
}

// ── TOOL span（每个工具调用）──────────────────────────────────────────────────

export function recordToolObservation(
  trace: PhoenixTrace | null,
  params: {
    toolName: string
    toolUseId: string
    input: unknown
    output: string
    isError?: boolean
    startTime?: Date
  },
): void {
  if (!trace || !isPhoenixActive()) return
  try {
    const { SemanticConventions, OpenInferenceSpanKind, SpanStatusCode } = getOtel()
    const span = startChild(trace.span, params.toolName, params.startTime)
    setKind(span, OpenInferenceSpanKind.TOOL)
    setSessionUser(span, trace)

    span.setAttribute(SemanticConventions.TOOL_NAME, params.toolName)
    const inp = asAttrValue(sanitizeToolInput(params.toolName, params.input))
    span.setAttribute(SemanticConventions.INPUT_VALUE, inp.value)
    span.setAttribute(SemanticConventions.INPUT_MIME_TYPE, inp.mime)
    span.setAttribute(SemanticConventions.OUTPUT_VALUE, sanitizeToolOutput(params.toolName, params.output))
    span.setAttribute(SemanticConventions.OUTPUT_MIME_TYPE, MIME_TEXT)
    setMetadata(span, { toolUseId: params.toolUseId, isError: !!params.isError }, 'observation')

    if (params.isError) span.setStatus({ code: SpanStatusCode.ERROR })
    span.end()
  } catch (e) {
    warn('recordToolObservation', e)
  }
}

// ── 子 span（供子 agent / side-query 挂在主 trace 下）───────────────────────────

export function createChildSpan(
  parent: PhoenixTrace | null,
  params: { name: string; input?: unknown; kind?: 'AGENT' | 'CHAIN' },
): PhoenixTrace | null {
  if (!parent || !isPhoenixActive()) return null
  try {
    const { SemanticConventions, OpenInferenceSpanKind } = getOtel()
    const span = startChild(parent.span, params.name)
    setKind(span, params.kind === 'AGENT' ? OpenInferenceSpanKind.AGENT : OpenInferenceSpanKind.CHAIN)
    if (params.input !== undefined) {
      const { value, mime } = asAttrValue(params.input)
      span.setAttribute(SemanticConventions.INPUT_VALUE, value)
      span.setAttribute(SemanticConventions.INPUT_MIME_TYPE, mime)
    }
    // 子 span 与父同属一条 trace，traceId 不变（score 回挂时用的是同一个）。
    const child: PhoenixTrace = { span, traceId: parent.traceId, sessionId: parent.sessionId, userId: parent.userId }
    setSessionUser(span, child)
    return child
  } catch (e) {
    warn('createChildSpan', e)
    return null
  }
}

// ── 关 trace ──────────────────────────────────────────────────────────────────

export function endTrace(trace: PhoenixTrace | null, output?: unknown, status?: 'error' | 'interrupted'): void {
  if (!trace) return
  try {
    const { SemanticConventions, SpanStatusCode } = getOtel()
    if (output !== undefined) {
      const { value, mime } = asAttrValue(output)
      trace.span.setAttribute(SemanticConventions.OUTPUT_VALUE, value)
      trace.span.setAttribute(SemanticConventions.OUTPUT_MIME_TYPE, mime)
    }
    if (status === 'error') trace.span.setStatus({ code: SpanStatusCode.ERROR })
    else if (status === 'interrupted') trace.span.setAttribute('astraea.status', 'interrupted')
    trace.span.end()
  } catch (e) {
    warn('endTrace', e)
  }
}

function warn(where: string, e: unknown): void {
  if (process.env.PHOENIX_DEBUG === '1') console.error(`[phoenix] ${where} failed:`, (e as Error)?.message ?? e)
}
