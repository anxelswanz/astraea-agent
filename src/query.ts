// ★ 核心 Query 循环 — Agent 的 think → act → observe → repeat
// 参考源码: claude-code-main/src/query.ts (queryLoop, 第 281-1732 行)
//
// 原版的复杂特性（compaction、fallback model、stop hooks、并发工具执行）
// 全部省略，只保留最核心的 while(true) Agent 循环

import { streamMessage } from './api/stream'
import type { StreamEvent } from './types/message'
import {
  type AssistantMessage,
  type TextBlock,
  type ToolResultBlock,
  type ToolUseBlock,
  type UserMessage,
  contextInputTokens,
} from './types/message'
import type { Tool, ToolSchema, ToolContext } from './tools/Tool'
import { findTool } from './tools/registry'
import { validateToolInput } from './tools/validateInput'
import {
  initPhoenix,
  createTrace,
  endTrace,
  recordLLMObservation,
  recordToolObservation,
  type PhoenixTrace,
} from './observability/phoenix'
import { getMode } from './state/sessionMode'
import { yieldMissingToolResultBlocks } from './utils/messages'
import {
  getSystemContext,
  getUserContext,
  appendSystemContext,
  prependUserContext,
} from './context/session-preamble'

import {
  createBudgetTracker,
  recordTurnTokens,
  checkTokenBudget,
} from './utils/token-budget'

import { loadMemoryIndex, buildRelevantMemoriesReminder } from './memory/inject'
import { forceExtractMemories, maybeExtractMemories, noteExtractionTurn, clampExtractCursor } from './memory/extract'
import { drainNotifications, hasPendingNotifications } from './services/notification-queue'
import { drainInterjects, hasPendingInterjects } from './services/interject-queue'
import { hasRunningAgents } from './services/agent-state'
import { getTodos, type Todo } from './services/todo-state'
import { recordToolEvidence, getToolEvidence } from './services/evidence-registry'
import { buildReplanDirective } from './services/task-graph'
import { getTaskRecords } from './tools/TaskCreateTool'
import {
  getActiveGoal,
  recordGoalEvaluation,
  markGoalAchieved,
  clearGoal,
  isGoalStalled,
  GOAL_MAX_TURNS,
  GOAL_MAX_TOKEN_SPEND,
} from './state/goalState'
import { critiqueGoalEvidence, evaluateGoal, serializeTranscript } from './services/goal-evaluator'
import {
  assessCompletion,
  buildCommitmentDirective,
  type CompletionAssessment,
} from './services/completion-guard'
import { isAbortError } from './utils/abortError'

import { config, activeContextWindow } from './config'
import { getCommands } from './commands/registry'
import { buildSkillMenu } from './commands/menu'
import { activeThresholds } from './services/compact/window'
import { compactConversation, estimateTokens, isOverflowError } from './services/compact/compact'
import { microcompact } from './services/compact/microCompact'
import { recordAssistantTs } from './state/microcompactState'
import {
  getInputTokens,
  recordInputTokens,
  recordCompactionResult,
  recordCompactionFailure,
  isCompactionTripped,
} from './state/contextTokens'
import {
  eclipseActive,
  projectForSend,
  maybeSpawn,
  commitIfNeeded,
  blockingIfNeeded,
  drainOnOverflow,
  resetEclipse,
} from './services/eclipse/eclipse'

// ─────────────────────────── 事件类型 ───────────────────────────────────────

// QueryEvent 是 StreamEvent 的超集：增加了 turn_start、tool_result、budget_stop
export type QueryEvent =
  | StreamEvent
  // 可观测性根 trace 已开：带出 W3C traceId，供调用方回挂 Langfuse score / 关联外部 eval。
  // 仅在 Phoenix/Langfuse 实际激活时发一次；未启用时整个事件不出现。
  | { type: 'trace_start'; traceId: string; sessionId: string }
  | { type: 'turn_start'; turn: number; flushPrev: boolean }
  | { type: 'tool_progress'; id: string; name: string; chunk: string }
  | { type: 'tool_result'; id: string; name: string; input: Record<string, unknown>; output: string; isError: boolean }
  | { type: 'max_turns_reached'; maxTurns: number }
  | { type: 'budget_stop'; reason: 'budget_reached' | 'diminishing_returns'; totalTokens: number }
  // /goal Stop-hook：每个 turn 结束后 evaluator 的裁决
  | { type: 'goal_evaluated'; met: boolean; reason: string; condition: string; turns: number }
  // /goal 撞安全闸被强制停止。cause 区分原因：turn 上限 / token 天花板 / 停滞。
  | { type: 'goal_exhausted'; reason: string; condition: string; cause: 'turns' | 'tokens' | 'stall'; maxTurns: number; maxTokens: number }
  // ── 上下文压缩（autocompact）事件 ──
  | { type: 'compact_start'; trigger: 'auto' | 'manual'; preTokens: number }
  | { type: 'compact_progress'; chars: number }
  | { type: 'compact_done'; trigger: 'auto' | 'manual'; willRetrigger: boolean; messages: (UserMessage | AssistantMessage)[]; summary: string; preTokens: number }
  | { type: 'compact_failed'; reason: string }
  | { type: 'compact_tripped' }    // 熔断跳闸：停止自动压缩，提示用户手动处理
  | { type: 'compact_blocked'; usedTokens: number }  // autocompact 关闭 + 撞 0.98 硬阻塞
  | { type: 'done'; messages: (UserMessage | AssistantMessage)[] }

// ─────────────────────────── 参数类型 ───────────────────────────────────────

export interface QueryOptions {
  system?: string
  maxTurns?: number          // 默认 50，防无限循环（探索类任务 10 太低会腰斩）
  enablePromptCaching?: boolean
  cwd?: string               // 用于 session preamble 的工作目录（默认 process.cwd()）
  tokenBudget?: number | null  // 输出 token 预算上限（null = 无限制）
  agentId?: string             // 用于调试追踪哪个 agent 触发了停止
  abortSignal?: AbortSignal    // ESC 取消信号
  isInteractive?: boolean      // 是否有交互式用户在场（默认 true）。false → 工具遇 ask fail-closed deny
  // 仅主对话开启：发请求前 autocompact 检查 + token 计数 + 反应式溢出兜底（设计文档 §3/§6/§8）。
  // App 的辅助 query 调用（welcome/mode 等）不开启，避免污染主对话的 token 单例。
  autocompact?: boolean
  // 单次模型覆盖（skill frontmatter 的 model 经此 per-query 生效，实现文档 §1.6）。缺省用全局 config。
  model?: string
  completionAssessor?: (input: {
    userText: string
    assistantText: string
    signal?: AbortSignal
  }) => Promise<CompletionAssessment>
}

// 任务追踪提醒（对照 Claude Code TODO_REMINDER_CONFIG）：连续 N 轮没用过 TodoWrite 就注入
// 一次轻提醒；两次提醒之间也至少隔 N 轮，避免长任务里反复刷屏。10 轮的阈值本身就是过滤器——
// 简单任务 1~2 轮就结束，根本到不了 10 轮，只有真正的长任务才会被提醒。
const TODO_REMINDER_TURNS_SINCE_WRITE = 10
const TODO_REMINDER_TURNS_BETWEEN = 10

// ─────────────────────────── 主函数 ─────────────────────────────────────────

