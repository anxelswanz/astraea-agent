import { querySmallModel } from '../api/query-model'

export type CompletionVerdict =
  | 'complete'
  | 'waiting_for_user'
  | 'blocked'
  | 'unfulfilled_commitment'

export interface CompletionAssessment {
  verdict: CompletionVerdict
  reason: string
}

const COMPLETION_GUARD_SYSTEM = [
  'You guard the stopping point of an autonomous coding agent.',
  'Classify whether its latest tool-free assistant message may safely end the turn.',
  '',
  'Verdicts:',
  '- complete: the user asked for information only, or the requested work is demonstrably finished.',
  '- waiting_for_user: execution genuinely requires a user decision, confirmation, or missing input.',
  '- blocked: execution was attempted but cannot continue, and the message names the concrete blocker.',
  '- unfulfilled_commitment: the assistant says it is starting, continuing, or about to perform actions,',
  '  but the current turn contains no tool call and the actions are not complete.',
  '',
  'Distinguish an unconditional action promise from a conditional statement such as',
  '"if you confirm, I will push", which is waiting_for_user.',
  'Do not treat explanations, examples, recommendations, or hypothetical plans as commitments.',
  '',
  'Respond with ONLY one JSON object:',
  '{"verdict":"complete|waiting_for_user|blocked|unfulfilled_commitment","reason":"one concise sentence"}',
].join('\n')

// ── 不依赖 LLM 的兜底判定 ───────────────────────────────────────────────────
// guard 走的是小模型（provider 各自硬编码的 haiku / gpt-4o-mini / …）。这条链路在
// 自建网关、本地 ollama、模型名不存在的环境里很容易整条挂掉，而挂掉时旧实现一律
// fail-open 返回 complete —— 于是模型只要吐一段「我立即开始…」就被当成最终回复放行，
// 用户看到的就是「跑二三十秒就停」。这里用纯文本模式兜底：宁可少判，也不要在 guard
// 不可用时把明摆着的行动承诺当成收尾。
const ACTION_PROMISE_PATTERNS: RegExp[] = [
  // 中文：立即/马上/现在开始/我先…/接下来我…/这就…/继续执行/不停顿
  // 允许中间夹少量修饰词（「立即**连续**创建」「现在**就先**执行」）——卡死时的措辞
  // 几乎总带这类副词，贴死动词会漏判。
  /(立即|马上|现在|这就)[^。！？；\n]{0,8}?(开始|执行|创建|修改|接线|注册|编译|发出|调用|批量)/,
  /(我|现在)(先|来|这就|接着|继续)[^。！？；\n]{0,6}?(开始|执行|创建|修改|读|写|改|接线|注册|编译|批量)/,
  /(接下来|下一步)(我|就)?(会|要|将|立即|马上)/,
  /(开始|继续)(批量)?(执行|创建|收尾)/,
  /不(停顿|停下来|再询问|等确认)/,
  /(立即|直接)\s*(batch|Edit|Write|发工具|发出工具)/i,
  // 英文
  /\b(let me|i'?ll|i will|i'?m going to|i am going to)\s+(now\s+)?(start|begin|create|write|edit|update|run|fix|continue|proceed)/i,
  /\b(starting|proceeding|continuing)\s+(now|immediately|with)\b/i,
  /\bnext,?\s+i'?ll\b/i,
]

// 条件句不是承诺：「如果你确认，我就推送」属于 waiting_for_user。
const CONDITIONAL_PATTERNS: RegExp[] = [
  /(如果|若|要是)(你|您)?(确认|同意|需要|愿意|批准)/,
  /(需要|要)(你|您)(确认|决定|选择|提供)/,
  /(要我|需要我).{0,12}吗[？?]?\s*$/,
  /\bif you (confirm|approve|want|prefer|agree)\b/i,
  /\b(shall|should) i\b/i,
  /\bwould you like me to\b/i,
]

