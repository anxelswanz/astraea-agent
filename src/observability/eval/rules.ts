// ─────────────────────────────────────────────────────────────────────────────
// 规则型轨迹评测（rules）—— 确定性、零 LLM 成本、可当 CI 闸门。
//
// 定位（很重要,决定了该写哪些规则）：
//   规则层只盯「工具层管不到」的失败。astraea 的 v0.10.23-26 四批可靠性审计已经把单次调用
//   的正确性焊死了 —— 入口 required/type/enum 校验、read-before-write 由 readFileState 强制、
//   超时/AbortSignal 贯通、retry/熔断。这些都已 fail-close,再写 eval 断言它们纯属重复。
//   规则层该盯的是「每一步都合法、合起来却是灾难」的模式：打转、卡死、做无用功。
//
// 为什么规则层排在 LLM judge 之前做（Hamel Husain 的 error analysis 方法论）：
//   判官要先有失败样本才知道判什么。规则层免费、瞬时、无歧义,先用它把明显的烂轨迹捞出来,
//   人再去看这些样本、归纳 failure taxonomy,然后才谈得上写 judge。反过来先写 judge 就是
//   他说的 "eval-driven development" —— 在不懂失败长什么样之前就造评测。
//
// 打分一律二值（Hamel：binary 比 Likert 1-5 更可靠,中间值是annotator 藏不确定性的地方）。
// value=1 表示「通过 / 没触发这个失败模式」,0 表示「触发了」—— 与 Langfuse BOOLEAN 一致。
// ─────────────────────────────────────────────────────────────────────────────

import type { Trajectory, TrajectoryStep } from './trajectory'

/** 一条规则的产出。对齐 Langfuse score.create() 的字段。 */
export interface RuleScore {
  name: string
  value: number
  dataType: 'BOOLEAN' | 'NUMERIC'
  /** 失败理由。必须能让人不看轨迹就知道哪一步出了什么问题。 */
  comment?: string
}

export interface RuleConfig {
  /** 同一工具 + 同一入参重复多少次算打转。默认 3。 */
  identicalCallLimit?: number
  /** 连续多少次工具报错算卡死。默认 3。 */
  errorStreakLimit?: number
  /** 轨迹最多多少步。默认 60。超了判失败（OpenAI: cap trace length, 超限即失败）。 */
  maxSteps?: number
}

const DEFAULTS: Required<RuleConfig> = {
  identicalCallLimit: 3,
  errorStreakLimit: 3,
  maxSteps: 60,
}

/** 稳定的调用指纹：工具名 + 规范化入参。key 排序保证 {a,b} 与 {b,a} 同指纹。 */
function fingerprint(s: TrajectoryStep): string {
  let args: string
  try {
    args = JSON.stringify(s.input, Object.keys(s.input ?? {}).sort())
  } catch {
    args = '[unserializable]'
  }
  return `${s.tool}::${args}`
}

/**
 * 打转检测：同一工具 + **完全相同的入参** 重复调用。
 *
 * 注意这里比「同一 Tool 调用超过 N 次」严格得多,是有意的：
 * Grep 连查 10 个不同 pattern 是正常搜索,Read 连读 20 个不同文件是正常探索 —— 按工具名计数
 * 会把这些正常行为全判成失败(假阳性高到没法用)。真正的病态是**同一个调用原样重复**:
 * 那意味着 agent 没从结果里学到任何东西,是死循环的确切信号。
 */
export function ruleNoIdenticalLoop(t: Trajectory, cfg: RuleConfig = {}): RuleScore {
  const limit = cfg.identicalCallLimit ?? DEFAULTS.identicalCallLimit
  const counts = new Map<string, number[]>()
  for (const s of t.steps) {
    const fp = fingerprint(s)
    const arr = counts.get(fp) ?? []
    arr.push(s.index)
    counts.set(fp, arr)
  }
  for (const [fp, idxs] of counts) {
    if (idxs.length >= limit) {
      const tool = fp.split('::')[0]
      return {
        name: 'no_identical_loop',
        value: 0,
        dataType: 'BOOLEAN',
        comment: `${tool} 以完全相同的入参被调用 ${idxs.length} 次（第 ${idxs.join(', ')} 步）——agent 没从结果里获得新信息,疑似死循环`,
      }
    }
  }
  return { name: 'no_identical_loop', value: 1, dataType: 'BOOLEAN' }
}