export async function* query(
  initialMessages: (UserMessage | AssistantMessage)[],
  tools: Tool[],
  options: QueryOptions = {},
): AsyncGenerator<QueryEvent> {
  // ── Phoenix 可观测性（路线 B）─────────────────────────────────────────────
  // 每个 query() 调用 = 用户一个 turn = 一个 AGENT 根 trace。initPhoenix 幂等，
  // 覆盖所有入口（CLI/REPL/headless/子 agent）；未启用或未装依赖时全 no-op。
  // 把根 trace 句柄穿线传给 runQuery，再由它注入 ToolContext 与各调用点。
  await initPhoenix()
  const phoenixTrace = createTrace({
    sessionId: options.agentId ?? 'default',
    input: latestUserText(initialMessages),
  })
  // 把 traceId 吐给调用方：这是给 trace 挂 Langfuse score 的唯一入口
  // （langfuse.score.create({ traceId, … })）。未启用可观测性时不发，消费方无需改动。
  if (phoenixTrace?.traceId) {
    yield { type: 'trace_start', traceId: phoenixTrace.traceId, sessionId: phoenixTrace.sessionId }
  }
  let phoenixStatus: 'error' | undefined
  try {
    yield* runQuery(initialMessages, tools, options, phoenixTrace)
  } catch (e) {
    phoenixStatus = 'error'
    throw e
  } finally {
    // 无论正常 done / return / 抛错 / 被上层中断，都在此收口关根 span（单点收尾）
    endTrace(phoenixTrace, undefined, phoenixStatus)
  }
}

