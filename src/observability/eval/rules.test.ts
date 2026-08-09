import { describe, expect, test } from 'bun:test'
import { createTrajectoryCollector, formatTrajectory, type Trajectory } from './trajectory'
import {
  runAllRules,
  ruleGoalMet,
  ruleNoErrorStreak,
  ruleNoIdenticalLoop,
  ruleNotExhausted,
  ruleToolErrorRate,
  ruleTrajectoryLength,
} from './rules'

function traj(steps: { tool: string; input?: Record<string, unknown>; isError?: boolean }[]): Trajectory {
  return {
    traceId: 't'.repeat(32),
    sessionId: 's',
    finalText: '',
    turns: 1,
    steps: steps.map((s, i) => ({
      index: i,
      tool: s.tool,
      input: s.input ?? {},
      isError: s.isError ?? false,
      outputChars: 10,
    })),
  }
}

describe('打转检测', () => {
  test('同一工具 + 同一入参重复 3 次 → 判失败,理由带步号', () => {
    const r = ruleNoIdenticalLoop(
      traj([
        { tool: 'GrepTool', input: { pattern: 'foo' } },
        { tool: 'FileReadTool', input: { file_path: '/a' } },
        { tool: 'GrepTool', input: { pattern: 'foo' } },
        { tool: 'GrepTool', input: { pattern: 'foo' } },
      ]),
    )
    expect(r.value).toBe(0)
    expect(r.comment).toContain('GrepTool')
    expect(r.comment).toContain('3 次')
    expect(r.comment).toContain('0, 2, 3') // 步号可定位
  })

  // 这条是整个规则层的核心取舍：按「工具名」计数会把正常探索全判失败,假阳性高到没法用。
  test('同一工具但入参不同 → 正常探索,不判失败', () => {
    const r = ruleNoIdenticalLoop(
      traj([
        { tool: 'GrepTool', input: { pattern: 'a' } },
        { tool: 'GrepTool', input: { pattern: 'b' } },
        { tool: 'GrepTool', input: { pattern: 'c' } },
        { tool: 'GrepTool', input: { pattern: 'd' } },
        { tool: 'GrepTool', input: { pattern: 'e' } },
      ]),
    )
    expect(r.value).toBe(1)
  })

  test('入参 key 顺序不同但语义相同 → 仍算同一指纹', () => {
    const r = ruleNoIdenticalLoop(
      traj([
        { tool: 'T', input: { a: 1, b: 2 } },
        { tool: 'T', input: { b: 2, a: 1 } },
        { tool: 'T', input: { a: 1, b: 2 } },
      ]),
    )
    expect(r.value).toBe(0)
  })

  test('阈值可配', () => {
    const t = traj([
      { tool: 'T', input: { x: 1 } },
      { tool: 'T', input: { x: 1 } },
    ])
    expect(ruleNoIdenticalLoop(t, { identicalCallLimit: 2 }).value).toBe(0)
    expect(ruleNoIdenticalLoop(t, { identicalCallLimit: 3 }).value).toBe(1)
  })
})

describe('卡死检测', () => {
  test('连续 3 次报错 → 判失败', () => {
    const r = ruleNoErrorStreak(
      traj([
        { tool: 'A' },
        { tool: 'B', isError: true },
        { tool: 'C', isError: true },
        { tool: 'D', isError: true },
      ]),
    )
    expect(r.value).toBe(0)
    expect(r.comment).toContain('第 1 步起连续 3 次')
  })

  // 单次报错是设计意图（结构化错误让 agent 自我修正）,不该判失败
  test('报错被打断 → 说明 agent 在自我修正,不判失败', () => {
    const r = ruleNoErrorStreak(
      traj([{ tool: 'A', isError: true }, { tool: 'B' }, { tool: 'C', isError: true }, { tool: 'D' }]),
    )
    expect(r.value).toBe(1)
  })
})