/**
 * 卡死检测：连续 N 次工具调用报错。
 * 单次报错是正常的（agent 该读错误信息自我修正,这正是 v0.10.23 结构化错误的设计意图）；
 * 连续错才说明它没在修正,只是在重试。
 */
export function ruleNoErrorStreak(t: Trajectory, cfg: RuleConfig = {}): RuleScore {
  const limit = cfg.errorStreakLimit ?? DEFAULTS.errorStreakLimit
  let streak = 0
  let start = -1
  for (const s of t.steps) {
    if (s.isError) {
      if (streak === 0) start = s.index
      streak++
      if (streak >= limit) {
        return {
          name: 'no_error_streak',
          value: 0,
          dataType: 'BOOLEAN',
          comment: `第 ${start} 步起连续 ${streak} 次工具报错——agent 未能从错误中自我修正`,
        }
      }
    } else {
      streak = 0
    }
  }
  return { name: 'no_error_streak', value: 1, dataType: 'BOOLEAN' }
}

/**
 * 轨迹长度闸门。OpenAI 的 agent eval 指南：打转的 agent 会产生巨大 trace,评测成本爆炸,
 * 应给长度设上限并把超限直接判失败。
 */
export function ruleTrajectoryLength(t: Trajectory, cfg: RuleConfig = {}): RuleScore {
  const max = cfg.maxSteps ?? DEFAULTS.maxSteps
  return t.steps.length > max
    ? {
        name: 'trajectory_within_budget',
        value: 0,
        dataType: 'BOOLEAN',
        comment: `轨迹 ${t.steps.length} 步,超过上限 ${max}`,
      }
    : { name: 'trajectory_within_budget', value: 1, dataType: 'BOOLEAN' }
}

/** 工具错误率（诊断用的连续值,不当闸门 —— 用来在面板上按会话排序找烂轨迹）。 */
export function ruleToolErrorRate(t: Trajectory): RuleScore {
  if (t.steps.length === 0) return { name: 'tool_error_rate', value: 0, dataType: 'NUMERIC' }
  const errs = t.steps.filter((s) => s.isError).length
  return {
    name: 'tool_error_rate',
    value: errs / t.steps.length,
    dataType: 'NUMERIC',
    comment: `${errs}/${t.steps.length} 次工具调用报错`,
  }
}

/**
 * 没被安全闸强停。撞 turn/token 上限或停滞被 /goal 强杀,本身就是一种明确的失败,
 * 不需要 judge 来判。
 */
export function ruleNotExhausted(t: Trajectory): RuleScore {
  return t.exhausted
    ? {
        name: 'not_exhausted',
        value: 0,
        dataType: 'BOOLEAN',
        comment: `被安全闸强停（${t.exhausted.cause}）：${t.exhausted.reason}`,
      }
    : { name: 'not_exhausted', value: 1, dataType: 'BOOLEAN' }
}

/**
 * /goal 裁决直通。astraea 的 Stop-hook 本来就在每个 turn 后跑 LLM 裁决目标是否达成 ——
 * 那是一个现成的 outcome 判官,白捡,不用再花钱judge 一遍。没开 /goal 时返回 null。
 */
export function ruleGoalMet(t: Trajectory): RuleScore | null {
  if (!t.goal) return null
  return {
    name: 'goal_met',
    value: t.goal.met ? 1 : 0,
    dataType: 'BOOLEAN',
    comment: t.goal.reason,
  }
}

/** 跑全部规则。返回的 score 可直接喂 langfuse.score.create() 或 experiment evaluator。 */
export function runAllRules(t: Trajectory, cfg: RuleConfig = {}): RuleScore[] {
  const out: RuleScore[] = [
    ruleNoIdenticalLoop(t, cfg),
    ruleNoErrorStreak(t, cfg),
    ruleTrajectoryLength(t, cfg),
    ruleToolErrorRate(t),
    ruleNotExhausted(t),
  ]
  const goal = ruleGoalMet(t)
  if (goal) out.push(goal)
  return out
}