async function* runQuery(
  initialMessages: (UserMessage | AssistantMessage)[],
  tools: Tool[],
  options: QueryOptions = {},
  phoenixTrace: PhoenixTrace | null = null,
): AsyncGenerator<QueryEvent> {
  const maxTurns = options.maxTurns ?? 50
  // 当 /goal 激活时，正常的 maxTurns 会过早截断目标循环。目标循环改用更高的
  // GOAL_MAX_TURNS 作为硬上限（condition 自带的 turn/time 子句由 evaluator 判定）。
  const turnCap = () => (getActiveGoal() ? Math.max(maxTurns, GOAL_MAX_TURNS) : maxTurns)
  const cwd = options.cwd ?? process.cwd()
  const budget = options.tokenBudget ?? null
  const agentId = options.agentId ?? 'default'
  const completionAssessor = options.completionAssessor ?? assessCompletion

  // 每个 query() 调用创建独立的 tracker，防止跨调用（父/子 agent）间的 token 计数污染
  let tracker = createBudgetTracker(agentId)

  // 把 Tool[] 转成 API 需要的 ToolSchema[]
  const toolSchemas: ToolSchema[] = tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }))

  // 周期性 TodoWrite 提醒只在本次 query 实际暴露了 TodoWrite 工具时生效（辅助 query / 没有
  // 该工具的子 agent 不注入）。TodoWriteTool 用 ctx.agentId ?? 'main' 作命名空间，这里对齐。
  const todoToolAvailable = tools.some(t => t.name === 'TodoWrite')
  const todoNamespace = options.agentId ?? 'main'

  // ── Session Preamble ──────────────────────────────────────────────────────
  // Both calls are memoized at Promise level — safe to call concurrently and
  // multiple times; the underlying I/O runs exactly once per process lifetime.
  const [sysCtx, userCtx] = await Promise.all([
    getSystemContext(),
    getUserContext(cwd),
  ])

  let system = appendSystemContext(options.system ?? '', sysCtx)

  // ── 渐进式披露：skill 一级菜单（实现文档 §1.4）──────────────────────────────
  // 仅当本次 query 暴露了 Skill 工具时注入（子 agent 无 Skill 工具 → 不浪费 token）。
  // 菜单会话内稳定 → 进可缓存系统提示前缀。
  if (tools.some(t => t.name === 'Skill')) {
    const menu = buildSkillMenu(getCommands(cwd), activeContextWindow())
    if (menu) system = `${system}\n\n${menu}`
  }

  // <system-reminder>（AGENTS + 日期）每轮为模型调用「新鲜注入」，但【不】持久进对话数组，
  // 否则会逐轮在头部累积、膨胀上下文。取出 reminder 块，对话数组保持干净。
  const reminderBlock = prependUserContext([], userCtx)[0]!
  // 定稿 #10：MEMORY.md 索引走 reminder 块（每 query 调用新鲜读，反映会内写入）。
  const memIndex = await loadMemoryIndex(cwd)
  if (memIndex && typeof reminderBlock.content === 'string') {
    reminderBlock.content += `\n\n<system-reminder>\n${memIndex}\n</system-reminder>`
  }
  const reminderChars = typeof reminderBlock.content === 'string' ? reminderBlock.content.length : 0

  // 压缩用：系统 prompt + 工具定义 + reminder 的固定开销（每轮都在、压缩腾不掉）。chars/4 估算。
  // 仅当调用方显式 opt-in（主对话）时启用压缩相关逻辑，避免辅助 query 污染 token 单例。
  const compactionEnabled = options.autocompact === true
  // 记忆提取（通道 B）只在主对话开（与 compaction 同一「主对话 opt-in」信号），
  // 避免辅助/子 query 触发后台提取。
  const memoryExtractionOn = compactionEnabled
  const fixedOverheadTokens = Math.ceil(
    (system.length + JSON.stringify(toolSchemas).length + reminderChars) / 4,
  )

  // State: 每轮追加 assistantMessage + toolResultMessage。
  // 对话数组保持干净（剥掉任何历史遗留的 reminder）；reminder 仅在 streamMessage 调用时前置。
  let messages: (UserMessage | AssistantMessage)[] = stripReminders([...initialMessages])
  let turnCount = 1
  // Todo 收尾 Stop-hook 只提醒一次，避免模型反复留尾导致死循环
  let todoNudged = false
  // TaskGraph re-plan Stop-hook（改动②）同样只提醒一次，绝不死循环
  let taskGraphNudged = false
  // 自然语言行动承诺只桥接一次；唤回后要求模型转入 Todo/Task 的结构化约束。
  let commitmentNudged = false
  // 周期性 TodoWrite 提醒的两个游标：lastTodoActivityTurn=0 表示「尚未用过」，到第 N 轮即
  // 触发首次提醒；lastTodoReminderTurn 让两次提醒至少隔 N 轮（详见 TODO_REMINDER_* 常量）。
  let lastTodoActivityTurn = 0
  let lastTodoReminderTurn = 0

  // 定稿 #10/#12/#13：召回 ≤5 条相关记忆，拼到用户消息尾部（逐消息变，远离缓存前缀）。
  // 每 query 调用跑一次（= 每条用户消息）；optional，失败/零记忆返回 null 不阻塞。
  // recentTools 去噪：正用某工具时别召该工具用法、但召它的坑。
  const recallSignal = options.abortSignal ?? new AbortController().signal
  const recallResult = await buildRelevantMemoriesReminder(
    latestUserText(messages),
    cwd,
    recallSignal,
    recentToolNames(messages),
  )
  const relevantTail: UserMessage | null = recallResult
    ? { role: 'user', content: recallResult.reminder }
    : null

  // counsel 模式（Permission & Safety Technical Spec §7）：与 orbit 对称，框架层无条件
  // 硬拦截一切「非只读」工具——counsel 自身永远只读，不存在「确认后就地放开写权限」。
  // 模型唯一的逃生口是调用 ExitCounselMode：请求用户授权后 setMode('cruise')，此后才在
  // cruise 模式下获得执行权。因此这里不再保留任何「确认即放行」的本地闸变量。

  // 反应式溢出兜底：每个 query() 调用最多触发一次，防止重试死循环。
  let reactiveCompacted = false
  // max_tokens 续写时本轮文本要与下一轮无缝拼接，不能在轮边界被落盘切成两段气泡。
  // 该标志让紧随其后的 turn_start 跳过 UI 的 flushAssistant；其余轮边界正常分段。
  let suppressNextFlush = false

  while (true) {
    yield { type: 'turn_start', turn: turnCount, flushPrev: !suppressNextFlush }
    suppressNextFlush = false

    // ── 0a. Microcompact（先轻后重：排在 autocompact 之前；仅主对话）──────────
    // time-based：离开 ≥ 阈值分钟后回来时，清空旧 tool 输出（保留骨架 + 最近 N 个）。
    // 纯机械、不调模型。清理后用本地估算覆写 token 单例，让下面的 autocompact 检查读到
    // 变小后的数——若已压回阈下，autocompact 本轮即 no-op，保住细粒度上下文。
    if (compactionEnabled) {
      const mc = microcompact(messages)
      if (mc.cleared) {
        messages = mc.messages
        clampExtractCursor(messages.length) // 压缩重建消息数组后夹住提取游标（连带前置 #3）
        recordInputTokens(estimateTokens(messages) + fixedOverheadTokens)
      }
    }

    // ── 0. Autocompact 检查（发请求前；仅主对话）────────────────────────────
    if (compactionEnabled) {
      const used = getInputTokens()
      if (used !== null) {
        const th = activeThresholds()
        if (config.autocompact) {
          // Eclipse 开启时压制【主动】autocompact（设计文档：折叠接管 0.85~0.95 带，防 autocompact
          // 抢跑把细粒度一刀切）。reactive（413 兜底）不查 eclipseActive，仍能接溢出。
          if (used >= th.autocompact && !isCompactionTripped() && !eclipseActive()) {
            yield { type: 'compact_start', trigger: 'auto', preTokens: used }
            try {
              const res = yield* compactConversation(messages, {
                trigger: 'auto',
                fixedOverheadTokens,
                signal: options.abortSignal,
              })
              if (res.compacted) {
                messages = res.messages
                clampExtractCursor(messages.length) // 压缩重建消息数组后夹住提取游标（连带前置 #3）
                recordInputTokens(estimateTokens(messages) + fixedOverheadTokens)
                recordCompactionResult(res.willRetrigger ?? false)
                yield { type: 'compact_done', trigger: 'auto', willRetrigger: res.willRetrigger ?? false, messages: res.messages, summary: res.summary ?? '', preTokens: res.preTokens ?? 0 }
                if (isCompactionTripped()) yield { type: 'compact_tripped' }
              }
            } catch (err: unknown) {
              if (isAbortError(err, options.abortSignal)) {
                yield { type: 'done', messages }
                return
              }
              recordCompactionFailure()
              yield { type: 'compact_failed', reason: String(err) }
              if (isCompactionTripped()) yield { type: 'compact_tripped' }
              // 压缩失败：继续发请求，可能溢出 → 反应式兜底
            }
          }
        } else if (used >= th.blocking) {
          // autocompact 关闭：撞 0.98 硬阻塞 → 拦住请求，要用户手动 /compact
          yield { type: 'compact_blocked', usedTokens: used }
          yield { type: 'done', messages }
          return
        }
      }
    }

    // ── 0b. Eclipse 折叠（发请求前；仅主对话，feature-gated，关闭时全 no-op）──────
    // commit：到 0.85 吃后台 staged 存货、低 risk 先折（非阻塞，无模型调用）。
    // blocking：到 0.95 存货不够 → 当场同步现折，主线程必须等完才放行。
    // 提交只改 Eclipse store；真正瘦身发生在下方 streamMessage 的 projectForSend()。
    if (compactionEnabled) {
      commitIfNeeded(messages, fixedOverheadTokens)
      await blockingIfNeeded(messages, fixedOverheadTokens, options.abortSignal)
    }

    // ── 1. 调用模型，收集流式事件 ──────────────────────────────────────────
    const contentBlocks: (TextBlock | ToolUseBlock)[] = []
    const toolUseBlocks: ToolUseBlock[] = []
    let turnOutputTokens = 0
    // 截断追踪：撞输出上限时模型停止原因 = 'max_tokens'；被截断在工具调用中途的 id 进 set
    let stopReason: import('./types/message').StopReason | undefined
    const incompleteToolIds = new Set<string>()

    // assistantMessage 在流结束前先设为 null，用于错误恢复
    let assistantMessage: AssistantMessage | null = null

    // Phoenix LLM span 计时：startTime=请求前；completionStartTime=首个内容事件（TTFT）；usage 在 message_stop 落定
    const llmStartTime = new Date()
    let llmFirstTokenAt: Date | undefined
    let llmUsage: { input_tokens: number; output_tokens: number } = { input_tokens: 0, output_tokens: 0 }
    const llmInputSnapshot = projectForSend(messages)

    try {
      // Cache-friendly ordering: stable conversation history stays first; volatile reminders
      // (AGENTS/date/MEMORY index) sit near the tail, and per-request memory recall remains last.
      for await (const event of streamMessage([...llmInputSnapshot, reminderBlock, ...(relevantTail ? [relevantTail] : [])], {
        system,
        enablePromptCaching: options.enablePromptCaching,
        tools: toolSchemas.length > 0 ? toolSchemas : undefined,
        abortSignal: options.abortSignal,
        model: options.model,
      })) {
        // 透传给上层（CLI 渲染）
        yield event

        // TTFT：记录首个内容事件时刻
        if (!llmFirstTokenAt && (event.type === 'text' || event.type === 'tool_use')) {
          llmFirstTokenAt = new Date()
        }

        // 同时收集内容，用于构建 AssistantMessage
        if (event.type === 'text') {
          const last = contentBlocks.at(-1)
          if (last?.type === 'text') {
            // 合并相邻的 text block
            last.text += event.text
          } else {
            contentBlocks.push({ type: 'text', text: event.text })
          }
        } else if (event.type === 'tool_use') {
          const block: ToolUseBlock = {
            type: 'tool_use',
            id: event.id,
            name: event.name,
            input: event.input,
          }
          contentBlocks.push(block)
          toolUseBlocks.push(block)
          if (event.incomplete) incompleteToolIds.add(event.id)
        } else if (event.type === 'message_stop') {
          turnOutputTokens = event.usage.output_tokens
          stopReason = event.stopReason
          llmUsage = event.usage
          // 触发用聚合 input_tokens（仅主对话）：记最近一次响应的真值，供下轮阈值检查。
          // 必须用三项 input 之和（input + cache_read + cache_creation）：开缓存后
          // input_tokens 只剩本轮新增，绝大部分上下文跑到 cache_read 里，只取它会严重低估。
          if (compactionEnabled) {
            recordInputTokens(contextInputTokens(event.usage))
            // Microcompact time-based 触发用：记下这一刻为"最后一条 assistant 时间"。
            recordAssistantTs()
            // Eclipse 后台 spawn：token 增量+起步闸触发（fire-and-forget，不阻塞本轮）。
            maybeSpawn(messages, options.abortSignal)
          }
        }
      }
    } catch (err: unknown) {
      // ESC 中止：保存部分消息后干净退出，不抛给调用方。
      // 注意：SDK 把流式 abort 包成 APIUserAbortError（name='Error'，message='Request was aborted.'），
      // 不是原生 'AbortError'，必须用 isAbortError 统一识别，否则中止会被误当真错误冒泡。
      if (isAbortError(err, options.abortSignal)) {
        // 只有当部分助手消息含可见内容（文本或工具调用）才落盘。空 content 的 assistant
        // 消息会让下游 provider 报 400（OpenAI 兼容："content or tool_calls must be set"）。
        // 例如中止恰好落在 reasoning-only 片段、文本/工具尚未产出时。— eval Item 15
        const hasText = contentBlocks.some(b => b.type === 'text' && b.text.trim().length > 0)
        const hasToolUse = contentBlocks.some(b => b.type === 'tool_use')
        if (hasText || hasToolUse) {
          const partial: AssistantMessage = { role: 'assistant', content: contentBlocks }
          // 中止时 tool_use 已发出但工具尚未执行 → 补「已取消」占位 tool_result，否则
          // tool_use/tool_result 不配对，下次（如「continue your work」）请求同样 400。
          const cancelResults = hasToolUse
            ? [...yieldMissingToolResultBlocks(partial, 'Tool call interrupted — cancelled by user before it ran.')]
            : []
          yield { type: 'done', messages: [...messages, partial, ...cancelResults] }
        } else {
          yield { type: 'done', messages }
        }
        return
      }
      // Eclipse 溢出急救（drain-then-reactive）：先排空 staged 折叠腾空间，静默重试本轮
      // （projectForSend 会应用新折叠，prompt 变瘦，保细粒度）。没存货可排则落到 reactive 全量压缩。
      if (compactionEnabled && isOverflowError(err) && eclipseActive()) {
        if (drainOnOverflow().length > 0) continue
      }
      // 反应式溢出兜底：请求因上下文超窗口被拒 → 强制压缩一次 → 重试本轮（设计文档 §8）。
      // 溢出在请求阶段发生，contentBlocks 此时为空，丢弃重试安全。每个 query() 调用至多一次。
      if (compactionEnabled && isOverflowError(err) && !reactiveCompacted && !isCompactionTripped()) {
        reactiveCompacted = true
        yield { type: 'compact_start', trigger: 'auto', preTokens: getInputTokens() ?? estimateTokens(messages) }
        try {
          const res = yield* compactConversation(messages, {
            trigger: 'auto',
            fixedOverheadTokens,
            signal: options.abortSignal,
          })
          if (res.compacted) {
            messages = res.messages
            clampExtractCursor(messages.length) // 压缩重建消息数组后夹住提取游标（连带前置 #3）
            resetEclipse() // 全量压缩后消息已重建，旧折叠施工图作废，清空 store
            recordInputTokens(estimateTokens(messages) + fixedOverheadTokens)
            recordCompactionResult(res.willRetrigger ?? false)
            yield { type: 'compact_done', trigger: 'auto', willRetrigger: res.willRetrigger ?? false, messages: res.messages, summary: res.summary ?? '', preTokens: res.preTokens ?? 0 }
          }
          continue // 重试本轮（turnCount 不变）
        } catch (e2: unknown) {
          if (isAbortError(e2, options.abortSignal)) {
            yield { type: 'done', messages }
            return
          }
          recordCompactionFailure()
          yield { type: 'compact_failed', reason: String(e2) }
          // 落到下面常规错误处理
        }
      }
      // API 调用出错：如果已经收到了带 tool_use 的 assistant 消息，
      // 需要补齐 tool_result，否则下次 API 调用会因不配对而报 400
      if (toolUseBlocks.length > 0) {
        const partialAssistant: AssistantMessage = { role: 'assistant', content: contentBlocks }
        const errorMsg = `API error during tool execution: ${String(err)}`
        const errorResults = [...yieldMissingToolResultBlocks(partialAssistant, errorMsg)]
        // 追加到历史，让调用方知道这轮中断了
        messages = [...messages, partialAssistant, ...errorResults]
      }
      throw err
    }

    // ── 2. 构建 AssistantMessage ───────────────────────────────────────────
    assistantMessage = {
      role: 'assistant',
      content: contentBlocks,
    }

    // ── 2·Phoenix：记录本次 LLM 调用为一个 LLM span（挂在根 trace 下）──────────
    // 仅成功完流才到这里（中止/溢出在上面的 catch 已 return/continue，不误记）。
    recordLLMObservation(phoenixTrace, {
      input: llmInputSnapshot,
      output: contentBlocks,
      usage: llmUsage,
      model: options.model,
      startTime: llmStartTime,
      endTime: new Date(),
      completionStartTime: llmFirstTokenAt,
    })

    // ── 2a. 更新预算追踪器并检查是否达到停止条件 ──────────────────────────
    tracker = recordTurnTokens(tracker, turnOutputTokens)
    const budgetDecision = checkTokenBudget(tracker, budget)
    if (budgetDecision.action === 'stop') {
      yield {
        type: 'budget_stop',
        reason: budgetDecision.reason,
        totalTokens: tracker.lastGlobalTurnTokens,
      }
      yield { type: 'done' as const, messages: [...messages, assistantMessage] }
      return
    }

    // ── 3. 无工具调用 → 检查是否有后台 Agent 仍在运行 ─────────────────────
    if (toolUseBlocks.length === 0) {
      // 纯文本输出撞了 max_tokens 被截断 → 注入续写指令，让模型从断点接着写，
      // 而不是把半截内容当成最终答复交还用户。turnCap 仍是硬上限，不会无限续。
      if (stopReason === 'max_tokens' && turnCount < turnCap()) {
        const continueMsg: UserMessage = {
          role: 'user',
          ephemeral: true,
          content: [{ type: 'text', text: buildContinuationDirective() }],
        }
        messages = [...messages, assistantMessage, continueMsg]
        turnCount++
        suppressNextFlush = true  // 续写紧接前文 → 下一轮 turn_start 不落盘，保持单气泡
        continue
      }

      const immediateNotifs = drainNotifications()
      // 拾取点 A·纯文本轮：模型本轮无工具调用，把插队指令作为新一轮 user 消息注入并续跑。
      // UI 侧靠 turn_start 事件先把本轮助手文本落盘，避免下一轮文本与本轮回复粘连（边界1）。
      const immediateInterjects = drainInterjects()

      if (immediateNotifs.length > 0 || immediateInterjects.length > 0) {
        // Notifications and/or user interjections arrived this turn — feed them to the model
        const waitMsg: UserMessage = {
          role: 'user',
          content: [
            ...immediateNotifs.map(n => ({ type: 'text' as const, text: n })),
            ...immediateInterjects.map(buildInterjectBlock),
          ],
        }
        messages = [...messages, assistantMessage, waitMsg]
        if (turnCount >= turnCap()) {
          yield { type: 'max_turns_reached', maxTurns: turnCap() }
          yield { type: 'done' as const, messages }
          return
        }
        turnCount++
        continue
      }

      if (hasRunningAgents()) {
        // Agents still running but no notifications yet — poll without calling model
        // This avoids burning tokens while idle-waiting
        while (
          hasRunningAgents() &&
          !hasPendingNotifications() &&
          !hasPendingInterjects() &&
          !options.abortSignal?.aborted
        ) {
          await Bun.sleep(200)
        }
        if (options.abortSignal?.aborted) {
          yield { type: 'done', messages: [...messages, assistantMessage] }
          return
        }
        // Re-enter the loop: notifications, interjections, or agent completion woke us
        const freshNotifs = drainNotifications()
        const freshInterjects = drainInterjects()
        if (freshNotifs.length > 0 || freshInterjects.length > 0) {
          const waitMsg: UserMessage = {
            role: 'user',
            content: [
              ...freshNotifs.map(n => ({ type: 'text' as const, text: n })),
              ...freshInterjects.map(buildInterjectBlock),
            ],
          }
          messages = [...messages, assistantMessage, waitMsg]
          if (turnCount >= turnCap()) {
            yield { type: 'max_turns_reached', maxTurns: turnCap() }
            yield { type: 'done' as const, messages }
            return
          }
          turnCount++
          continue
        }
      }

      // ── /goal Stop-hook ──────────────────────────────────────────────────
      // 真正的停止点：无工具调用、无待处理通知、无运行中 agent。若有激活的目标，
      // 在交还控制权前先让 evaluator 裁决；未达成则注入"继续"指令并再跑一轮。
      const goal = getActiveGoal()
      if (goal) {
        const transcript = serializeTranscript([...messages, assistantMessage])
        let decision: { met: boolean; reason: string }
        try {
          decision = await evaluateGoal(goal.condition, transcript)
        } catch (err: unknown) {
          // evaluator 出错不应让目标崩溃：保守判未达成并继续
          decision = { met: false, reason: `evaluator error: ${String(err)} — continuing` }
        }
        if (decision.met) {
          try {
            // 改动①：把 evidence-registry 里的真值（未截断的工具输出）一并喂给 critique，
            // 而不是只给截断到 16k 的 transcript —— 长任务里早期的 exit code 不再丢失。
            const critique = await critiqueGoalEvidence(
              goal.condition,
              transcript,
              getToolEvidence(todoNamespace),
            )
            if (!critique.pass) {
              const findings = critique.findings
                .map(f => `${f.kind}: ${f.detail}`)
                .join('; ')
              decision = {
                met: false,
                reason: findings
                  ? `evidence critique failed: ${critique.reason} Findings: ${findings}`
                  : `evidence critique failed: ${critique.reason}`,
              }
            }
          } catch (err: unknown) {
            decision = { met: false, reason: `evidence critique error: ${String(err)} — continuing` }
          }
        }
        recordGoalEvaluation(decision.reason, tracker.lastGlobalTurnTokens)
        const updated = getActiveGoal()
        const turnsSoFar = updated?.turnsEvaluated ?? goal.turnsEvaluated + 1

        yield {
          type: 'goal_evaluated',
          met: decision.met,
          reason: decision.reason,
          condition: goal.condition,
          turns: turnsSoFar,
        }

        // 撞闸判定：turn 上限（硬）→ token 天花板（成本）→ 停滞（无进展）。
        const spend = updated?.tokenSpend ?? 0
        const exhaustCause: 'turns' | 'tokens' | 'stall' | null =
          turnsSoFar >= GOAL_MAX_TURNS ? 'turns'
          : spend >= GOAL_MAX_TOKEN_SPEND ? 'tokens'
          : isGoalStalled() ? 'stall'
          : null

        if (decision.met) {
          // 达成 → 记录"已达成"并清除目标，正常交还控制权
          markGoalAchieved(decision.reason)
        } else if (exhaustCause) {
          // 撞安全闸 → 强制停止，清除目标，提示用户（cause 区分原因）
          clearGoal()
          yield {
            type: 'goal_exhausted',
            reason: decision.reason,
            condition: goal.condition,
            cause: exhaustCause,
            maxTurns: GOAL_MAX_TURNS,
            maxTokens: GOAL_MAX_TOKEN_SPEND,
          }
        } else {
          // 未达成 → 注入继续指令，再跑一轮（不交还控制权）
          const directive: UserMessage = {
            role: 'user',
            ephemeral: true,
            content: [{ type: 'text', text: buildGoalDirective(goal.condition, decision.reason) }],
          }
          messages = [...messages, assistantMessage, directive]
          turnCount++
          continue
        }
      }

      // ── Todo 收尾 Stop-hook ──────────────────────────────────────────────
      // 真正停止点：模型给最终回复、无 tool call。若 todo 列表里仍有未完成项
      // （常见根因：干完活忘了发收尾 TodoWrite），注入一次提醒并再跑一轮，逼模型
      // 把状态对齐——标 completed 让「所有任务已完成」可靠触发，或明确告诉用户还剩什么。
      // 仅主对话（compactionEnabled）生效，仅提醒一次，受 turnCap 兜底，绝不死循环。
      if (compactionEnabled && !todoNudged) {
        const open = getTodos('main').filter(t => t.status !== 'completed')
        if (open.length > 0 && turnCount < turnCap()) {
          todoNudged = true
          const list = open.map(t => `  - [${t.status}] ${t.content}`).join('\n')
          const directive: UserMessage = {
            role: 'user',
            ephemeral: true,
            content: [{
              type: 'text',
              text:
                `<system-reminder>\nYou are ending your turn, but your todo list still has ` +
                `${open.length} unfinished task(s):\n${list}\n\n` +
                `If the work is genuinely done, call TodoWrite to mark them completed so the user ` +
                `gets a clear completion signal. If a task is truly not done, leave it as-is and ` +
                `tell the user explicitly what remains — never silently abandon an in_progress task.\n\n` +
                STALE_TASK_GUARD +
                `\n</system-reminder>`,
            }],
          }
          messages = [...messages, assistantMessage, directive]
          turnCount++
          continue
        }
      }

      // ── TaskGraph Stop-hook ───────────────────────────────────────────────
      // 真正停止点仍有 pending / blocked / in_progress / failed / invalidated 节点时，
      // 注入一次继续或重规划指令。和 todo 钩子同构：仅主对话生效、仅提醒一次，
      // 受 turnCap 兜底，绝不死循环。
      if (compactionEnabled && !taskGraphNudged && turnCount < turnCap()) {
        const directiveText = buildReplanDirective(getTaskRecords())
        if (directiveText) {
          taskGraphNudged = true
          const directive: UserMessage = {
            role: 'user',
            ephemeral: true,
            content: [{ type: 'text', text: directiveText }],
          }
          messages = [...messages, assistantMessage, directive]
          turnCount++
          continue
        }
      }

      // 模型可能只输出“开始执行”之类的 pre-action intent，却没有真正调用工具。
      // 结构化任务为空时 Goal/Todo/TaskGraph 都看不见这笔行动债务，因此在最终 done 前
      // 用一次语义分类把未兑现承诺桥接回下一轮，并要求后续转入结构化任务追踪。
      if (compactionEnabled && !commitmentNudged && turnCount < turnCap()) {
        const assistantText = assistantMessage.content
          .filter((block): block is TextBlock => block.type === 'text')
          .map(block => block.text)
          .join('')
        if (assistantText.trim()) {
          const assessment = await completionAssessor({
            userText: latestUserText(messages),
            assistantText,
            signal: options.abortSignal,
          })
          if (assessment.verdict === 'unfulfilled_commitment') {
            commitmentNudged = true
            const directive: UserMessage = {
              role: 'user',
              ephemeral: true,
              content: [{
                type: 'text',
                text: buildCommitmentDirective(assessment.reason),
              }],
            }
            messages = [...messages, assistantMessage, directive]
            turnCount++
            continue
          }
        }
      }

      // 通道 B 停止钩子（#26）：模型给出最终回复、无 tool call → 强制提取一次（尾随不节流）。
      // fire-and-forget，绝不阻塞交还控制权；失败/超时游标不动、下轮重试。
      if (memoryExtractionOn) {
        forceExtractMemories({ messages: [...messages, assistantMessage], system, cwd })
      }

      yield { type: 'done' as const, messages: [...messages, assistantMessage] }
      return
    }

    // ── 4. 执行所有工具调用（有 callStream 的工具顺序执行并 yield 进度，其余并行）────
    const toolResultBlocks: ToolResultBlock[] = []

    // 每轮工具执行前构建 ctx（mode 在执行过程中可能由 EnterOrbitMode/ExitOrbitMode 改变，
    // 因此在这里读取快照；单个工具调用内 mode 不变）
    const toolCtx: ToolContext = {
      mode: getMode(),
      agentId: options.agentId,
      abortSignal: options.abortSignal,
      isInteractive: options.isInteractive ?? true, // query() 是交互式 REPL 引擎，默认 true
      phoenixTrace, // 穿线：让 spawn 子 query 的工具（如 AgentTool）能把子 trace 挂在主 trace 下
    }

    // 分流式 vs 普通工具
    const streamingBlocks = toolUseBlocks.filter(b => !!findTool(b.name)?.callStream)
    const normalBlocks    = toolUseBlocks.filter(b => !findTool(b.name)?.callStream)

    // 普通工具按 isConcurrencySafe 分批：连续安全批并发，其余串行
    type NormalResult = { toolUse: typeof normalBlocks[0]; output: string; isError: boolean }
    const normalResults: NormalResult[] = []

    // 将 normalBlocks 切分为批次：相邻全为并发安全的合并一批，否则独立一批
    const batches: (typeof normalBlocks)[] = []
    for (const toolUse of normalBlocks) {
      const tool = findTool(toolUse.name)
      const safe = tool ? tool.isConcurrencySafe(toolUse.input) : false
      const lastBatch = batches[batches.length - 1]
      const lastSafe  = lastBatch
        ? findTool(lastBatch[0]!.name)?.isConcurrencySafe(lastBatch[0]!.input) ?? false
        : false
      if (safe && lastSafe && lastBatch) {
        lastBatch.push(toolUse)
      } else {
        batches.push([toolUse])
      }
    }

    for (const batch of batches) {
      const batchSafe = findTool(batch[0]!.name)?.isConcurrencySafe(batch[0]!.input) ?? false
      const runOne = async (toolUse: typeof batch[0]): Promise<NormalResult> => {
        // 被输出上限截断在中途的工具调用：入参残缺，执行 = 写空文件/错误状态。直接拒绝并提示分块重试。
        if (incompleteToolIds.has(toolUse.id)) {
          return { toolUse, output: truncatedToolError(toolUse.name), isError: true }
        }
        const tool = findTool(toolUse.name)
        if (!tool) return { toolUse, output: `Tool not found: "${toolUse.name}"`, isError: true }
        const ctx: ToolContext = { ...toolCtx, mode: getMode() }
        // 框架层 orbit 拦截：isReadOnly(input) 动态判断，false → 拦截写操作
        if (ctx.mode === 'orbit' && !tool.isReadOnly(toolUse.input)) {
          return {
            toolUse,
            output: `[orbit mode] ${tool.name} blocked — write operation not allowed. Use ExitOrbitMode to present your plan first.`,
            isError: true,
          }
        }
        // 框架层 counsel 拦截：与 orbit 对称，无条件禁止任何写/执行类工具。只读工具
        // （Read/Glob/Grep/AskUserQuestion…）放行，供模型先扫描项目并咨询用户。逃生口是
        // 调用 ExitCounselMode 请求授权切入 cruise——只有切到 cruise 后才能动手。
        if (ctx.mode === 'counsel' && !tool.isReadOnly(toolUse.input)) {
          return {
            toolUse,
            output: `[counsel mode] ${tool.name} blocked — counsel mode is read-only. First confirm the direction with the user via AskUserQuestion, then call ExitCounselMode to request permission to start executing. Once the user allows it, Astraea switches to cruise mode and writes are permitted.`,
            isError: true,
          }
        }
        // 入口统一参数校验（PR-1）：required/type/enum/items 基于工具自带 JSON Schema 拦截,
        // 失败返回可自我修正的结构化错误,不进入 call() —— 杜绝裸断言穿透成原始 TypeError。
        const invalidInput = validateToolInput(tool.name, tool.inputSchema, toolUse.input)
        if (invalidInput) {
          return { toolUse, output: invalidInput, isError: true }
        }
        const __phxStart = new Date()
        try {
          const result = await tool.call(toolUse.input, ctx)
          // Phoenix：记录这次工具执行为 TOOL span（input/output 已在 service 内脱敏）
          recordToolObservation(phoenixTrace, {
            toolName: tool.name,
            toolUseId: toolUse.id,
            input: toolUse.input,
            output: result.output,
            isError: result.isError ?? false,
            startTime: __phxStart,
          })
          // INTENT: TodoWrite may run later in the same assistant tool batch and cite
          // this tool_use id. Register evidence as soon as the individual tool finishes,
          // not after the whole batch drains, so same-turn proof is visible.
          recordToolEvidence(todoNamespace, {
            id: toolUse.id,
            tool: toolUse.name,
            output: result.output,
            isError: result.isError ?? false,
          })
          return { toolUse, output: result.output, isError: result.isError ?? false }
        } catch (err: unknown) {
          recordToolObservation(phoenixTrace, {
            toolName: tool.name,
            toolUseId: toolUse.id,
            input: toolUse.input,
            output: `Tool execution error: ${String(err)}`,
            isError: true,
            startTime: __phxStart,
          })
          return { toolUse, output: `Tool execution error: ${String(err)}`, isError: true }
        }
      }

      if (batchSafe) {
        normalResults.push(...await Promise.all(batch.map(runOne)))
      } else {
        for (const toolUse of batch) {
          normalResults.push(await runOne(toolUse))
        }
      }
    }

    // 流式工具顺序执行，每个 chunk 都 yield tool_progress
    const streamingResults: Array<{ toolUse: typeof toolUseBlocks[0]; output: string; isError: boolean }> = []
    for (const toolUse of streamingBlocks) {
      if (incompleteToolIds.has(toolUse.id)) {
        streamingResults.push({ toolUse, output: truncatedToolError(toolUse.name), isError: true })
        continue
      }
      const tool = findTool(toolUse.name)!
      const ctx: ToolContext = { ...toolCtx, mode: getMode() }
      let output: string
      let isError: boolean
      // 框架层 orbit 拦截（流式工具同样适用）
      if (ctx.mode === 'orbit' && !tool.isReadOnly(toolUse.input)) {
        streamingResults.push({
          toolUse,
          output: `[orbit mode] ${tool.name} blocked — write operation not allowed. Use ExitOrbitMode to present your plan first.`,
          isError: true,
        })
        continue
      }
      // 框架层 counsel 拦截（流式工具同样适用）：无条件只读，逃生口是 ExitCounselMode
      if (ctx.mode === 'counsel' && !tool.isReadOnly(toolUse.input)) {
        streamingResults.push({
          toolUse,
          output: `[counsel mode] ${tool.name} blocked — counsel mode is read-only. Confirm the direction via AskUserQuestion, then call ExitCounselMode to request switching to cruise before executing.`,
          isError: true,
        })
        continue
      }
      // 入口统一参数校验（PR-1）：与普通工具路径同一闸,流式工具同样不放过坏参数。
      const invalidStreamInput = validateToolInput(tool.name, tool.inputSchema, toolUse.input)
      if (invalidStreamInput) {
        streamingResults.push({ toolUse, output: invalidStreamInput, isError: true })
        continue
      }
      const __phxStreamStart = new Date()
      try {
        const gen = tool.callStream!(toolUse.input, ctx)
        let next: IteratorResult<string, import('./tools/Tool.js').ToolCallResult>
        do {
          next = await gen.next()
          if (!next.done && next.value) {
            yield { type: 'tool_progress', id: toolUse.id, name: toolUse.name, chunk: next.value }
          }
        } while (!next.done)
        output = next.value.output
        isError = next.value.isError ?? false
      } catch (err: unknown) {
        output = `Tool execution error: ${String(err)}`
        isError = true
      }
      // Phoenix：流式工具同样记一个 TOOL span
      recordToolObservation(phoenixTrace, {
        toolName: tool.name,
        toolUseId: toolUse.id,
        input: toolUse.input,
        output,
        isError,
        startTime: __phxStreamStart,
      })
      recordToolEvidence(todoNamespace, {
        id: toolUse.id,
        tool: toolUse.name,
        output,
        isError,
      })
      streamingResults.push({ toolUse, output, isError })
    }

    // 按原始顺序合并结果并 yield tool_result
    const allResults = [...normalResults, ...streamingResults].sort(
      (a, b) => toolUseBlocks.indexOf(a.toolUse) - toolUseBlocks.indexOf(b.toolUse),
    )

    for (const { toolUse, output, isError } of allResults) {
      yield { type: 'tool_result', id: toolUse.id, name: toolUse.name, input: toolUse.input, output, isError }
      toolResultBlocks.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: output,
        is_error: isError || undefined,
      })
    }

    // Build user message: tool_results + any pending task_notifications + user interjections.
    // 拾取点 A：工具批跑完、构建 tool_result message 时把队列里的插队指令追加为 text block。
    // 这是协议上唯一合法的落点——tool_use/tool_result 必须紧邻，不能在两者间插独立 user 消息。
    const pendingNotifs = drainNotifications()
    const pendingInterjects = drainInterjects()
    const extraTextBlocks: TextBlock[] = [
      ...pendingNotifs.map(n => ({ type: 'text' as const, text: n })),
      ...pendingInterjects.map(buildInterjectBlock),
    ]

    // counsel 强制注入：本轮出现了被只读闸拦截的写/执行操作
    // → 在下一轮的 user message 里追加强制指令，引导模型先咨询、再走 ExitCounselMode 授权
    const counselWasBlocked = getMode() === 'counsel' && allResults.some(
      r => r.isError && r.output.startsWith('[counsel mode]'),
    )
    if (counselWasBlocked) {
      extraTextBlocks.push({
        type: 'text',
        text: '[Counsel mode enforcement] Counsel mode is strictly read-only — your write/execute action was blocked. You cannot write or run commands here. MANDATORY path to execution: (1) use AskUserQuestion to confirm scope / approach / trade-offs with the user; (2) once the direction is clear, call ExitCounselMode with a brief summary to ask the user for permission. Only after the user allows it (Astraea then switches to cruise mode) may you write or run commands. Do NOT attempt any non-read-only tool until then.',
      })
    }

    // ── 周期性 TodoWrite 提醒（对照 Claude Code，解开旧死结）───────────────────
    // 本轮用过 TodoWrite → 刷新活跃游标；否则若连续 N 轮没用过、且距上次提醒也已 N 轮，
    // 注入一条 <system-reminder> 轻推。不再要求「已有未完成项」——那个条件配合「系统提示从不
    // 提 TodoWrite」会让清单恒为空、提醒永不触发。现在改成「该用却没用就提醒」。
    if (todoToolAvailable) {
      if (toolUseBlocks.some(b => b.name === 'TodoWrite')) {
        lastTodoActivityTurn = turnCount
      } else if (shouldRemindTodo(turnCount, lastTodoActivityTurn, lastTodoReminderTurn)) {
        lastTodoReminderTurn = turnCount
        extraTextBlocks.push(buildTodoReminderBlock(getTodos(todoNamespace)))
      }
    }

    // ── 5. 把 assistant + tool_results 追加到历史，进入下一轮 ──────────────
    const toolResultMessage: UserMessage = {
      role: 'user',
      content: [...toolResultBlocks, ...extraTextBlocks],
    }

    messages = [...messages, assistantMessage, toolResultMessage]

    // 通道 B 节奏（#26）：每个 turn 末推进节流计数；/goal 长跑中每 N turn 补一次增量提取，
    // 避免目标完成时面对超长 span 一次性复盘。fire-and-forget。
    if (memoryExtractionOn) {
      noteExtractionTurn()
      if (getActiveGoal()) maybeExtractMemories({ messages, system, cwd })
    }

    // ESC 中止（工具执行阶段）：完整保存本轮结果后停止
    if (options.abortSignal?.aborted) {
      yield { type: 'done', messages }
      return
    }

    // ── 6. maxTurns 保护 ───────────────────────────────────────────────────
    if (turnCount >= turnCap()) {
      yield { type: 'max_turns_reached', maxTurns: turnCap() }
      yield { type: 'done' as const, messages }
      return
    }

    turnCount++
  }
}

