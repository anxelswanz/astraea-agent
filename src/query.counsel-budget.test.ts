// counsel 提问预算验收 —— 锁死「一直问下去、一直不执行」这条回归。
//
// 背景：所有防空转的 stop-hook 都挂在「本轮没有 tool call」的分支上，而 AskUserQuestion 是
// 一次 tool call。没有这个预算，counsel 里连问 N 轮在引擎眼里全是「有进展」，谁都拦不住。
//
// 这里让 mock 模型无脑地每轮都调 AskUserQuestion，断言引擎按轮次注入收敛指令 / 截断访谈。

import { expect, mock, test, beforeEach, afterEach } from 'bun:test'
import type { StreamEvent } from './types/message'
import { config } from './config'
import { setMode } from './state/sessionMode'
import { buildTool } from './tools/Tool'

let turn = 0

// 每轮都开一次问卷，永不收敛——正是用户报的那个行为。
async function* mockedStream(): AsyncGenerator<StreamEvent> {
  turn++
  yield {
    type: 'tool_use',
    id: `ask-${turn}`,
    name: 'AskUserQuestion',
    input: { questions: [{ question: `Q${turn}?`, options: [{ label: 'A' }, { label: 'B' }] }] },
  }
  yield { type: 'message_stop', usage: { input_tokens: 1, output_tokens: 1 }, stopReason: 'tool_use' }
}

mock.module('./api/stream', () => ({ streamMessage: mockedStream }))
mock.module('./api/anthropic', () => ({ streamMessageAnthropic: mockedStream }))

// 桩工具：立即返回一个答案，不走 UI bridge（测试里没有 UI 监听者）。
const StubAsk = buildTool({
  name: 'AskUserQuestion',
  description: 'stub',
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  inputSchema: { type: 'object', properties: {} },
  async call() { return { output: '[Scope] Q?\n→ A' } },
})

async function runCounselTurns(maxTurns: number): Promise<string> {
  turn = 0
  config.provider = 'anthropic'
  setMode('counsel')
  const { query } = await import('./query')
  // 把注入到 user message 里的所有 text block 拼起来 —— 收敛指令就落在那里。
  let injected = ''
  for await (const event of query(
    [{ role: 'user', content: '帮我把这个功能做了' }],
    [StubAsk],
    { autocompact: true, maxTurns, cwd: '/tmp/astraea-counsel-budget-test' },
  )) {
    if (event.type === 'done') {
      for (const m of event.messages) {
        if (m.role !== 'user' || typeof m.content === 'string') continue
        for (const b of m.content) if (b.type === 'text') injected += b.text + '\n'
      }
    }
  }
  return injected
}

beforeEach(() => { setMode('default') })
afterEach(() => { setMode('default') })

test('前 3 轮提问不加压 —— 正常访谈不该被打扰', async () => {
  const injected = await runCounselTurns(3)
  expect(injected).not.toContain('[Counsel convergence]')
  expect(injected).not.toContain('[Counsel budget exhausted]')
})

test('第 4 轮提问 → 注入收敛指令', async () => {
  const injected = await runCounselTurns(5)
  expect(injected).toContain('[Counsel convergence]')
  expect(injected).toContain('call ExitCounselMode now')
})

test('第 6 轮提问 → 访谈被截断，禁止再开问卷', async () => {
  const injected = await runCounselTurns(7)
  expect(injected).toContain('[Counsel budget exhausted]')
  expect(injected).toContain('MUST NOT contain AskUserQuestion')
})

test('非 counsel 模式不计数、不注入', async () => {
  turn = 0
  config.provider = 'anthropic'
  setMode('default')
  const { query } = await import('./query')
  let injected = ''
  for await (const event of query(
    [{ role: 'user', content: '帮我把这个功能做了' }],
    [StubAsk],
    { autocompact: true, maxTurns: 7, cwd: '/tmp/astraea-counsel-budget-test' },
  )) {
    if (event.type === 'done') {
      for (const m of event.messages) {
        if (m.role !== 'user' || typeof m.content === 'string') continue
        for (const b of m.content) if (b.type === 'text') injected += b.text + '\n'
      }
    }
  }
  expect(injected).not.toContain('[Counsel convergence]')
  expect(injected).not.toContain('[Counsel budget exhausted]')
})

test('超过硬上限后 AskUserQuestion 被直接拒发 —— 问卷不会再弹到用户面前', async () => {
  turn = 0
  config.provider = 'anthropic'
  setMode('counsel')
  const { query } = await import('./query')
  let panelsShown = 0
  let refusals = 0
  for await (const event of query(
    [{ role: 'user', content: '帮我把这个功能做了' }],
    [StubAsk],
    { autocompact: true, maxTurns: 12, cwd: '/tmp/astraea-counsel-budget-test' },
  )) {
    if (event.type === 'tool_result' && event.name === 'AskUserQuestion') {
      if (event.output.startsWith('[counsel budget]')) refusals++
      else panelsShown++
    }
  }
  // 用户最多看到 6 个面板；之后每一次提问都被引擎挡回去。
  expect(panelsShown).toBe(6)
  expect(refusals).toBeGreaterThan(0)
})
