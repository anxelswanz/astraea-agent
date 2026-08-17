import { describe, expect, test } from 'bun:test'
import {
  buildCommitmentDirective,
  looksLikeActionPromise,
  parseCompletionAssessment,
} from './completion-guard'

test('parses an unfulfilled action commitment verdict', () => {
  expect(parseCompletionAssessment(JSON.stringify({
    verdict: 'unfulfilled_commitment',
    reason: 'Promised actions have no tool calls.',
  }))).toEqual({
    verdict: 'unfulfilled_commitment',
    reason: 'Promised actions have no tool calls.',
  })
})

test('preserves safe terminal verdicts', () => {
  for (const verdict of ['complete', 'waiting_for_user', 'blocked'] as const) {
    expect(parseCompletionAssessment(JSON.stringify({ verdict, reason: verdict }))).toEqual({
      verdict,
      reason: verdict,
    })
  }
})

// 没有助手文本可供启发式判断时，仍维持 fail-open —— 宁可放行也不要凭空困住一轮。
// 有文本时的降级行为见下面的 'guard degradation'。
test('invalid classifier output fails open instead of trapping the turn', () => {
  const assessment = parseCompletionAssessment('not json')
  expect(assessment.verdict).toBe('complete')
  expect(assessment.reason).toContain('invalid output')
})

test('continuation directive requires action rather than another plan recital', () => {
  const directive = buildCommitmentDirective('No tool was called.')
  expect(directive).toContain('Do not describe the plan again')
  expect(directive).toContain('immediately perform the promised actions with tools')
  expect(directive).toContain('No tool was called.')
})

describe('looksLikeActionPromise', () => {
  test('catches Chinese action promises', () => {
    for (const text of [
      '今天是 2026-08-17。记忆已完整核对。我立即连续创建剩余页面并接线、注册、编译，中途不询问。',
      '立即开始批量执行，不停顿。',
      '我先接线 SJ_InfoMenu.qml 的 4 个入口。',
      '接下来我会补 getFaultListModel，然后注册 qrc。',
      '立即 batch 这些，不停顿。',
    ]) {
      expect(looksLikeActionPromise(text)).toBe(true)
    }
  })

  test('catches English action promises', () => {
    for (const text of [
      "Let me now create the remaining pages and wire them up.",
      "I'll start fixing the imports.",
      'Proceeding now with the migration.',
      "Next, I'll register the new files.",
    ]) {
      expect(looksLikeActionPromise(text)).toBe(true)
    }
  })

  test('does not fire on conditionals, questions, or plain explanations', () => {
    for (const text of [
      '如果你确认，我就立即推送到远端。',
      '需要你确认用哪个版本号，我再继续执行。',
      '要我立即开始创建吗？',
      'If you confirm, I will now push the tag.',
      'Shall I start with the database layer?',
      'Would you like me to create the remaining pages?',
      '这个函数负责把 span 扇出到两个后端，没有副作用。',
      '',
      '   ',
    ]) {
      expect(looksLikeActionPromise(text)).toBe(false)
    }
  })
})

describe('guard degradation', () => {
  // 核心回归：小模型链路挂掉时（自建网关 / 本地 ollama / 模型名不存在），旧实现一律
  // fail-open 返回 complete，模型吐一句「我立即开始」就被当成最终回复放行 ——
  // 用户观感即「跑二三十秒就自己停了」。
  test('malformed guard output falls back to the heuristic instead of fail-open complete', () => {
    const stalling = '我立即连续创建剩余页面并接线、注册、编译，中途不询问。'
    const verdict = parseCompletionAssessment('<html>502 Bad Gateway</html>', stalling)

    expect(verdict.verdict).toBe('unfulfilled_commitment')
    expect(verdict.reason).toContain('local heuristic')
  })

  test('malformed guard output still completes when there is no action promise', () => {
    const verdict = parseCompletionAssessment('not json', '这个字段用于标记临时消息，不会外泄。')
    expect(verdict.verdict).toBe('complete')
  })

  test('a valid guard verdict is never overridden by the heuristic', () => {
    const stalling = '我立即开始执行。'
    const verdict = parseCompletionAssessment(
      '{"verdict":"waiting_for_user","reason":"needs a decision"}',
      stalling,
    )
    expect(verdict.verdict).toBe('waiting_for_user')
  })

  test('legacy single-argument callers still parse', () => {
    expect(parseCompletionAssessment('{"verdict":"complete","reason":"ok"}').verdict).toBe('complete')
  })
})

describe('buildCommitmentDirective', () => {
  test('first attempt stays gentle', () => {
    const out = buildCommitmentDirective('promised without acting', 1)
    expect(out).toContain('Do not describe the plan again')
    expect(out).not.toContain('attempt 2')
  })

  test('later attempts escalate to a hard tool-first constraint', () => {
    const out = buildCommitmentDirective('promised again', 3)
    expect(out).toContain('attempt 3')
    expect(out).toContain('must be a tool call')
    expect(out).toContain('no preamble')
  })
})