// 保守判定：命中承诺模式、没有条件句、且不是以问句收尾 → 视为「承诺了却没动手」。
export function looksLikeActionPromise(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return false
  if (CONDITIONAL_PATTERNS.some(p => p.test(trimmed))) return false
  // 以提问收尾 = 在等用户，不该强行续跑
  if (/[？?]\s*$/.test(trimmed)) return false
  return ACTION_PROMISE_PATTERNS.some(p => p.test(trimmed))
}

// guard 不可用（异常 / 输出垃圾）时的降级判定。带上原因，便于在 UI 上暴露真实故障。
function degradedAssessment(assistantText: string, why: string): CompletionAssessment {
  if (looksLikeActionPromise(assistantText)) {
    return {
      verdict: 'unfulfilled_commitment',
      reason: `${why} — falling back to local heuristic, which sees an unfulfilled action promise`,
    }
  }
  return { verdict: 'complete', reason: why }
}

export async function assessCompletion(input: {
  userText: string
  assistantText: string
  signal?: AbortSignal
}): Promise<CompletionAssessment> {
  try {
    const raw = await querySmallModel(
      [
        'LATEST USER REQUEST:',
        input.userText,
        '',
        'LATEST TOOL-FREE ASSISTANT MESSAGE:',
        input.assistantText,
        '',
        'Output the JSON verdict.',
      ].join('\n'),
      input.signal,
      COMPLETION_GUARD_SYSTEM,
      { structuredResponse: 'json' },
    )
    return parseCompletionAssessment(raw, input.assistantText)
  } catch (error) {
    return degradedAssessment(input.assistantText, `completion guard unavailable: ${String(error)}`)
  }
}

export function parseCompletionAssessment(raw: string, assistantText = ''): CompletionAssessment {
  const match = raw.trim().match(/\{[\s\S]*\}/)
  if (!match) return malformedAssessment(raw, assistantText)

  try {
    const parsed = JSON.parse(match[0]) as { verdict?: unknown; reason?: unknown }
    if (!isCompletionVerdict(parsed.verdict)) return malformedAssessment(raw, assistantText)
    return {
      verdict: parsed.verdict,
      reason: typeof parsed.reason === 'string' && parsed.reason.trim()
        ? parsed.reason.trim()
        : parsed.verdict,
    }
  } catch {
    return malformedAssessment(raw, assistantText)
  }
}

// attempt 从 1 起。第一次是温和提醒；再次撞上说明温和版没用（模型正卡在「复述计划」的
// 循环里），此时改为硬性约束：这一轮的第一个动作必须是工具调用，禁止任何前言。
export function buildCommitmentDirective(reason: string, attempt = 1): string {
  const lines = [
    '<system-reminder>',
    `You are ending the turn with an unfulfilled action commitment: ${reason}`,
  ]

  if (attempt <= 1) {
    lines.push(
      'Do not describe the plan again. Create or update structured task tracking when available,',
      'then immediately perform the promised actions with tools.',
    )
  } else {
    lines.push(
      `This is attempt ${attempt}: you have now restated the plan ${attempt} times without calling a single tool.`,
      'Restating it again is a failure. The FIRST thing in your next message must be a tool call —',
      'no preamble, no recap of memories or dates, no re-listing of what remains. One concrete action,',
      'right now, on the very next step. Prose before the tool call is the bug you are stuck in.',
      'Do not re-read files you have already read; act on what you know.',
    )
  }

  lines.push(
    'If execution genuinely requires user input, ask for the exact missing decision.',
    'If execution is blocked, report the concrete failed action and its evidence.',
    '</system-reminder>',
  )
  return lines.join('\n')
}

function malformedAssessment(raw: string, assistantText = ''): CompletionAssessment {
  return degradedAssessment(
    assistantText,
    `completion guard returned invalid output: ${raw.trim().slice(0, 160) || '(empty)'}`,
  )
}

function isCompletionVerdict(value: unknown): value is CompletionVerdict {
  return (
    value === 'complete' ||
    value === 'waiting_for_user' ||
    value === 'blocked' ||
    value === 'unfulfilled_commitment'
  )
}
