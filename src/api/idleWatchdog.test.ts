import { test, expect } from 'bun:test'
import { withIdleWatchdog, linkAbort, mapAnthropicMessageToEvents, mapOpenAICompletionToEvents, stripLeakedProtocolTokens } from './idleWatchdog'
import type { StreamEvent } from '../types/message'
import type { Message as SDKMessage } from '@anthropic-ai/sdk/resources/messages'
import type OpenAI from 'openai'

// 把若干事件做成一个「正常」流式生成器。
async function* normalStream(events: StreamEvent[]): AsyncGenerator<StreamEvent> {
  for (const e of events) yield e
}

// 模拟「连接被悄悄掐断」：吐完 before 后永远挂起，直到 signal abort 才抛 AbortError。
function stalledStream(before: StreamEvent[], signal: AbortSignal) {
  return (async function* (): AsyncGenerator<StreamEvent> {
    for (const e of before) yield e
    await new Promise<void>((_resolve, reject) => {
      if (signal.aborted) return reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })
    })
  })()
}

async function collect(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = []
  for await (const e of gen) out.push(e)
  return out
}

test('正常流：事件原样透传，abort/fallback 不被调用', async () => {
  const events: StreamEvent[] = [
    { type: 'text', text: 'hello' },
    { type: 'message_stop', usage: { input_tokens: 1, output_tokens: 1 }, stopReason: 'end_turn' },
  ]
  let aborted = false
  let fellBack = false
  const out = await collect(withIdleWatchdog({
    stream: normalStream(events),
    abort: () => { aborted = true },
    fallback: async () => { fellBack = true; return [] },
    idleMs: 1000,
  }))
  expect(out).toEqual(events)
  expect(aborted).toBe(false)
  expect(fellBack).toBe(false)
})

test('卡死流：超时后 abort 一次并吐出 fallback 事件', async () => {
  const linked = linkAbort()
  let abortCalls = 0
  const fallbackEvents: StreamEvent[] = [
    { type: 'text', text: 'from-fallback' },
    { type: 'message_stop', usage: { input_tokens: 2, output_tokens: 3 }, stopReason: 'end_turn' },
  ]
  const out = await collect(withIdleWatchdog({
    stream: stalledStream([{ type: 'text', text: 'partial' }], linked.signal),
    abort: () => { abortCalls++; linked.abort() },
    fallback: async () => fallbackEvents,
    idleMs: 30,
  }))
  // 卡死前的 partial 已透传，随后是 fallback 的完整事件序列
  expect(out).toEqual([{ type: 'text', text: 'partial' }, ...fallbackEvents])
  expect(abortCalls).toBe(1)
})

test('首个 chunk 就卡死：直接走 fallback', async () => {
  const linked = linkAbort()
  const fallbackEvents: StreamEvent[] = [{ type: 'text', text: 'recovered' }]
  const out = await collect(withIdleWatchdog({
    stream: stalledStream([], linked.signal),
    abort: () => linked.abort(),
    fallback: async () => fallbackEvents,
    idleMs: 30,
  }))
  expect(out).toEqual(fallbackEvents)
})

test('外部 abort：透出 AbortError，fallback 不被调用', async () => {
  const external = new AbortController()
  const linked = linkAbort(external.signal)
  let fellBack = false
  const gen = withIdleWatchdog({
    stream: stalledStream([{ type: 'text', text: 'x' }], linked.signal),
    abort: () => linked.abort(),
    fallback: async () => { fellBack = true; return [] },
    idleMs: 10_000, // 远大于外部 abort 触发时机，确保不是看门狗先动手
  })
  // 拿到第一个事件后外部中止
  const it = gen[Symbol.asyncIterator]()
  const first = await it.next()
  expect(first.value).toEqual({ type: 'text', text: 'x' })
  external.abort()
  await expect(it.next()).rejects.toThrow(/abort/i)
  expect(fellBack).toBe(false)
})

test('fallback 自身抛错：错误向上传播，不二次兜底', async () => {
  const linked = linkAbort()
  const gen = withIdleWatchdog({
    stream: stalledStream([], linked.signal),
    abort: () => linked.abort(),
    fallback: async () => { throw new Error('fallback boom') },
    idleMs: 30,
  })
  await expect(collect(gen)).rejects.toThrow('fallback boom')
})

test('linkAbort：外部已 aborted 时内部 signal 立即 aborted', () => {
  const external = new AbortController()
  external.abort()
  const linked = linkAbort(external.signal)
  expect(linked.signal.aborted).toBe(true)
})

test('linkAbort：看门狗 abort() 只掐流式 signal，不波及 fallbackSignal', () => {
  const linked = linkAbort()
  linked.abort()
  expect(linked.signal.aborted).toBe(true)        // 流式被掐
  expect(linked.fallbackSignal.aborted).toBe(false) // 兜底仍可发请求 —— 这是修复的核心
})

test('linkAbort：外部 ESC 同时 abort 流式 signal 与 fallbackSignal', () => {
  const external = new AbortController()
  const linked = linkAbort(external.signal)
  expect(linked.fallbackSignal.aborted).toBe(false)
  external.abort()
  expect(linked.signal.aborted).toBe(true)
  expect(linked.fallbackSignal.aborted).toBe(true)
})

test('linkAbort：外部已 aborted 时 fallbackSignal 也立即 aborted', () => {
  const external = new AbortController()
  external.abort()
  const linked = linkAbort(external.signal)
  expect(linked.fallbackSignal.aborted).toBe(true)
})