// 取最近一条**真实**用户消息的文本（跳过纯 tool_result 的 user 消息，以及引擎自己注入的
// 续跑指令）—— 召回的 query，也是 completionAssessor 判「承诺是否兑现」的对照基准。
// 若把 stop-hook 注入的 directive 当成用户输入，评估器会拿旧任务去比对新一轮工作，
// 判成 unfulfilled_commitment 并再注入一条指令，把模型拽回上一个任务（复读 bug 的放大器）。
export function latestUserText(msgs: (UserMessage | AssistantMessage)[]): string {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if (!m || m.role !== 'user') continue
    if (isEngineDirective(m)) continue
    if (typeof m.content === 'string') return m.content
    const texts = m.content.filter((b): b is TextBlock => b.type === 'text').map(b => b.text)
    if (texts.length > 0) return texts.join('\n')
  }
  return ''
}

// 近期 assistant 调过的工具名（去重，最多 limit 个）—— 喂给召回做 recentTools 去噪。
function recentToolNames(msgs: (UserMessage | AssistantMessage)[], limit = 8): string[] {
  const names: string[] = []
  for (let i = msgs.length - 1; i >= 0 && names.length < limit; i--) {
    const m = msgs[i]
    if (!m || m.role !== 'assistant') continue
    for (const b of m.content) {
      if (b.type === 'tool_use' && !names.includes(b.name)) names.push(b.name)
    }
  }
  return names
}

