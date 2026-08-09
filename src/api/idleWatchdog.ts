// 流式空闲看门狗 — 给所有 provider 适配器加一层 chunk 到达监控。
//
// 为什么需要：SDK 的请求超时只覆盖初始 fetch()，不覆盖流式 body。一旦中转代理把连接
// 悄悄掐断（半开连接），裸 `for await` 会无限挂起；唯一中断来源是外部 abortSignal（ESC），
// headless / -p 模式下无人按 ESC 即永久卡死。看门狗在每个 chunk 之间起一个 setTimeout：
// 超过 STREAM_IDLE_TIMEOUT_MS 没收到新事件 → 主动 abort 流式请求 → 非流式重试一次（fallback）。
//
// 关键语义：外部 ESC 与看门狗超时都能 abort SDK 流，但只有看门狗超时路径才触发 fallback。
// 外部 abort 走 SDK 流抛中止错误 → 透传给 query.ts 的 isAbortError 分支，不进 fallback。
// 注意：SDK 抛的是 APIUserAbortError（name='Error'，message='Request was aborted.'），不是原生
// 'AbortError'，故上层统一用 utils/abortError.ts 的 isAbortError 识别，勿只比对 err.name。

import type { Message as SDKMessage } from '@anthropic-ai/sdk/resources/messages'
import type OpenAI from 'openai'
import { config } from '../config'
import type { StreamEvent, StopReason } from '../types/message'

// 某些 OpenAI 兼容 provider（尤其 DeepSeek/Kimi 系模型经第三方中转）在 function-calling
// 语法失配时，会把 tool-call 协议控制 token（半角 `<|xxx|>` ChatML 式，或全角 `<｜xxx｜>`
// DeepSeek/Kimi 式，`▁` 代表 token 内的下划线/空格）当普通文本吐进 delta.content，
// 而不是走结构化的 tool_calls 字段。这类 token 从未出现在正常的 assistant 输出里
// （散文/代码都不会用竖线包裹尖括号），原样透传会把协议噪音当成真实回复渲染给用户。
// 用宽松但保守的正则整段剥离：要求首尾都是竖线紧贴尖括号，中间不允许再出现 <>，
// 避免误伤含 `<` `>` 的正常代码片段。
const LEAKED_PROTOCOL_TOKEN = /<\/?[|｜][^<>\n]{0,80}[|｜]>/g

export function stripLeakedProtocolTokens(text: string): string {
  return text.replace(LEAKED_PROTOCOL_TOKEN, '')
}

/**
 * 把外部 AbortSignal 桥接到两路内部 AbortController：
 *  - signal          传给流式 SDK（.stream(..., { signal })）；
 *  - abort()         看门狗超时调用，仅 abort 流式 signal，触发走 fallback；
 *  - fallbackSignal  传给非流式兜底（messages.create(..., { signal })）。
 *
 * 关键：看门狗的 abort() 绝不能波及 fallbackSignal —— 否则兜底请求一发出就被自己掐死
 * （拿到已 aborted 的 signal 立刻抛 APIUserAbortError），看门狗的救场逻辑形同虚设，
 * 且该 abort 错误会被上层 isAbortError 误判成"用户按了 ESC"，让本轮静默收尾、零输出。
 * 故 fallbackSignal 只跟随【外部 ESC】，与看门狗 abort 解耦。外部 ESC 同时 abort 两路。
 */
export function linkAbort(external?: AbortSignal): {
  signal: AbortSignal
  abort: () => void
  fallbackSignal: AbortSignal
} {
  const controller = new AbortController()
  const fallbackController = new AbortController()
  if (external) {
    if (external.aborted) {
      controller.abort()
      fallbackController.abort()
    } else {
      external.addEventListener(
        'abort',
        () => {
          controller.abort()
          fallbackController.abort()
        },
        { once: true },
      )
    }
  }
  return {
    signal: controller.signal,
    abort: () => controller.abort(), // 只掐流式，不动 fallbackController
    fallbackSignal: fallbackController.signal,
  }
}

interface WatchdogOpts {
  /** 内层真实流式生成器（用 linkAbort 的 signal 建 SDK 流）。 */
  stream: AsyncGenerator<StreamEvent>
  /** 看门狗超时时调用，abort 内层流式请求。 */
  abort: () => void
  /** 看门狗超时后的非流式兜底，产出与正常流式同构的事件序列。只跑一次。 */
  fallback: () => AsyncGenerator<StreamEvent> | Promise<StreamEvent[]>
  /** 空闲阈值（ms）。缺省取 config.streamIdleTimeoutMs。 */
  idleMs?: number
}

