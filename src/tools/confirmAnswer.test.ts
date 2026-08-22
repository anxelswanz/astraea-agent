// confirmAnswer 验收 —— 锁死「用户点头了却被判成拒绝」这条回归。
// 旧实现是 picked.startsWith('yes')，下面除第一条外全部会落进 declined，模型于是接着提问。

import { test, expect, describe } from 'bun:test'
import { interpretConfirmAnswer } from './confirmAnswer'

const LABELS = {
  approve: 'yes — allow this session & switch to cruise',
  decline: 'no — keep consulting',
}
// UI 的 formatAnswers 输出格式
const panel = (answer: string) =>
  `[Execute] Approach confirmed. Allow Astraea to start executing in this session?\n→ ${answer}`

describe('选项锚定', () => {
  test('选中放行项 → approved', () => {
    expect(interpretConfirmAnswer(panel(LABELS.approve), LABELS).verdict).toBe('approved')
  })

  test('选中拒绝项 → declined', () => {
    expect(interpretConfirmAnswer(panel(LABELS.decline), LABELS).verdict).toBe('declined')
  })

  test('问题正文里含 "Allow" 也不会误判（只看箭头之后）', () => {
    expect(interpretConfirmAnswer(panel(LABELS.decline), LABELS).verdict).toBe('declined')
  })
})

describe('自填肯定词 → approved（旧实现在这里全线失守）', () => {
  for (const word of ['可以', '好', '好的', '同意', '开始吧', '执行', '动手', '没问题', '批准', 'ok', 'OK!', 'go', 'go ahead', 'sure', 'yes', 'Y', 'proceed', 'do it']) {
    test(`「${word}」`, () => {
      expect(interpretConfirmAnswer(panel(word), LABELS).verdict).toBe('approved')
    })
  }
})

describe('自填否定词 → declined', () => {
  for (const word of ['不', '不行', '不可以', '别', '先别', '等等', '取消', '再想想', 'no', 'nope', 'stop', 'wait', 'cancel', 'later']) {
    test(`「${word}」`, () => {
      expect(interpretConfirmAnswer(panel(word), LABELS).verdict).toBe('declined')
    })
  }
})

describe('否定优先', () => {
  test('「不可以」不会因为含「可以」而被判成同意', () => {
    expect(interpretConfirmAnswer(panel('不可以'), LABELS).verdict).toBe('declined')
  })
  test('「不同意」同理', () => {
    expect(interpretConfirmAnswer(panel('不同意'), LABELS).verdict).toBe('declined')
  })
})

describe('空答案 = cancelled，不是 declined', () => {
  test('ESC 关面板 → cancelled', () => {
    expect(interpretConfirmAnswer('', LABELS).verdict).toBe('cancelled')
  })
  test('只有空白 → cancelled', () => {
    expect(interpretConfirmAnswer('   \n  ', LABELS).verdict).toBe('cancelled')
  })
})

describe('其它自填内容 = unclear，原文回传', () => {
  test('补充指令不该被当成拒绝', () => {
    const res = interpretConfirmAnswer(panel('先只做第一步，别碰配置文件'), LABELS)
    expect(res.verdict).toBe('unclear')
    expect(res.picked).toBe('先只做第一步，别碰配置文件')
  })
})

describe('orbit 闸的 label 同样适用', () => {
  const orbit = { approve: 'yes — approve and execute', decline: 'no — revise the plan' }
  test('选中批准项', () => {
    expect(interpretConfirmAnswer(`[Plan] Approve?\n→ ${orbit.approve}`, orbit).verdict).toBe('approved')
  })
  test('自填「批了」', () => {
    expect(interpretConfirmAnswer(`[Plan] Approve?\n→ 批了`, orbit).verdict).toBe('approved')
  })
})
