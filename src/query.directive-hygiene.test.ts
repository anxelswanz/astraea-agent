// 回归：stop-hook 注入的续跑指令必须只活一轮。
//
// v0.10.27 之前 stripReminders 只认 `typeof content === 'string'`，而所有注入点用的都是
// 数组 content，于是每条 directive 都永久沉淀进 conversationRef —— 历史里堆满「你还有
// 未完成任务 X」的伪用户消息，模型于是放下用户的新请求，反复回去重做最早那个任务。
import { expect, test } from 'bun:test'
import { isEngineDirective, latestUserText, stripReminders } from './query'
import type { AssistantMessage, UserMessage } from './types/message'

const userMsg = (text: string): UserMessage => ({ role: 'user', content: [{ type: 'text', text }] })
const assistantMsg = (text: string): AssistantMessage => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
})

test('strips array-content directives, not just string ones', () => {
  const reminderArray: UserMessage = {
    role: 'user',
    ephemeral: true,
    content: [{ type: 'text', text: '<system-reminder>\nYou are ending your turn…\n</system-reminder>' }],
  }
  const reminderString: UserMessage = { role: 'user', content: '<system-reminder>legacy</system-reminder>' }
  const real = userMsg('看一下这些文档是否用了同一种加密格式')

  const kept = stripReminders([real, assistantMsg('好的'), reminderArray, reminderString])

  expect(kept).toEqual([real, assistantMsg('好的')])
})

test('strips unmarked legacy directives by prefix', () => {
  // 打标之前产生的历史（升级前的会话 / transcript 回放）没有 ephemeral 字段
  const goal: UserMessage = { role: 'user', content: [{ type: 'text', text: '[/goal] Your active goal is NOT yet satisfied' }] }
  const cont: UserMessage = { role: 'user', content: [{ type: 'text', text: '[system] Your previous message was cut off' }] }
  const replan: UserMessage = { role: 'user', content: [{ type: 'text', text: '<system-reminder>\ntask graph…' }] }

  expect(stripReminders([goal, cont, replan])).toEqual([])
})

test('never drops real user input, interjections, or tool results', () => {
  const plain = userMsg('继续')
  const interject: UserMessage = {
    role: 'user',
    content: [{ type: 'text', text: '<user_interjection>\n先别改那个文件\n</user_interjection>' }],
  }
  const toolResult: UserMessage = {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }],
  }
  // 指令 + 真实 tool_result 混在同一条消息里 → 整条保留，绝不能连 tool_result 一起删掉
  const mixed: UserMessage = {
    role: 'user',
    content: [
      { type: 'text', text: '<system-reminder>nudge</system-reminder>' },
      { type: 'tool_result', tool_use_id: 'toolu_2', content: 'ok' },
    ],
  }
  const empty: UserMessage = { role: 'user', content: [] }

  const msgs = [plain, interject, toolResult, mixed, empty]
  expect(stripReminders(msgs)).toEqual(msgs)
  expect(msgs.some(isEngineDirective)).toBe(false)
})

test('latestUserText looks past injected directives to the real request', () => {
  const msgs = [
    userMsg('确认这些 docx 是否是同一种私有格式'),
    assistantMsg('我看一下'),
    {
      role: 'user',
      ephemeral: true,
      content: [{ type: 'text', text: '<system-reminder>\nUNFINISHED (1) — [t1] 重写 m4a 大屏\n</system-reminder>' }],
    } as UserMessage,
  ]

  // 取到 directive 会让 completionAssessor 拿旧任务比对新一轮工作，判成「承诺未兑现」，
  // 再注入一条指令把模型拽回旧任务 —— 复读闭环的第二环。
  expect(latestUserText(msgs)).toBe('确认这些 docx 是否是同一种私有格式')
})

test('latestUserText falls back to empty when only directives exist', () => {
  const only: UserMessage = { role: 'user', ephemeral: true, content: [{ type: 'text', text: '<system-reminder>x</system-reminder>' }] }
  expect(latestUserText([only])).toBe('')
})
