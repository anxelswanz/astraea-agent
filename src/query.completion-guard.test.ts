import { expect, mock, test } from 'bun:test'
import type { StreamEvent } from './types/message'
import { config } from './config'

let streamCalls = 0
let assessmentCalls = 0

async function* mockedStream(): AsyncGenerator<StreamEvent> {
  streamCalls++
  if (streamCalls === 1) {
    yield { type: 'text', text: '开始更新 CHANGELOG、提交、打标签、推送。' }
  } else {
    yield { type: 'text', text: '实际执行完成。' }
  }
  yield {
    type: 'message_stop',
    usage: { input_tokens: 1, output_tokens: 1 },
    stopReason: 'end_turn',
  }
}

mock.module('./api/stream', () => ({ streamMessage: mockedStream }))
mock.module('./api/anthropic', () => ({ streamMessageAnthropic: mockedStream }))

test('a tool-free action promise is continued instead of returned as done', async () => {
  config.provider = 'anthropic'
  streamCalls = 0
  assessmentCalls = 0

  const { query } = await import('./query')
  const events = []
  for await (const event of query(
    [{ role: 'user', content: '请提交并推送 v0.10.16' }],
    [],
    {
      autocompact: true,
      maxTurns: 3,
      cwd: '/tmp/astraea-completion-guard-test',
      completionAssessor: async () => {
        assessmentCalls++
        // 第一轮判未兑现 → 续跑；第二轮已经动手 → 放行
        return assessmentCalls === 1
          ? {
              verdict: 'unfulfilled_commitment',
              reason: 'The assistant promised repository actions without calling a tool.',
            }
          : { verdict: 'complete', reason: 'done' }
      },
    },
  )) {
    events.push(event)
  }

  expect(assessmentCalls).toBe(2)
  expect(streamCalls).toBe(2)
  expect(events.filter(event => event.type === 'turn_start')).toHaveLength(2)
  expect(events.some(e => e.type === 'commitment_exhausted')).toBe(false)
})

// 回归：只救一次时，模型卡在「复述计划不动手」的循环里第二轮起就没人管，引擎把纯文本
// 当最终回复直接交还 —— 用户观感就是「跑二三十秒就自己停了」。现在要连救 3 次，
// 且用尽后必须显式报出来，不能静默停。
test('repeated stalling is pressured multiple times, then reported instead of silently stopping', async () => {
  config.provider = 'anthropic'
  streamCalls = 0
  assessmentCalls = 0

  const { query } = await import('./query')
  const events = []
  for await (const event of query(
    [{ role: 'user', content: '继续执行啊' }],
    [],
    {
      autocompact: true,
      maxTurns: 20,
      cwd: '/tmp/astraea-completion-guard-test',
      completionAssessor: async () => {
        assessmentCalls++
        return {
          verdict: 'unfulfilled_commitment',
          reason: 'Restated the plan again with no tool call.',
        }
      },
    },
  )) {
    events.push(event)
  }

  expect(assessmentCalls).toBe(3)
  // 每次加压都要真的再跑一轮模型（精确轮数受进程内单例影响，只断下界）
  expect(streamCalls).toBeGreaterThanOrEqual(4)

  const exhausted = events.find(e => e.type === 'commitment_exhausted')
  expect(exhausted).toBeDefined()
  expect(exhausted).toMatchObject({ attempts: 3 })
  // 交还控制权前必须先发出提示，用户才知道为什么停
  expect(events.at(-1)?.type).toBe('done')
})