// 引擎注入的一次性指令判定。两条依据：
//   1. ephemeral 标记 —— 本进程注入时打的，最可靠；
//   2. 文本前缀兜底 —— 覆盖标记之前产生的历史消息（升级前的会话、transcript 回放），
//      以及任何漏打标的注入点。
// 只认「全部 text block 都是指令」的消息：混入 tool_result 或用户插话（<user_interjection>）
// 的消息一律保留，绝不误删真实输入。
const DIRECTIVE_PREFIXES = ['<system-reminder>', '[/goal]', '[system]']

export function isEngineDirective(m: UserMessage | AssistantMessage): boolean {
  if (m.role !== 'user') return false
  if (m.ephemeral === true) return true
  const isDirectiveText = (t: string) => DIRECTIVE_PREFIXES.some(p => t.startsWith(p))
  if (typeof m.content === 'string') return isDirectiveText(m.content)
  return (
    m.content.length > 0 &&
    m.content.every(b => b.type === 'text' && isDirectiveText(b.text))
  )
}

// 剥掉对话数组里引擎注入的一次性指令（reminder / stop-hook 续跑指令 / 截断续写指令）。
// 这些只对注入的那一轮有意义：留在历史里会被后续轮次当成「用户反复要求做旧任务」，
// 表现为「新任务做到一半停下，回头重做最早那个任务」。
export function stripReminders(
  msgs: (UserMessage | AssistantMessage)[],
): (UserMessage | AssistantMessage)[] {
  return msgs.filter(m => !isEngineDirective(m))
}