// 回归：复刻"看门狗触发后兜底被自己掐死"的原始 bug。fallback 必须收到一个未被
// 看门狗 abort 的 signal，否则 messages.create 一发出就抛 APIUserAbortError → 静默退出。
test('看门狗触发：fallback 收到未 aborted 的 signal，能正常产出', async () => {
  const linked = linkAbort()
  const fallbackEvents: StreamEvent[] = [
    { type: 'text', text: 'rescued' },
    { type: 'message_stop', usage: { input_tokens: 1, output_tokens: 1 }, stopReason: 'end_turn' },
  ]
  const out = await collect(withIdleWatchdog({
    stream: stalledStream([], linked.signal),
    abort: () => linked.abort(),
    // 模拟真实 fallback：signal 已 aborted 就抛（等同 SDK 行为）；正确接线下不应触发。
    fallback: async () => {
      if (linked.fallbackSignal.aborted) throw new Error('Request was aborted.')
      return fallbackEvents
    },
    idleMs: 20,
  }))
  expect(out).toEqual(fallbackEvents)
})

// 看门狗在 thinking 心跳之间不应误触发：只要持续有事件到达就一直重置计时。
test('thinking 心跳：持续到达可阻止看门狗超时', async () => {
  let fellBack = false
  async function* thinkingThenAnswer(): AsyncGenerator<StreamEvent> {
    for (let i = 0; i < 5; i++) {
      yield { type: 'thinking', text: `step ${i}` }
      await Bun.sleep(15) // < idleMs，每个心跳都重置计时
    }
    yield { type: 'text', text: 'final answer' }
    yield { type: 'message_stop', usage: { input_tokens: 1, output_tokens: 1 }, stopReason: 'end_turn' }
  }
  const out = await collect(withIdleWatchdog({
    stream: thinkingThenAnswer(),
    abort: () => {},
    fallback: async (): Promise<StreamEvent[]> => { fellBack = true; return [] },
    idleMs: 40,
  }))
  expect(fellBack).toBe(false)
  expect(out.at(-2)).toEqual({ type: 'text', text: 'final answer' })
})

test('mapAnthropicMessageToEvents：text + tool_use + message_stop', () => {
  const msg = {
    content: [
      { type: 'text', text: 'hi' },
      { type: 'tool_use', id: 't1', name: 'Read', input: { path: '/a' } },
    ],
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 },
    stop_reason: 'tool_use',
  } as unknown as SDKMessage
  const events = mapAnthropicMessageToEvents(msg)
  expect(events).toEqual([
    { type: 'text', text: 'hi' },
    { type: 'tool_use', id: 't1', name: 'Read', input: { path: '/a' }, incomplete: false },
    {
      type: 'message_stop',
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 },
      stopReason: 'tool_use',
    },
  ])
})

test('mapOpenAICompletionToEvents：content + tool_calls，arguments 解析', () => {
  const resp = {
    choices: [{
      message: {
        content: 'answer',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'Bash', arguments: '{"cmd":"ls"}' } }],
      },
      finish_reason: 'tool_calls',
    }],
  } as unknown as OpenAI.Chat.ChatCompletion
  const events = mapOpenAICompletionToEvents(resp, { input_tokens: 7, output_tokens: 4, cache_read_input_tokens: 1 })
  expect(events).toEqual([
    { type: 'text', text: 'answer' },
    { type: 'tool_use', id: 'c1', name: 'Bash', input: { cmd: 'ls' }, incomplete: false },
    { type: 'message_stop', usage: { input_tokens: 7, output_tokens: 4, cache_read_input_tokens: 1 }, stopReason: 'tool_use' },
  ])
})

test('mapOpenAICompletionToEvents：arguments 非法 JSON → incomplete', () => {
  const resp = {
    choices: [{
      message: { content: null, tool_calls: [{ id: 'c2', type: 'function', function: { name: 'X', arguments: '{bad' } }] },
      finish_reason: 'tool_calls',
    }],
  } as unknown as OpenAI.Chat.ChatCompletion
  const events = mapOpenAICompletionToEvents(resp, { input_tokens: 0, output_tokens: 0 })
  expect(events[0]).toEqual({ type: 'tool_use', id: 'c2', name: 'X', input: {}, incomplete: true })
})

// 回归：DeepSeek/Kimi 等模型在 function-calling 语法失配时，把 tool-call 协议控制 token
// 当普通文本吐进 content——这些 token 不该被当成助手的真实回复展示给用户。
test('stripLeakedProtocolTokens：剥离 DeepSeek/Kimi 全角竖线 token', () => {
  const raw = '<｜tool▁calls▁begin｜>正文<｜tool▁call▁end｜>continue'
  expect(stripLeakedProtocolTokens(raw)).toBe('正文continue')
})

test('stripLeakedProtocolTokens：剥离 ChatML 半角竖线 token', () => {
  const raw = '<|im_start|>hello<|im_end|>'
  expect(stripLeakedProtocolTokens(raw)).toBe('hello')
})

test('stripLeakedProtocolTokens：正常文本原样保留', () => {
  const raw = '这是一段普通回复，包含 | 竖线 但不是 token，也有 <div> 标签。'
  expect(stripLeakedProtocolTokens(raw)).toBe(raw)
})

test('mapOpenAICompletionToEvents：content 剥离后为空则不产出 text 事件', () => {
  const resp = {
    choices: [{
      message: { content: '<｜tool▁calls▁begin｜><｜tool▁call▁end｜>', tool_calls: [] },
      finish_reason: 'stop',
    }],
  } as unknown as OpenAI.Chat.ChatCompletion
  const events = mapOpenAICompletionToEvents(resp, { input_tokens: 0, output_tokens: 0 })
  expect(events.find(e => e.type === 'text')).toBeUndefined()
})
