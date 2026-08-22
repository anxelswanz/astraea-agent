// AskUserQuestionTool — 允许模型向用户提问以澄清意图
// 参考 claude-code-main: AskUserQuestion
//
// REPL 模式：通过 bridge 暂停 query 循环，等待用户输入（多问题面板）
// CLI 模式：无监听者时立即返回（模型自行判断）

import { buildTool } from '../Tool.js'
import type { Tool, ToolCallResult } from '../Tool.js'
import { ask } from './bridge.js'
import type { Question, QuestionOption } from './bridge.js'

// 把模型可能传来的多种 option 形态统一成 {label, description}
function normalizeOptions(raw: unknown): QuestionOption[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map(o => {
      if (typeof o === 'string') return { label: o }
      if (o && typeof o === 'object') {
        const obj = o as Record<string, unknown>
        const label = typeof obj['label'] === 'string' ? (obj['label'] as string) : ''
        const description = typeof obj['description'] === 'string' ? (obj['description'] as string) : undefined
        return label ? { label, description } : null
      }
      return null
    })
    .filter((x): x is QuestionOption => x !== null)
}

// 既支持新结构 questions[]，也兜底旧结构 question + options[]
function normalizeQuestions(input: Record<string, unknown>): Question[] {
  const rawQs = input['questions']
  if (Array.isArray(rawQs) && rawQs.length > 0) {
    return rawQs
      .map((q): Question | null => {
        const obj = (q ?? {}) as Record<string, unknown>
        const question = typeof obj['question'] === 'string' ? (obj['question'] as string) : ''
        const header = typeof obj['header'] === 'string' ? (obj['header'] as string) : undefined
        const multiSelect = obj['multiSelect'] === true
        const options = normalizeOptions(obj['options'])
        return question ? { question, header, multiSelect, options } : null
      })
      .filter((x): x is Question => x !== null)
      .slice(0, 4) // 一次最多 4 题
  }
  // 旧结构兜底
  const question = typeof input['question'] === 'string' ? (input['question'] as string) : ''
  if (!question) return []
  return [{ question, options: normalizeOptions(input['options']) }]
}

export const AskUserQuestionTool = buildTool({
  name: 'AskUserQuestion',
  description: `Ask the user one or more clarifying questions and wait for their answer(s).

Pass a \`questions\` array (1–4 related questions). The user sees a single panel and
navigates between questions with ←→, moves options with ↑↓, toggles with Space, and
submits with Enter. Each question has:
  - question:   the prompt text
  - header:     a short category chip (e.g. "Scope", "Approach")
  - multiSelect: true if multiple answers make sense (default single-select)
  - options:    array of { label, description } — at least 2 per question

ALWAYS put the single best / most-recommended option FIRST and append "(推荐)" to its label.

ONLY use this proactively when ALL are true:
1. The action is IRREVERSIBLE or HIGH-RISK
2. You genuinely cannot infer the intent from context
3. Getting it wrong would cause significant harm

Do NOT use for: missing files (just create them), choosing between low-stakes
approaches (pick one), or anything you could learn by reading the codebase.
Bias toward action. (Counsel mode overrides these restrictions — see its instructions.)

If no interactive user is present (sub-agent / headless run), this tool FAILS CLOSED
with an error instead of answering on the user's behalf — take the safest conservative
path that needs no user input, or stop and report the pending decision.`,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  inputSchema: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        minItems: 1,
        maxItems: 4,
        description: 'One to four related questions shown in a single panel (navigated with ←→).',
        items: {
          type: 'object',
          properties: {
            question: { type: 'string', description: 'The question prompt' },
            header: { type: 'string', description: 'Short category chip, e.g. "Scope"' },
            multiSelect: { type: 'boolean', description: 'Allow selecting multiple options' },
            options: {
              type: 'array',
              minItems: 2,
              description: 'Choices. Put the recommended one FIRST with "(推荐)" in its label.',
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string' },
                  description: { type: 'string' },
                },
                required: ['label'],
              },
            },
          },
          required: ['question', 'options'],
        },
      },
      // 旧结构兜底（单题）。新代码应使用 questions[]。
      question: { type: 'string', description: 'Legacy single-question form. Prefer questions[].' },
      options: {
        type: 'array',
        items: { type: 'string' },
        description: 'Legacy options for the single-question form.',
      },
    },
  },

  async call(input, ctx: import('../Tool.js').ToolContext): Promise<ToolCallResult> {
    const questions = normalizeQuestions(input as Record<string, unknown>)

    if (questions.length === 0) {
      return { output: '[AskUserQuestion] No valid question provided.' }
    }

    // fail-closed(PR-4,对齐 fileWriteGate/BashTool 的 §3.0 约定):无人值守时不得
    // 替用户拍板——此前 fail-open 返回「自行判断」,headless 下模型会替用户做方向性决策。
    if (ctx.isInteractive !== true) {
      return {
        output:
          '[AskUserQuestion] Cannot ask: no interactive user is available (fail-closed). ' +
          'Do NOT invent an answer on the user\'s behalf. Take the safest conservative path ' +
          'that requires no user input, or stop and report which decision is pending.',
        isError: true,
      }
    }

    const userAnswer = await ask(questions)

    if (!userAnswer) {
      // 交互会话里拿到空答:UI 监听者退订/问题被 /stop 清空 —— 同样不得自行拍板。
      // 措辞很重要:旧文案是「ask again later」,模型的自然反应就是立刻原样再问一遍,
      // 于是 ESC 一次换来一轮新问卷。空答案的正确含义是「用户不想回答这个」。
      return {
        output: '[AskUserQuestion] The user dismissed the question without answering. Do NOT ask it again and do NOT invent an answer. Either proceed with the safest default and say which default you took, or state the pending decision in one sentence and stop.',
        isError: true,
      }
    }

    return { output: userAnswer }
  },
})
