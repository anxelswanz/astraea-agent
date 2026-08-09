// Kimi（Moonshot AI）流式适配器 — Moonshot API 与 OpenAI 完全兼容。
// 使用 OpenAI SDK 指向 https://api.moonshot.cn/v1（海外用 api.moonshot.ai/v1）。
// 模型: kimi-k2-0905-preview（旗舰 agentic·256K）, kimi-k2-turbo-preview, kimi-latest, moonshot-v1-*。
//
// 与 deepseek.ts 的差异：Kimi 没有 deepseek-reasoner 那样的「换模型开推理」机制，
// 标准模型走纯 chat completions，故 /reason 对它是 no-op（不注入指令、不换模型）。
// usage 走 OpenAI 兼容口径（prompt_tokens_details.cached_tokens / 顶层 cached_tokens）。

import OpenAI from 'openai'
import { config } from '../config'
import type { Message, StreamEvent } from '../types/message'
import type { StreamOptions } from './anthropic'
import type { ToolSchema } from '../tools/Tool'
import { mapKimiUsage } from './usageAccounting'
import { withIdleWatchdog, linkAbort, mapOpenAICompletionToEvents, stripLeakedProtocolTokens } from './idleWatchdog'

function createClient(): OpenAI {
  return new OpenAI({
    apiKey: config.kimi.apiKey,
    baseURL: config.kimi.baseUrl,
  })
}

export function streamMessageKimi(
  messages: Message[],
  options: StreamOptions = {},
): AsyncGenerator<StreamEvent> {
  const client = createClient()

  const model = options.model ?? config.kimi.model

  const chatMessages: OpenAI.Chat.ChatCompletionMessageParam[] = []

  if (options.system) {
    chatMessages.push({ role: 'system', content: options.system })
  }

  for (const msg of messages) {
    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        chatMessages.push({ role: 'user', content: msg.content })
      } else {
        for (const block of msg.content) {
          if (block.type === 'tool_result') {
            const content = typeof block.content === 'string'
              ? block.content
              : block.content.map((b) => b.text).join('')
            chatMessages.push({ role: 'tool', tool_call_id: block.tool_use_id, content })
          } else {
            chatMessages.push({ role: 'user', content: block.text })
          }
        }
      }
    } else {
      const textParts = msg.content.filter((b) => b.type === 'text')
      const toolUses = msg.content.filter((b) => b.type === 'tool_use')
      const toolCalls: OpenAI.Chat.ChatCompletionMessageToolCall[] = toolUses.map((b) => ({
        id: b.id,
        type: 'function' as const,
        function: { name: b.name, arguments: JSON.stringify(b.input) },
      }))
      const assistantText = textParts.map((b) => b.text).join('') || null
      // 至少要有 content 或 tool_calls，否则 provider 报 400（"content or tool_calls must be set"）。
      if (assistantText !== null || toolCalls.length > 0) {
        chatMessages.push({
          role: 'assistant',
          content: assistantText,
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        })
      }
    }
  }

  const openaiTools: OpenAI.Chat.ChatCompletionTool[] | undefined =
    options.tools?.map((t: ToolSchema) => ({
      type: 'function' as const,
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    }))

  // 流式与非流式 fallback 共用同一份基础参数。
  const baseParams = {
    model,
    max_tokens: options.maxTokens ?? config.kimi.maxTokens,
    messages: chatMessages,
    ...(openaiTools?.length ? { tools: openaiTools, tool_choice: 'auto' as const } : {}),
  }

  const linked = linkAbort(options.abortSignal)
  return withIdleWatchdog({
    stream: streamRawKimi(client, baseParams, linked.signal),
    abort: linked.abort,
    fallback: () => fallbackKimi(client, baseParams, linked.fallbackSignal),
  })
}

// 看门狗超时后的非流式兜底：同参数走 stream:false，整条响应映射成等价事件。
async function* fallbackKimi(
  client: OpenAI,
  baseParams: Record<string, unknown>,
  signal: AbortSignal,
): AsyncGenerator<StreamEvent> {
  const resp = await client.chat.completions.create(
    { ...baseParams, stream: false } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
    { signal },
  )
  const m = resp.usage ? mapKimiUsage(resp.usage) : { input: 0, output: 0, cacheRead: 0 }
  for (const e of mapOpenAICompletionToEvents(resp, {
    input_tokens: m.input,
    output_tokens: m.output,
    cache_read_input_tokens: m.cacheRead,
  })) yield e
}

// 内层真实流式：用 linkAbort 的 signal 建 SDK 流并 yield 精简事件。
async function* streamRawKimi(
  client: OpenAI,
  baseParams: Record<string, unknown>,
  signal: AbortSignal,
): AsyncGenerator<StreamEvent> {
  const stream = await client.chat.completions.create(
    { ...baseParams, stream: true, stream_options: { include_usage: true } } as OpenAI.Chat.ChatCompletionCreateParamsStreaming,
    { signal },
  )

  const toolCallBuffers = new Map<number, { id: string; name: string; args: string }>()
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0   // prompt_tokens 含命中缓存，需拆出按缓存价计（见 usageAccounting）
  let truncated = false   // finish_reason === 'length' → 撞输出上限被截断
  let finishReason: string | null = null

  for await (const chunk of stream) {
    const choice = chunk.choices[0]

    if (chunk.usage) {
      const m = mapKimiUsage(chunk.usage)
      inputTokens = m.input
      outputTokens = m.output
      cacheReadTokens = m.cacheRead
    }

    if (!choice) continue
    const delta = choice.delta

    // 推理档的 CoT 走独立 reasoning_content：思考阶段只有它在流。发心跳防看门狗误判空闲。
    const reasoning = (delta as { reasoning_content?: string }).reasoning_content
    if (reasoning) {
      yield { type: 'thinking', text: reasoning }
    }

    if (delta.content) {
      const text = stripLeakedProtocolTokens(delta.content)
      if (text) yield { type: 'text', text }
    }

    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        if (!toolCallBuffers.has(tc.index)) {
          toolCallBuffers.set(tc.index, { id: tc.id ?? '', name: tc.function?.name ?? '', args: '' })
        }
        const buf = toolCallBuffers.get(tc.index)!
        if (tc.id) buf.id = tc.id
        if (tc.function?.name) buf.name = tc.function.name
        if (tc.function?.arguments) buf.args += tc.function.arguments
      }
    }

    if (choice.finish_reason && !finishReason) {
      finishReason = choice.finish_reason
      truncated = finishReason === 'length'
      for (const [, buf] of toolCallBuffers) {
        let input: Record<string, unknown> = {}
        let incomplete = false
        try { input = JSON.parse(buf.args) } catch { incomplete = true }
        yield { type: 'tool_use', id: buf.id, name: buf.name, input, incomplete: incomplete || truncated }
      }
      toolCallBuffers.clear()
      // 不 return：usage 在 finish_reason 之后的「空 choices」chunk 里
    }
  }

  yield {
    type: 'message_stop',
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_read_input_tokens: cacheReadTokens,
    },
    stopReason: truncated ? 'max_tokens'
      : finishReason === 'tool_calls' ? 'tool_use'
      : finishReason === 'stop' ? 'end_turn'
      : 'other',
  }
}