// ───────────────────── 陈旧任务守卫（所有 stop-hook 共用）─────────────────────
// stop-hook 只知道「清单里还有没做完的条目」，不知道用户早就换了话题。缺了这句，模型
// 会把上一段对话的残留任务当成当前指令，放下用户刚提的新问题回去重做旧任务。
export const STALE_TASK_GUARD =
  'IMPORTANT — check relevance first: if the user has since moved on to a different request, ' +
  'these leftover items are stale. Do NOT resume or restart them, and do not let them displace ' +
  "what the user just asked for. Finish the user's current request, and mention the unfinished " +
  'items in one line at the end (or drop them from the list) instead of acting on them.'

// ─────────────────────────── /goal 继续指令 ─────────────────────────────────
// 目标未达成时注入给模型的下一轮指令：把 condition 重申为指令，并带上
// evaluator 的理由作为针对性指引（对齐文档"includes the reason as guidance"）。
function buildGoalDirective(condition: string, reason: string): string {
  return [
    '[/goal] Your active goal is NOT yet satisfied — keep working, do not return control to the user.',
    '',
    'Goal condition:',
    condition,
    '',
    "Evaluator feedback (why it's not met yet):",
    reason,
    '',
    'Take the next concrete action toward the condition. Prove progress through your output ' +
      '(run the command, show the result, count the files). Do not ask for confirmation or stop ' +
      'until the condition is demonstrably met in the transcript. If you believe it is already met, ' +
      'state explicitly which evidence in your output proves it.',
    '',
    'Meet the condition by fixing the real problem — NEVER by weakening the check: do not comment out, ' +
      'delete, or skip failing tests, do not loosen assertions, do not disable lint/type rules, and do not ' +
      'edit the verification command into a weaker one. That will be detected and rejected as not met.',
  ].join('\n')
}