/**
 * 包裹一个 StreamEvent 生成器，做逐 chunk 空闲监控。
 * 命中 chunk → 透传并重置计时；命中空闲超时 → abort + 非流式 fallback（一次）。
 */
export async function* withIdleWatchdog(opts: WatchdogOpts): AsyncGenerator<StreamEvent> {
  const idleMs = opts.idleMs ?? config.streamIdleTimeoutMs
  const it = opts.stream[Symbol.asyncIterator]()

  while (true) {
    const IDLE = Symbol('idle')
    let timer: ReturnType<typeof setTimeout> | undefined
    const idle = new Promise<typeof IDLE>((resolve) => {
      timer = setTimeout(() => resolve(IDLE), idleMs)
    })

    const next = it.next()
    let winner: IteratorResult<StreamEvent> | typeof IDLE
    try {
      winner = await Promise.race([next, idle])
    } finally {
      if (timer) clearTimeout(timer)
    }

    if (winner === IDLE) {
      // 连接被悄悄掐断：abort 内层流式请求（被遗弃的 next 会拒绝，吞掉防未处理拒绝），
      // 然后跑一次非流式 fallback 把结果吐出去。fallback 自身报错/再挂起 → 作为普通错误向上抛。
      opts.abort()
      void next.catch(() => {})
      const result = await opts.fallback()
      if (Array.isArray(result)) {
        for (const e of result) yield e
      } else {
        for await (const e of result) yield e
      }
      return
    }

    if (winner.done) return
    yield winner.value
  }
}

// ───────────────────────── 非流式响应 → StreamEvent 映射 ─────────────────────────

/** Anthropic 非流式 Message → StreamEvent[]（与流式同构：text / tool_use / message_stop）。 */
export function mapAnthropicMessageToEvents(msg: SDKMessage): StreamEvent[] {
  const events: StreamEvent[] = []
  for (const block of msg.content) {
    if (block.type === 'text') {
      events.push({ type: 'text', text: block.text })
    } else if (block.type === 'tool_use') {
      // 非流式返回的 input 已是完整对象，不存在「累积中途被截断」→ incomplete: false。
      events.push({
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: (block.input ?? {}) as Record<string, unknown>,
        incomplete: false,
      })
    }
  }
  events.push({
    type: 'message_stop',
    usage: {
      input_tokens: msg.usage.input_tokens,
      output_tokens: msg.usage.output_tokens,
      cache_read_input_tokens: msg.usage.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: msg.usage.cache_creation_input_tokens ?? 0,
    },
    stopReason: msg.stop_reason === 'max_tokens' ? 'max_tokens'
      : msg.stop_reason === 'tool_use' ? 'tool_use'
      : msg.stop_reason === 'end_turn' ? 'end_turn'
      : msg.stop_reason === 'stop_sequence' ? 'stop_sequence'
      : 'other',
  })
  return events
}

/**
 * OpenAI 兼容非流式 ChatCompletion → StreamEvent[]。
 * usage 由各 provider 自行映射后传入（口径差异见 usageAccounting），ollama 无缓存概念省略 cacheRead。
 */
export function mapOpenAICompletionToEvents(
  resp: OpenAI.Chat.ChatCompletion,
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number },
): StreamEvent[] {
  const events: StreamEvent[] = []
  const choice = resp.choices[0]
  const finishReason = choice?.finish_reason ?? null
  const truncated = finishReason === 'length'

  if (choice?.message.content) {
    const text = stripLeakedProtocolTokens(choice.message.content)
    if (text) events.push({ type: 'text', text })
  }
  for (const tc of choice?.message.tool_calls ?? []) {
    if (tc.type !== 'function') continue
    let input: Record<string, unknown> = {}
    let incomplete = false
    try { input = JSON.parse(tc.function.arguments) } catch { incomplete = true }
    events.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input, incomplete: incomplete || truncated })
  }

  const stopReason: StopReason = truncated ? 'max_tokens'
    : finishReason === 'tool_calls' ? 'tool_use'
    : finishReason === 'stop' ? 'end_turn'
    : 'other'

  events.push({
    type: 'message_stop',
    usage: {
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
    },
    stopReason,
  })
  return events
}
