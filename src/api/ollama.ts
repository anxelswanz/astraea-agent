// Ollama 流式适配器 — 使用 OpenAI 兼容接口（localhost:11434/v1）
// Ollama 的 /v1/chat/completions 与 OpenAI API 完全兼容
// tool_calls 格式与 Anthropic 不同，需要在此层规范化为 StreamEvent

import OpenAI from 'openai'
import { config } from '../config'
import type { Message, StreamEvent } from '../types/message'
import type { StreamOptions } from './anthropic'
import type { ToolSchema } from '../tools/Tool'
import { withIdleWatchdog, linkAbort, mapOpenAICompletionToEvents, stripLeakedProtocolTokens } from './idleWatchdog'

let _ollamaClient: OpenAI | null = null

function getOllamaClient(): OpenAI {
  if (!_ollamaClient) {
    _ollamaClient = new OpenAI({
      baseURL: config.ollama.baseUrl,
      apiKey: 'ollama', // Ollama 不校验 API key，但 SDK 要求非空
    })
  }
  return _ollamaClient
}

export function streamMessageOllama(
  messages: Message[],
  options: StreamOptions = {},
): AsyncGenerator<StreamEvent> {
  const client = getOllamaClient()

  // 把我们的 Message 转成 OpenAI ChatCompletionMessageParam 格式
  const chatMessages: OpenAI.Chat.ChatCompletionMessageParam[] = []

  if (options.system) {
    chatMessages.push({ role: 'system', content: options.system })
  }

  for (const msg of messages) {
    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        chatMessages.push({ role: 'user', content: msg.content })
      } else {
        // 把 tool_result block 转成 OpenAI tool message
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
      // assistant — 把 tool_use block 转成 OpenAI tool_calls
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

  // 把 ToolSchema（Anthropic 格式）转成 OpenAI function tool 格式
  const openaiTools: OpenAI.Chat.ChatCompletionTool[] | undefined =
    options.tools?.map((t: ToolSchema) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }))

  // 调试：打印实际发送给 API 的消息结构
  console.error('\n[DEBUG ollama] messages:')
  for (const m of chatMessages) {
    const mc = m as any
    const preview = typeof mc.content === 'string'
      ? mc.content.slice(0, 80).replace(/\n/g, '\\n')
      : `[${(mc.content as any[])?.length ?? 0} blocks]`
    console.error(`  ${mc.role}: ${preview}${mc.tool_calls ? ` + ${mc.tool_calls.length} tool_calls` : ''}`)
  }
  if (openaiTools?.length) {
    console.error(`[DEBUG ollama] tools: ${openaiTools.map(t => (t as any).function.name).join(', ')}`)
  }

  // 流式与非流式 fallback 共用同一份基础参数。
  const baseParams = {
    model: options.model ?? config.ollama.model,
    max_tokens: options.maxTokens ?? config.ollama.maxTokens,
    messages: chatMessages,
    ...(openaiTools?.length ? { tools: openaiTools, tool_choice: 'auto' as const } : {}),
  }

  const linked = linkAbort(options.abortSignal)
  return withIdleWatchdog({
    stream: streamRawOllama(client, baseParams, linked.signal),
    abort: linked.abort,
    fallback: () => fallbackOllama(client, baseParams, linked.fallbackSignal),
  })
}

// 看门狗超时后的非流式兜底：同参数走 stream:false，整条响应映射成等价事件。
// Ollama 无缓存概念，usage 直接取 prompt_tokens / completion_tokens。
async function* fallbackOllama(
  client: OpenAI,
  baseParams: Record<string, unknown>,
  signal: AbortSignal,
): AsyncGenerator<StreamEvent> {
  const resp = await client.chat.completions.create(
    { ...baseParams, stream: false } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
    { signal },
  )
  for (const e of mapOpenAICompletionToEvents(resp, {
    input_tokens: resp.usage?.prompt_tokens ?? 0,
    output_tokens: resp.usage?.completion_tokens ?? 0,
  })) yield e
}

// 内层真实流式：用 linkAbort 的 signal 建 SDK 流并 yield 精简事件。
async function* streamRawOllama(
  client: OpenAI,
  baseParams: Record<string, unknown>,
  signal: AbortSignal,
): AsyncGenerator<StreamEvent> {
  // stream_options.include_usage 并非所有 Ollama 版本都支持，省略以保持兼容
  const stream = await client.chat.completions.create(
    { ...baseParams, stream: true } as OpenAI.Chat.ChatCompletionCreateParamsStreaming,
    { signal },
  )

  // 收集 tool_calls 的 arguments 分片（与 Anthropic 的 input_json_delta 类似）
  const toolCallBuffers = new Map<number, { id: string; name: string; args: string }>()

  let inputTokens = 0
  let outputTokens = 0
  let truncated = false
  let finishReason: string | null = null

  for await (const chunk of stream) {
    const choice = chunk.choices[0]

    // usage 在最后一个 chunk 上（stream_options.include_usage = true）
    if (chunk.usage) {
      inputTokens = chunk.usage.prompt_tokens
      outputTokens = chunk.usage.completion_tokens
    }

    if (!choice) continue

    const delta = choice.delta

    // 普通文本
    if (delta.content) {
      const text = stripLeakedProtocolTokens(delta.content)
      if (text) yield { type: 'text', text }
    }

    // 工具调用分片：OpenAI 把 arguments 也做了流式分片
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

    // finish_reason 出现即本轮结束（'length' = 撞输出上限被截断）
    if (choice.finish_reason && !finishReason) {
      finishReason = choice.finish_reason
      truncated = finishReason === 'length'
      // emit 所有积累的 tool_calls
      for (const [, buf] of toolCallBuffers) {
        let input: Record<string, unknown> = {}
        let incomplete = false
        try { input = JSON.parse(buf.args) } catch { incomplete = true }
        yield { type: 'tool_use', id: buf.id, name: buf.name, input, incomplete: incomplete || truncated }
      }
      toolCallBuffers.clear()
      // 不 return：部分 Ollama 版本会在其后补 usage chunk，读完再 emit message_stop
    }
  }

  yield {
    type: 'message_stop',
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    stopReason: truncated ? 'max_tokens'
      : finishReason === 'tool_calls' ? 'tool_use'
      : finishReason === 'stop' ? 'end_turn'
      : 'other',
  }
}