// ─────────────────────────── 截断恢复指令 ───────────────────────────────────
// 纯文本输出撞 max_tokens 被截断时注入：让模型从断点无缝续写。
function buildContinuationDirective(): string {
  return [
    '[system] Your previous message was cut off because it hit the output token limit — it is incomplete.',
    'Continue from exactly where you stopped. Do not repeat what you already wrote, do not restart, ' +
      'and do not apologize — just resume the next character as if there was no interruption.',
  ].join('\n')
}

// 用户在执行中途插队的指令 → 包成显式标签的 text block，与工具回报区分开。
// 模型据此知道这是「用户在你干活时插话」，应作为更高优先级的指令/澄清并入当前工作。
function buildInterjectBlock(text: string): TextBlock {
  return {
    type: 'text',
    text:
      '<user_interjection>\n' +
      'The user sent this while you were working. Treat it as a higher-priority instruction ' +
      'or clarification and fold it into what you are currently doing.\n\n' +
      text +
      '\n</user_interjection>',
  }
}

// 周期性提醒的纯判定：当前轮 vs「上次用 TodoWrite 的轮」「上次提醒的轮」。连续 N 轮没用过、
// 且距上次提醒也已 N 轮 → 该提醒。lastActivity=0 表示从未用过，到第 N 轮即触发首提。
export function shouldRemindTodo(
  turnCount: number,
  lastActivityTurn: number,
  lastReminderTurn: number,
): boolean {
  return (
    turnCount - lastActivityTurn >= TODO_REMINDER_TURNS_SINCE_WRITE &&
    turnCount - lastReminderTurn >= TODO_REMINDER_TURNS_BETWEEN
  )
}