describe('其余规则', () => {
  test('轨迹超长 → 判失败', () => {
    const long = traj(Array.from({ length: 61 }, (_, i) => ({ tool: 'T', input: { i } })))
    expect(ruleTrajectoryLength(long).value).toBe(0)
    expect(ruleTrajectoryLength(long, { maxSteps: 100 }).value).toBe(1)
  })

  test('错误率是连续值', () => {
    const r = ruleToolErrorRate(traj([{ tool: 'A', isError: true }, { tool: 'B' }, { tool: 'C' }, { tool: 'D' }]))
    expect(r.value).toBe(0.25)
    expect(r.dataType).toBe('NUMERIC')
  })

  test('空轨迹不炸', () => {
    expect(ruleToolErrorRate(traj([])).value).toBe(0)
    expect(() => runAllRules(traj([]))).not.toThrow()
  })

  test('被安全闸强停 → 判失败', () => {
    const t = traj([{ tool: 'A' }])
    expect(ruleNotExhausted(t).value).toBe(1)
    t.exhausted = { cause: 'stall', reason: '连续 3 turn 无进展' }
    const r = ruleNotExhausted(t)
    expect(r.value).toBe(0)
    expect(r.comment).toContain('stall')
  })

  test('没开 /goal 时 goal_met 不产出（而不是误判成失败）', () => {
    const t = traj([{ tool: 'A' }])
    expect(ruleGoalMet(t)).toBeNull()
    expect(runAllRules(t).find((s) => s.name === 'goal_met')).toBeUndefined()

    t.goal = { met: false, reason: '文件没建出来', condition: 'README 存在' }
    const r = ruleGoalMet(t)!
    expect(r.value).toBe(0)
    expect(r.comment).toBe('文件没建出来')
    expect(runAllRules(t).find((s) => s.name === 'goal_met')?.value).toBe(0)
  })
})

describe('轨迹收集器', () => {
  test('从 query() 事件流归约出轨迹', () => {
    const c = createTrajectoryCollector()
    c.observe({ type: 'trace_start', traceId: 'abc', sessionId: 'sess-1' })
    c.observe({ type: 'turn_start', turn: 1, flushPrev: false })
    c.observe({
      type: 'tool_result',
      id: '1',
      name: 'FileReadTool',
      input: { file_path: '/a' },
      output: 'hello',
      isError: false,
    })
    c.observe({ type: 'turn_start', turn: 2, flushPrev: false })
    c.observe({ type: 'tool_result', id: '2', name: 'BashTool', input: { cmd: 'ls' }, output: 'x', isError: true })
    c.observe({ type: 'goal_evaluated', met: true, reason: '看完了', condition: 'c', turns: 2 })
    c.observe({
      type: 'done',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: [{ type: 'text', text: '看完了' }] },
      ],
    })

    const t = c.result()
    expect(t.traceId).toBe('abc')
    expect(t.sessionId).toBe('sess-1')
    expect(t.turns).toBe(2)
    expect(t.steps.map((s) => s.tool)).toEqual(['FileReadTool', 'BashTool'])
    expect(t.steps[1]!.isError).toBe(true)
    expect(t.steps[0]!.outputChars).toBe(5) // 只留长度,不留内容
    expect(t.finalText).toBe('看完了')
    expect(t.goal).toEqual({ met: true, reason: '看完了', condition: 'c' })
  })

  test('无关事件不影响轨迹', () => {
    const c = createTrajectoryCollector()
    c.observe({ type: 'compact_start', trigger: 'auto', preTokens: 100 })
    c.observe({ type: 'tool_progress', id: '1', name: 'T', chunk: 'x' })
    expect(c.result().steps).toEqual([])
  })

  test('formatTrajectory 截断长入参（judge 成本闸门）', () => {
    const c = createTrajectoryCollector()
    c.observe({
      type: 'tool_result',
      id: '1',
      name: 'FileWriteTool',
      input: { content: 'x'.repeat(5000) },
      output: 'ok',
      isError: false,
    })
    const s = formatTrajectory(c.result(), { maxInputChars: 50 })
    expect(s).toContain('FileWriteTool')
    expect(s).toContain('…(+')
    expect(s.length).toBeLessThan(200)
  })

  test('formatTrajectory 标出错误步', () => {
    const t = traj([{ tool: 'A' }, { tool: 'B', isError: true }])
    const s = formatTrajectory(t)
    expect(s).toContain('0. A({})')
    expect(s).toContain('1. B({}) → ERROR')
  })
})
