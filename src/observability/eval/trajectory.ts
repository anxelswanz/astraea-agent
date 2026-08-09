// ─────────────────────────────────────────────────────────────────────────────
// 轨迹收集（trajectory）—— 把 query() 的事件流归约成一条可评测的轨迹。
//
// 为什么不用「事后查 trace」：
//   Langfuse 的 experiment.run() 传给 evaluator 的只有 input/output/expectedOutput/metadata,
//   拿不到 trace 结构（官方 EvaluationContext 就没这个字段）。所以正确做法是让 task 自己
//   把轨迹当返回值吐出来 —— 而 astraea 的 query() 本来就是 AsyncGenerator,tool_result
//   事件自带 {name, input, output, isError},轨迹本质上就是这个事件流的 reduce,不用回查。
//
// 非侵入：REPL/CLI 不用改,谁要评测谁在自己的消费循环里 observe() 一下即可。
// ─────────────────────────────────────────────────────────────────────────────

import type { QueryEvent } from '../../query'
import type { AssistantMessage, TextBlock, UserMessage } from '../../types/message'

/** 轨迹里的一步 = 一次工具调用及其结果。 */
export interface TrajectoryStep {
  /** 第几步（从 0 起）。judge 的理由里要引用步号,必须稳定。 */
  index: number
  tool: string
  input: Record<string, unknown>
  isError: boolean
  /** 只留长度不留内容：轨迹会被喂给 judge / 存进 Langfuse,原样带上等于泄密 + 烧 token。 */
  outputChars: number
}

/** 一次 query() 的完整轨迹。 */
export interface Trajectory {
  /** W3C trace id，用于把 score 回挂到 Langfuse 上这条 trace。未启用可观测性时为空串。 */
  traceId: string
  sessionId: string
  steps: TrajectoryStep[]
  /** 最终回答的纯文本（outcome 评测用）。 */
  finalText: string
  /** 实际跑了几个 turn。 */
  turns: number
  /** /goal 的 Stop-hook 裁决（没开 /goal 时为 undefined）。这是白捡的 outcome 信号。 */
  goal?: { met: boolean; reason: string; condition: string }
  /** 是否被安全闸强停（撞 turn/token 上限或停滞）—— 这本身就是一种失败模式。 */
  exhausted?: { cause: 'turns' | 'tokens' | 'stall'; reason: string }
}

/** 从 assistant 消息里抽最终纯文本。 */
function finalAssistantText(msgs: (UserMessage | AssistantMessage)[]): string {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if (!m || m.role !== 'assistant') continue
    if (typeof m.content === 'string') return m.content
    const texts = m.content.filter((b): b is TextBlock => b.type === 'text').map((b) => b.text)
    if (texts.length > 0) return texts.join('\n')
  }
  return ''
}

/**
 * 造一个收集器，喂它 query() 的事件即可。
 *
 * ```ts
 * const c = createTrajectoryCollector()
 * for await (const ev of query(msgs, tools, opts)) c.observe(ev)
 * const traj = c.result()
 * ```
 */
export function createTrajectoryCollector(): {
  observe: (ev: QueryEvent) => void
  result: () => Trajectory
} {
  const t: Trajectory = { traceId: '', sessionId: '', steps: [], finalText: '', turns: 0 }

  return {
    observe(ev: QueryEvent): void {
      switch (ev.type) {
        case 'trace_start':
          t.traceId = ev.traceId
          t.sessionId = ev.sessionId
          break
        case 'turn_start':
          t.turns = ev.turn
          break
        case 'tool_result':
          t.steps.push({
            index: t.steps.length,
            tool: ev.name,
            input: ev.input,
            isError: ev.isError,
            outputChars: ev.output?.length ?? 0,
          })
          break
        case 'goal_evaluated':
          t.goal = { met: ev.met, reason: ev.reason, condition: ev.condition }
          break
        case 'goal_exhausted':
          t.exhausted = { cause: ev.cause, reason: ev.reason }
          break
        case 'done':
          t.finalText = finalAssistantText(ev.messages)
          break
        default:
          break // 其余事件（流式增量/压缩/预算…）与轨迹无关
      }
    },
    result: () => t,
  }
}

/**
 * 轨迹的紧凑文本形式 —— 喂给 LLM judge 用。
 *
 * 为什么要截断：OpenAI 的 agent eval 指南明确提醒「会打转的 agent 会产生巨大的 trace,
 * 评测成本爆炸」,建议给轨迹长度设上限。这里对入参做了长度裁剪,判「工具选得对不对、
 * 参数合不合理」并不需要完整的 200 行 diff。
 */
export function formatTrajectory(t: Trajectory, opts: { maxInputChars?: number } = {}): string {
  const max = opts.maxInputChars ?? 200
  return t.steps
    .map((s) => {
      let args: string
      try {
        args = JSON.stringify(s.input)
      } catch {
        args = '[unserializable]'
      }
      if (args.length > max) args = `${args.slice(0, max)}…(+${args.length - max})`
      return `${s.index}. ${s.tool}(${args})${s.isError ? ' → ERROR' : ''}`
    })
    .join('\n')
}