// 周期性任务追踪提醒：连续多轮没用过 TodoWrite 时注入。文案对照 Claude Code——"gentle
// reminder, ignore if not applicable"，并叮嘱别向用户复述这条提醒。带上当前清单（若有），
// 让模型据实判断是补建、是更新、还是确实用不上。
function buildTodoReminderBlock(todos: Todo[]): TextBlock {
  let text =
    "<system-reminder>\n" +
    "You haven't used the TodoWrite tool recently. If the current task is multi-step or " +
    'spans several files, create or update a todo list so sub-tasks do not get dropped and ' +
    'the user can see progress — mark exactly one task in_progress, and flip each to completed ' +
    'only after it is verified done. Each todo must include acceptanceCriteria and verificationCommand; ' +
    'completed todos must cite successful tool result ids in evidenceRefs. This is a gentle reminder; ignore it if the task is simple ' +
    'enough not to need tracking. Never mention this reminder to the user.'
  if (todos.length > 0) {
    const list = todos.map(t => `  - [${t.status}] ${t.content}`).join('\n')
    text += `\n\nYour current todo list:\n${list}`
  }
  return { type: 'text', text: text + '\n</system-reminder>' }
}

// 工具调用被截断在中途时回传给模型的 tool_result。入参 JSON 残缺，工具未执行。
function truncatedToolError(toolName: string): string {
  return [
    `[truncated] The "${toolName}" call was cut off at the output token limit before its arguments finished streaming.`,
    'NOTHING was executed and NO file was written — the arguments were incomplete.',
    'Recover by splitting the work so each tool call fits the budget:',
    `  • For a large file: call Write with only the FIRST portion, then append the remaining parts with`,
    `    successive Edit calls (or Bash append). Never try to emit the whole large file in one Write again.`,
    '  • Prefer self-contained, compact output (inline SVG/CSS over verbose markup) to stay within budget.',
    'Do not retry the identical oversized call — it will be truncated again.',
  ].join('\n')
}
