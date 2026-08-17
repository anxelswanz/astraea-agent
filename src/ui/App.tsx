// 交互式 REPL UI — 使用 React Ink 渲染到终端
// 参考: claude-code-main/src/screens/REPL.tsx + components/App.tsx

import React, { useState, useCallback, useRef, useMemo, useEffect } from 'react'
import { Box, Text, Static, useApp, useInput, useStdout, useWindowSize } from 'ink'
import pkg from '../../package.json' with { type: 'json' }
import TextInput from './TextInput'
import { query } from '../query'
import { listTools, getInteractiveTools, findTool } from '../tools/registry'
import { findCommand } from '../commands/registry'
import { initMcp, getMcpStatus } from '../mcp/registry'
import { initPlugins } from '../plugins/init'
import { createUserMessage } from '../types/message'
import type { UserMessage, AssistantMessage } from '../types/message'
import { WelcomePanel } from './WelcomePanel'
import { AstraeaIntro } from './AstraeaIntro'
import { StreamStatus } from './ThinkingIndicator'
import { hasLiveBody, shouldPublishLiveTextPreview, shouldRenderAgentActivity } from './liveFrame'
import { LoginWizard, formatLoginSuccess } from './LoginWizard'
import type { LoginResult } from './LoginWizard'
import { InternetWizard, formatInternetSuccess } from './InternetWizard'
import type { InternetResult } from './InternetWizard'
import { LanguageWizard, formatLanguageSuccess } from './LanguageWizard'
import { config, updateProviderConfig, saveLoginConfigToEnvFiles, saveSearchProviderKey, hasValidConfig, activeModel, activeBaseUrl, activeMaxTokens } from '../config'
import { resetAdapter as resetSearchAdapter } from '../tools/WebSearchTool/index'
import { setLocale, t, resolveLanguageCommand } from '../i18n'
import type { Locale } from '../i18n'
import { resetAllApiClients } from '../api/stream'
import { getSystemPrompt } from '../context/systemPrompt/builder'
import { clearSectionCache } from '../context/systemPrompt/sections'
import { onQuestion, answer, cancelAllQuestions } from '../tools/AskUserQuestionTool/bridge'
import type { PendingQuestion, Question } from '../tools/AskUserQuestionTool/bridge'
import { QuestionPanel } from './QuestionPanel'
import { setSessionSystemPrompt } from '../services/session-context'
import { startUDSServer } from '../services/uds-server'
import { getState, clearAllTasks, killAllRunningAgents } from '../services/agent-state'
import { enqueueInterject, clearInterjects } from '../services/interject-queue'
import type { AgentTaskState } from '../services/agent-state'
import { clearTodos, getAllNamespaces, getTodos } from '../services/todo-state'
import { renderMarkdown } from '../utils/markdown'
import { normalizeDraggedPath } from '../utils/dragPath'
import { clampLineWidth, safeAnsiPreview } from '../utils/termWidth'
import { displayPath } from '../utils/displayPath'
import { isAbortError } from '../utils/abortError'
import { runDetached } from '../utils/detachedTask'
import {
  initTitle,
  titleStartTask,
  titleUpgradeSummary,
  titleTaskDone,
  titleTaskError,
  titleIdle,
  titleCustom,
  clearTitle,
} from '../utils/terminalTitle'
import { notifyTaskDone, notifyTaskError } from '../utils/terminalNotify'
import { generateTitleSummary } from '../services/titleSummary'
import { getMode, setMode } from '../state/sessionMode'
import type { SessionMode } from '../state/sessionMode'
import { compactConversation, estimateTokens } from '../services/compact/compact'
import { activeThresholds, percentLeft } from '../services/compact/window'
import {
  createTranscript,
  reopenTranscript,
  listSessions,
  loadSessionMessages,
  getLastAssistantTimestamp,
  type TranscriptWriter,
  type SessionSummary,
} from '../services/transcript/transcript'
import { scheduleHousekeeping } from '../services/transcript/housekeeping'
import { setAuditSession } from '../audit/record'
import { resetEclipse } from '../services/eclipse/store'
import { setLastAssistantTs, resetMicrocompactState } from '../state/microcompactState'
import { ResumePicker } from './ResumePicker'
import { RewindPicker } from './RewindPicker'
import { ExportPanel, EXPORT_ACTIONS } from './ExportPanel'
import {
  beginCheckpoint,
  listCheckpoints,
  getCheckpoint,
  applyRestore,
  resetCheckpoints,
  type Checkpoint,
} from '../services/rewind/checkpointStore'
import {
  recordInputTokens,
  recordCompactionResult,
  recordCompactionFailure,
  getInputTokens,
} from '../state/contextTokens'
import {
  resetSessionStates,
  markSessionStale,
} from '../state/sessionState'
import {
  setGoal,
  clearGoal,
  getActiveGoal,
  getLastAchieved,
  GOAL_CLEAR_ALIASES,
  GOAL_MAX_CONDITION_LENGTH,
} from '../state/goalState'
import { ModeSelector, MODE_OPTIONS, nextCycleMode } from './ModeSelector'
import { ReasonSelector, REASON_OPTIONS } from './ReasonSelector'
import { deepseekResolveModel, resolveAppliedEffort, currentEffortStatus } from '../api/reasoningEffort'
import { executeReason, persistReason } from '../commands/reason'
import { ConfirmSelector, getConfirmChoices } from './ConfirmSelector'
import { onConfirmRequest, resolveConfirm, cancelAllConfirms, type ConfirmRequest } from '../tools/BashTool/permissions/confirmBridge'
import { VigilPanel, VIGIL_ACTIONS } from './VigilPanel'
import { GoalPanel, GoalHint } from './GoalPanel'
import { assessGoalVerifiability } from '../services/goal-evaluator'
import { SlashHint, SubcommandHint, allSlashCommands, matchSlashCommands, matchSubcommands, trailingSlashToken } from './SlashHint'
import { ModeInputFrame } from './ModeBanner'
import { useResizeRedraw } from './useResizeRedraw'
import { ToolBatch, type ToolCall } from './ToolBatch'
import { expandPasteTokens } from './pasteExpansion'
import { STATUS_COLOR, splitStatusLine, INDIGO, DEEP, type AgentStatus } from './theme'
import { TodoStatusLine } from './TodoStatusLine'
import { navigateQuestionPanel } from './questionPanelControls'
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import { getSettings, validateWechatSettings, resolveWechatSettings, resetSettingsCache, updateSettings } from '../settings'
import { abortWechatRead, WechatReadTool } from '../tools/WechatReadTool'

const VIGIL_RESULT_DIR = join(homedir(), '.astraea', 'task-results')

// Astraea 的前导星 —— turn 头与工具前叙述句共用，单点可换形/换大小。
// 备选（由小到大/由细到粗）：✦ ✶ ✷ ✸ ✹ ✺ ❂ ★
const STAR = '✸'
const VERSION = pkg.version   // 单一来源：版本号只在 package.json 维护，UI 自动跟随

const IS_WIN = platform() === 'win32'

// live frame（非 <Static> 的「进行中」帧）封顶预算。流式期间这一帧每出一个 token 都重绘，
// 一旦它比终端还高，Ink 的逐行擦除会越界——把 <Static> 里已落地的内容顶飞、视口猛地跳到
// 缓冲区最顶（用户报告：Astraea 输出时往回滚，repl 跳到最开始）。给页脚（输入框 + 状态行 +
// 各指示器）保留足够行数后，把「流式预览 + 在途工具批」的总高压在剩余预算内：
// 工具批只保留最近若干次调用（更早的会在本轮结束统一落进 <Static>，不丢信息）。
//
// 页脚高度不是常量：GoalPanel(~7) / Tasks(n+1) / 子 Agent(n) / context·compacting 条都会动态增减。
// 旧实现写死 12，一旦真实页脚超过 12 行就会重新越界。现改为渲染时按当前激活的页脚元素逐块
// 累加（见 live frame 内的 footerReserve），下面只保留恒定基底；宁可高估，绝不少算。
const FOOTER_RESERVE_BASE = 3   // ModeInputFrame 上下框线 + 输入行（恒定基底）

// 整屏清除序列（含滚动回溯缓冲）。Ink 的 <Static> 是 append-only：内部用 index 记下
// 已打印条数，每帧只渲染 items.slice(index)，已落盘的行永不擦除。一旦 history 被整体
// 替换或缩短（/clear、/resume），旧条目仍留在终端，且新 fresh 条目因 index 卡在旧值而
// 永不渲染。修复见 wipeStatic：物理清屏 + bump <Static> key 强制重挂载（index 归零重渲，
// 并触发 Ink 的 onStaticChange 清空 fullStaticOutput）。对齐 ansi-escapes 的 clearTerminal。
const CLEAR_TERMINAL = IS_WIN ? '\x1b[2J\x1b[0f' : '\x1b[2J\x1b[3J\x1b[H'

export function formatToolArg(name: string, input: Record<string, unknown>): string {
  // 工具头一律单行展示，最终交给 wrap='truncate-end' 的 <Text>，名字永不被从中间拆开。
  // 文件类工具显示 cwd 相对路径（cwd 外用绝对），不再把 old_string/new_string 这类长参数
  // 灌进工具头（trace 4：Edit 头里 old_string 被截成 "\n\nA…" 既丑又无信息）。
  const MAX = 120
  let arg: string
  switch (name) {
    case 'Read':
    case 'Write':
    case 'Edit':
      arg = input['file_path'] ? displayPath(String(input['file_path'])) : JSON.stringify(input)
      break
    case 'Bash':
    case 'PowerShell':
      // 命令里的换行折叠成空格，避免多行命令把工具头撑成多行。
      arg = String(input['command'] ?? JSON.stringify(input)).replace(/\s*\n\s*/g, ' ')
      break
    case 'TodoWrite':
      // 清单本体随 renderResult 内联展示，工具头只报数量，避免铺一长串 todos JSON。
      arg = `${Array.isArray(input['todos']) ? (input['todos'] as unknown[]).length : 0} tasks`
      break
    default: {
      const raw = JSON.stringify(input)
      arg = raw.length > MAX ? raw.slice(0, MAX) + '…' : raw
    }
  }
  return arg.length > MAX ? arg.slice(0, MAX) + '…' : arg
}

// 把毫秒格式化为 "1h2m3s" / "2m3s" / "3s"
function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return [h ? `${h}h` : '', m || h ? `${m}m` : '', `${sec}s`].filter(Boolean).join(' ')
}

function textFromConversation(messages: Array<UserMessage | AssistantMessage>): string {
  const parts: string[] = []
  for (const m of messages) {
    if (m.role === 'user') {
      if (typeof m.content === 'string') parts.push(m.content)
      else {
        for (const b of m.content) {
          if (b.type === 'text') parts.push(b.text)
          else if (typeof b.content === 'string') parts.push(b.content)
        }
      }
    } else {
      for (const b of m.content) {
        if (b.type === 'text') parts.push(b.text)
      }
    }
  }
  return parts.join('\n').replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
}

function toKebabSessionName(label: string): string {
  return label
    .normalize('NFKD')
    .toLowerCase()
    .replace(/['"`]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .filter(Boolean)
    .slice(0, 4)
    .join('-')
}

async function generateRenameTitle(messages: Array<UserMessage | AssistantMessage>): Promise<string | null> {
  const conversationText = textFromConversation(messages)
  if (!conversationText) return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15_000)
  try {
    const label = await generateTitleSummary(conversationText, controller.signal)
    const kebab = label ? toKebabSessionName(label) : ''
    return kebab || null
  } finally {
    clearTimeout(timer)
  }
}

// /goal 使用场景提示（①）——通俗版，不放命令样例，只讲"什么样的目标能用"。
// 核心：标准能否用机器判定对错。模糊目标会被误判，甚至诱发"改靶子"走捷径。
const GOAL_USECASE_HINT = [
  '**◎ /goal 怎么用**:你定个"做完的标准"，Astraea 自己反复干到达标才停。',
  '',
  '  好用 —— 标准能用命令验证、对错一目了然的活',
  '          (比如把测试跑通、清掉报错、类型检查通过)',
  '  别用 —— 标准靠"感觉"、说不清算不算完成的活',
  '          (比如"写优雅""功能能用") → 容易被误判完成，',
  '          甚至为了"过关"走捷径，比如把测试注释掉让它"通过"',
  '',
  '  诀窍:把"用哪条命令验证、期望看到什么"直接写进目标，越具体越靠谱。',
].join('\n')

// 预设模板（⑥）：把最常见、最可验证的三类目标做成快捷写法，展开成自带"出示证据"
// 要求的规范条件，既省事又天然把用户推向可验证的写法。键 = /goal <key>。
const GOAL_PRESETS: Record<string, string> = {
  test: "the project's test suite passes with zero failures — run the tests and show the final summary (exit code 0, all passing) as proof",
  lint: 'the linter reports zero errors — run it and show the final output proving no errors remain (warnings are acceptable)',
  typecheck: 'the type checker passes with no errors — run it (e.g. tsc --noEmit) and show the clean output as proof',
  build: 'the project builds successfully — run the build and show it completing with no errors',
}

// /goal 无参数时的状态文本：优先显示激活目标，否则显示上一条已达成记录。
function formatGoalStatus(): string {
  const active = getActiveGoal()
  if (active) {
    return [
      '◎ **/goal active**',
      '',
      `**Condition:** ${active.condition}`,
      `**Running for:** ${formatDuration(Date.now() - active.startedAt)}`,
      `**Turns evaluated:** ${active.turnsEvaluated}`,
      `**Token spend:** ${active.tokenSpend.toLocaleString()}`,
      active.lastReason ? `**Last check:** ${active.lastReason}` : '**Last check:** (pending first evaluation)',
    ].join('\n')
  }
  const achieved = getLastAchieved()
  if (achieved) {
    return [
      '◎ **/goal** — no active goal. Most recent achieved goal:',
      '',
      `**Condition:** ${achieved.condition}`,
      `**Duration:** ${formatDuration(achieved.durationMs)}`,
      `**Turns:** ${achieved.turns}`,
      `**Token spend:** ${achieved.tokenSpend.toLocaleString()}`,
      `**Why met:** ${achieved.reason}`,
      '',
      GOAL_USECASE_HINT,
    ].join('\n')
  }
  return `◎ **/goal** — no goal active. Set one with \`/goal <condition>\`.\n\n${GOAL_USECASE_HINT}`
}

// 创意 done 通知短语池 —— 烹饪/星辰/锻造主题，每轮 clean 收尾时随机抽取
const DONE_PHRASES: string[] = [
  'Simmered under starlight',
  'Caramelized to perfection',
  'Forged in the celestial fire',
  'Weighed against the scales',
  'Polished the constellations',
  'Plated among the cosmos',
  'Steeped in cosmic wisdom',
  'Seared across the firmament',
  'Tempered by the silent void',
  'Whipped into crystalline form',
  'Infused with clarity',
  'Marinated in moonlight',
  'Braised beyond the event horizon',
  'Glazed with stardust',
  'Roasted on the cosmic hearth',
  'Cured by cold precision',
  'Toasted to a golden finish',
  'Set like a jewel in the night',
  'Baked under a binary sun',
  'Sautéed in the astral forge',
  'Stewed until the stars aligned',
  'Drizzled with insight',
  'Seasoned with exacting care',
  'Folded into the constellation',
  'Etched into the fabric of logic',
]

// ─────────────────────────── 类型 ────────────────────────────────────────────

interface HistoryEntry {
  id: string
  // 路径 A 重构（Stage 1）：tool_use/tool_result 两类合并为一条 'tools' 批（calls 承载，
  // 逐调用配对 + 同类折叠由 <ToolBatch> 渲染）。文本/banner 角色保持不变。
  role: 'welcome' | 'user' | 'assistant' | 'mode_banner' | 'skill_banner' | 'tools' | 'status' | 'done_notification' | 'preformatted'
  text: string
  lines?: string[]       // 多行结果显示（历史遗留字段，'tools' 不用）
  calls?: ToolCall[]     // 'tools' 行专用：一个已落盘的工具批
  status?: AgentStatus   // 'status' 行专用：按状态色矩阵上色（success 绿 / pending 黄 / error 红）
}

// 工具结果 → 展示行：优先工具自带 renderResult，否则截断预览。live 流与 /resume 复用同一逻辑。
function buildResultLines(
  name: string,
  input: Record<string, unknown>,
  output: string,
  isError: boolean,
): string[] {
  const tool = listTools().find(t => t.name === name)
  const rendered = tool?.renderResult?.(input, output, isError) ?? null
  if (rendered) {
    return isError ? [`[error] ${rendered[0]}`, ...rendered.slice(1)] : rendered
  }
  const status = isError ? 'error' : 'ok'
  const preview = output.slice(0, 300)
  return [`[${status}] ${preview}${output.length > 300 ? '…' : ''}`]
}

// /resume：把恢复的对话消息转成可滚动回看的 history 条目（仅展示 user/assistant 文本）。
function rebuildHistoryEntries(
  msgs: (UserMessage | AssistantMessage)[],
  nextId: () => string,
): HistoryEntry[] {
  const out: HistoryEntry[] = []
  // 先把所有 tool_result 按 id 建索引，供 assistant 的 tool_use 回填。
  const resultById = new Map<string, { output: string; isError: boolean }>()
  for (const m of msgs) {
    if (m.role === 'user' && Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b.type === 'tool_result') {
          const output = typeof b.content === 'string'
            ? b.content
            : b.content.map(x => (x as { text: string }).text).join('')
          resultById.set(b.tool_use_id, { output, isError: !!b.is_error })
        }
      }
    }
  }
  for (const m of msgs) {
    if (m.role === 'user') {
      const raw = typeof m.content === 'string'
        ? m.content
        : m.content.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('')
      if (raw.includes('<conversation_summary>')) {
        out.push({ id: nextId(), role: 'assistant', text: '─────────  ✦ (compacted summary)  ─────────' })
        continue
      }
      const clean = raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
      if (clean) out.push({ id: nextId(), role: 'user', text: clean })
    } else {
      // assistant：按 block 顺序逐条还原——text 落 assistant 行，连续 tool_use 攒成一条 tools 批。
      let calls: ToolCall[] = []
      const flushCalls = () => {
        if (calls.length) { out.push({ id: nextId(), role: 'tools', text: '', calls }); calls = [] }
      }
      for (const b of m.content) {
        if (b.type === 'text') {
          flushCalls()
          const t = b.text.trim()
          if (t) out.push({ id: nextId(), role: 'assistant', text: t })
        } else if (b.type === 'tool_use') {
          const r = resultById.get(b.id)
          const lines = r
            ? buildResultLines(b.name, b.input, r.output, r.isError)
            : ['(no result)']
          calls.push({
            toolUseId: b.id,
            name: b.name,
            argText: formatToolArg(b.name, b.input),
            status: r?.isError ? 'error' : 'done',
            resultLines: lines,
          })
        }
      }
      flushCalls()
    }
  }
  return out
}

// ── AskUserQuestion 多问题面板辅助函数（纯函数，避免 stale-closure 依赖）────────
// 不可变地更新数组第 i 项
function setAt<T>(arr: T[], i: number, val: T): T[] {
  const next = arr.slice()
  next[i] = val
  return next
}

// 某题是否已作答（有勾选项或自填文本）
function qAnswered(sel: number[] | undefined, ft: string | undefined): boolean {
  return (sel?.length ?? 0) > 0 || (ft ?? '').trim().length > 0
}

// 从 from 之后找下一道未作答的问题（环绕）；全答完返回 from
function nextUnanswered(questions: Question[], selections: number[][], freeTexts: string[], from: number): number {
  for (let step = 1; step <= questions.length; step++) {
    const i = (from + step) % questions.length
    if (!qAnswered(selections[i], freeTexts[i])) return i
  }
  return from
}

// 把全部答案格式化成喂给模型 / 落 history 的文本
function formatAnswers(questions: Question[], selections: number[][], freeTexts: string[]): string {
  return questions
    .map((q, i) => {
      const header = q.header || `Q${i + 1}`
      const ft = (freeTexts[i] ?? '').trim()
      const ans = ft
        ? ft
        : (selections[i] ?? []).map(idx => q.options[idx]?.label ?? '').filter(Boolean).join('; ')
      return `[${header}] ${q.question}\n→ ${ans || '(no answer)'}`
    })
    .join('\n\n')
}

// ─────────────────────────── 主组件 ──────────────────────────────────────────

export function App() {
  const { exit } = useApp()

  // 启动动画：普通交互启动先播一次 AstraeaIntro（左→右银色扫光），结束后才把 welcome
  // 提交进 <Static>。--resume 跳过动画（下方 effect 会重建历史，含 welcome）。
  const isResumeLaunch = process.argv.slice(2).includes('--resume')
  const [booting, setBooting] = useState(!isResumeLaunch)

  // history[0] = welcome panel (never changes); rest = conversation entries
  // booting 期间 history 为空 → Static 不渲染任何东西，intro 独占顶部。
  const [history, setHistory] = useState<HistoryEntry[]>(
    isResumeLaunch ? [{ id: 'welcome', role: 'welcome', text: '' }] : [],
  )
  // <Static> 的重挂载计数 —— 整体替换 history（/clear、/resume）前自增，强制 Ink 的
  // <Static> 丢弃 append-only 的内部 index 与累积输出，从头重渲新 history（见 wipeStatic）。
  const [staticEpoch, setStaticEpoch] = useState(0)

  // intro 播放结束（或被按键跳过）→ 收起 live intro，再把 welcome 落进 Static。
  // 分两帧：先 setBooting(false) 让 live frame 归零，下一帧再追加 Static，规避越界擦除。
  const handleBootDone = useCallback(() => {
    setBooting(false)
    setTimeout(() => {
      setHistory(prev =>
        prev.some(e => e.id === 'welcome')
          ? prev
          : [{ id: 'welcome', role: 'welcome', text: '' }, ...prev],
      )
    }, 0)
  }, [])
  const [streamingText, setStreamingText] = useState('')
  const [activeTool, setActiveTool] = useState<string | null>(null)
  const [liveOutput, setLiveOutput] = useState<string>('')
  // 在途工具批（路径 A 重构）：liveToolsRef 是 async 流循环里同步读写的真相源，
  // liveTools 仅用于触发 live frame 重渲染。批结束（文本恢复 / done / abort）时落盘成 'tools' 行。
  const liveToolsRef = useRef<ToolCall[]>([])
  const [liveTools, setLiveTools] = useState<ToolCall[]>([])
  // 常驻状态行（StreamStatus）的数据：本次流式起始时刻 + 实时输出 token 估算。
  // runOutCharsRef 累积本次运行的输出字符数；token ≈ chars/4。
  const [streamStart, setStreamStart] = useState<number | null>(null)
  const runOutCharsRef = useRef(0)
  const [liveTokens, setLiveTokens] = useState(0)
  const [inputValue, setInputValue] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [isCompacting, setIsCompacting] = useState(false)  // 压缩进行中
  // 终端行数 —— 给"进行中"的流式预览封顶：实时帧（非 Static）一旦高过屏幕，
  // Ink 重绘时无法擦除滚出可视区的旧行，页脚（agents/tasks/输入框）会残留幽灵副本。
  const { stdout } = useStdout()
  const { columns, rows } = useWindowSize()
  const [compactChars, setCompactChars] = useState(0)      // 已生成摘要字符数 → 驱动进度条
  // 粘贴折叠（像 Claude Code）：大段粘贴在输入框里只显示占位符 [Pasted text #N …]，
  // 真实内容存在 ref map 里，提交时展开喂给模型。
  const pasteStoreRef = useRef<Map<string, string>>(new Map())
  const pasteCounterRef = useRef(0)
  // 没配置 API Key（首次启动、没有 .env）时自动弹出 /login 向导，
  // 而不是让 repl 启动时崩掉——保证用户能进界面、直接配置。
  const [showLogin, setShowLogin] = useState(() => !hasValidConfig())
  // /internet 向导：配置联网搜索 provider + API Key
  const [showInternet, setShowInternet] = useState(false)
  // /language 向导：选择界面与回复语言
  const [showLanguage, setShowLanguage] = useState(false)
  // 首次启动（无有效模型配置 → 自动弹 /login）标记：/login 完成后再自动弹 /language。
  const firstRunRef = useRef(!hasValidConfig())
  // AskUserQuestion: pending question from the model
  const [pendingQuestion, setPendingQuestion] = useState<PendingQuestion | null>(null)
  // System prompt loaded asynchronously on mount
  const [systemPrompt, setSystemPrompt] = useState<string | null>(null)
  const [sessionMode, setSessionModeState] = useState<SessionMode>('default')
  const [pendingModeSelect, setPendingModeSelect] = useState(false)
  const [modeSelectorIndex, setModeSelectorIndex] = useState(0)
  const [pendingReasonSelect, setPendingReasonSelect] = useState(false)
  const [reasonSelectorIndex, setReasonSelectorIndex] = useState(0)
  const [pendingVigilPanel, setPendingVigilPanel] = useState(false)
  const [vigilPanelIndex, setVigilPanelIndex] = useState(0)
  const [pendingResumePicker, setPendingResumePicker] = useState(false)
  const [resumePickerIndex, setResumePickerIndex] = useState(0)
  const resumeSessionsRef = useRef<SessionSummary[]>([])
  const [pendingRewindPicker, setPendingRewindPicker] = useState(false)
  const [rewindPickerIndex, setRewindPickerIndex] = useState(0)
  const rewindCheckpointsRef = useRef<Checkpoint[]>([])
  const [pendingExportPanel, setPendingExportPanel] = useState(false)
  const [exportPanelIndex, setExportPanelIndex] = useState(0)
  const [pendingExportPath, setPendingExportPath] = useState(false)
  // Slash 命令选择器：高亮项索引。slashIndexRef 供 handleSubmit 同步读取（避免入 deps）。
  const [slashIndex, setSlashIndex] = useState(0)
  const slashIndexRef = useRef(0)
  // 权限确认方向键选择器（由 confirmBridge 驱动，工具执行中弹出）
  const [pendingConfirm, setPendingConfirm] = useState<ConfirmRequest | null>(null)
  const [confirmIndex, setConfirmIndex] = useState(0)
  // AskUserQuestion 多问题面板状态（←→ 切题 / ↑↓ 移动 / Space 勾选 / Enter 提交）
  const [qIndex, setQIndex] = useState(0)            // 当前问题
  const [optCursor, setOptCursor] = useState<number[]>([])   // 每题光标行
  const [selections, setSelections] = useState<number[][]>([]) // 每题已选项索引
  const [freeTexts, setFreeTexts] = useState<string[]>([])     // 每题自填文本
  // ✎ 自填：true 时显示输入框，由 TextInput 接管当前问题的回答
  const [questionFreeText, setQuestionFreeText] = useState(false)
  const [vigilInlineValues, setVigilInlineValues] = useState<Record<string, string>>({})
  // 递增计数器，用于在目标状态变化 / 计时器 tick 时刷新 ◎ /goal active 横幅
  const [goalTick, setGoalTick] = useState(0)
  // 每次 /login 切换 provider/model 后自增，强制重算 modelId 并重建 system prompt
  const [configVersion, setConfigVersion] = useState(0)

  const conversationRef = useRef<(UserMessage | AssistantMessage)[]>([])
  // transcript 落盘（设计文档 §10）：writer + 已写盘的 conversationRef 条数（增量日志用）
  const transcriptRef = useRef<TranscriptWriter | null>(null)
  const loggedLenRef = useRef(0)
  const entryIdRef = useRef(0)
  // 收尾：格式化全部答案 → 落 history + resolve 工具 Promise + 复位面板状态
  const submitQuestions = useCallback((questions: Question[], sel: number[][], fts: string[]) => {
    const formatted = formatAnswers(questions, sel, fts)
    setPendingQuestion(null)
    setQuestionFreeText(false)
    setInputValue('')
    setHistory(prev => [...prev, { id: String(entryIdRef.current++), role: 'user', text: formatted }])
    answer(formatted)
  }, [])
  // 写 liveToolsRef（同步真相）+ liveTools（触发重渲染）。
  const syncLiveTools = useCallback((next: ToolCall[]) => {
    liveToolsRef.current = next
    setLiveTools(next)
  }, [])
  const lastLiveTextPreviewAtRef = useRef<number | null>(null)
  // 最近一次工具落 done/error 的时刻 —— 给「最短驻留」用：快工具（Read/Grep/Write <120ms）结束后，
  // 模型常立刻接着输出文字 → commitLiveTools 立即把它冻结，扫光还没播完就被截断。提交前在此基础上
  // 补足 SWEEP_DWELL_MS 的停留，让每个工具都看得到完整扫光再落盘。
  const lastToolDoneAtRef = useRef<number>(0)
  const resetStreamingPreview = useCallback(() => {
    lastLiveTextPreviewAtRef.current = null
    setStreamingText('')
  }, [])
  const publishStreamingPreview = useCallback((text: string, force = false): boolean => {
    const now = Date.now()
    if (!shouldPublishLiveTextPreview({
      now,
      lastPublishedAt: lastLiveTextPreviewAtRef.current,
      force,
    })) {
      return false
    }
    lastLiveTextPreviewAtRef.current = now
    setStreamingText(text)
    return true
  }, [])
  // 把当前在途批落盘成一条 'tools' 行并清空。空批为 no-op。
  const commitLiveTools = useCallback(() => {
    if (liveToolsRef.current.length === 0) return
    const calls = liveToolsRef.current
    setHistory(prev => [...prev, { id: String(entryIdRef.current++), role: 'tools', text: '', calls }])
    syncLiveTools([])
  }, [syncLiveTools])
  const commandHistoryRef = useRef<string[]>([])
  const historyIndexRef = useRef(-1)
  const draftInputRef = useRef('')
  const abortControllerRef = useRef<AbortController | null>(null)
  // 本回合用户刚发出的原文：ESC 叫停（流式态）时回填到 input box，免得用户重打一遍。
  // runConversation 起跑时写入；ESC Priority 1 取用后清空。
  const cancelRestoreRef = useRef('')
  const runStartRef = useRef(0)
  // 上一轮是否被中断（ESC / /stop）。中断后 todo 保留（用户仍能看），但用户一旦发起
  // 「下一个任务」就把这批残留 todo 抹掉 —— 在 runConversation 起跑时按此标志清场。
  const interruptedRef = useRef(false)
  // ESC double-press: 800ms 窗口内第二次 ESC 清空 input
  const lastEscPressRef = useRef(0)
  const escPendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [escClearHint, setEscClearHint] = useState(false)

  const modelId = useMemo(() => {
    return activeModel()
    // configVersion 在 /login 后变化，触发 modelId 重算（config 是模块级可变对象，
    // 非 React state，必须靠版本号手动让 memo 失效）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configVersion])

  // Load real system prompt on mount and rebuild whenever session mode changes
  // Also start UDS server for cross-process IPC (only on mount)
  useEffect(() => {
    try {
      startUDSServer()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setHistory(prev => [...prev, {
        id: String(entryIdRef.current++),
        role: 'status',
        status: 'error',
        text: `■ Local message bridge unavailable. ${message}`,
      }])
    }
  }, [])

  // 终端窗口标题栏（grill 决议）：挂载铺一条空闲标题；退出/卸载清空，让终端回落默认标题。
  useEffect(() => {
    initTitle()
    const onExit = () => clearTitle()
    process.on('exit', onExit)
    return () => { process.off('exit', onExit); clearTitle() }
  }, [])

  // MCP 启动期连接（实现文档 §1.7）：连上后工具进 getMcpTools()，下一轮 query 即可见。
  // 失败容忍（registry 记状态供 /mcp 面板展示）；不阻塞 UI。
  useEffect(() => {
    runDetached(import('../commands/reason').then(m => m.hydrateReasoningEffort()))  // 水合上次 /reason 落盘的等级
    try {
      initPlugins()  // 先注册插件 skill/mcp 吸管，再连 MCP（含插件 server）
    } catch {
      // A broken optional plugin must not take down the interactive session.
    }
    runDetached(initMcp().then(() => {
      const failed = getMcpStatus().filter(s => s.state === 'failed')
      const ok = getMcpStatus().filter(s => s.state === 'connected')
      if (ok.length || failed.length) {
        setHistory(prev => [...prev, {
          id: String(entryIdRef.current++),
          role: 'assistant',
          text: `◎ MCP: ${ok.length} connected${ok.length ? ` (${ok.reduce((n, s) => n + s.toolCount, 0)} tools)` : ''}${failed.length ? `, ${failed.length} failed` : ''}.`,
        }])
      }
    }))
  }, [])

  // transcript：挂载时开新会话（或 --resume 恢复）+ 调度 housekeeping（设计文档 §10）。
  useEffect(() => {
    if (transcriptRef.current) { scheduleHousekeeping(); return }
    const argv = process.argv.slice(2)
    const ri = argv.indexOf('--resume')
    if (ri !== -1) {
      const idArg = argv[ri + 1] && !argv[ri + 1]!.startsWith('-') ? argv[ri + 1] : undefined
      const sessions = listSessions(process.cwd())
      const target = idArg
        ? sessions.find(s => s.sessionId === idArg || s.sessionId.startsWith(idArg))
        : sessions[0]
      if (target) {
        const msgs = loadSessionMessages(target.path)
        conversationRef.current = msgs
        loggedLenRef.current = msgs.length
        transcriptRef.current = reopenTranscript(process.cwd(), target.sessionId)
        setAuditSession(transcriptRef.current.sessionId)
        markSessionStale()
        // microcompact：从 transcript 回填最后一条 assistant 时间，让 resume 后首轮也能算 gap。
        { const ts = getLastAssistantTimestamp(target.path); if (ts !== null) setLastAssistantTs(ts) }
        setHistory([
          { id: 'welcome', role: 'welcome', text: '' },
          ...rebuildHistoryEntries(msgs, () => String(entryIdRef.current++)),
          { id: String(entryIdRef.current++), role: 'assistant', text: `◎ resumed ${msgs.length} messages (--resume). Continue where you left off.` },
        ])
        scheduleHousekeeping()
        return
      }
    }
    transcriptRef.current = createTranscript(process.cwd())
    setAuditSession(transcriptRef.current.sessionId)
    scheduleHousekeeping()
  }, [])

  // 输入变化时把 slash 选择器高亮重置到第 0 项（导航只改 slashIndex，不会触发此处）。
  useEffect(() => { setSlashIndex(0); slashIndexRef.current = 0 }, [inputValue])

  // 流式开始的上升沿：重置常驻状态行的计时与 token 计数。覆盖所有流式入口
  // （主对话 / WechatRead / 其它次要查询循环），无需逐处埋点。
  useEffect(() => {
    if (isStreaming) {
      setStreamStart(Date.now())
      runOutCharsRef.current = 0
      setLiveTokens(0)
    }
  }, [isStreaming])

  useEffect(() => {
    return () => { if (escPendingTimerRef.current) clearTimeout(escPendingTimerRef.current) }
  }, [])

  // Poll for completed vigil task results and surface them in the REPL
  useEffect(() => {
    const poll = setInterval(() => {
      try {
        const files = readdirSync(VIGIL_RESULT_DIR)
        for (const file of files) {
          if (!file.endsWith('.json')) continue
          const path = join(VIGIL_RESULT_DIR, file)
          let content: { taskId: string; prompt: string; output: string; completedAt: string; read: boolean; failed?: boolean; filesWritten?: string[]; toolErrors?: string[] }
          try { content = JSON.parse(readFileSync(path, 'utf-8')) } catch { continue }
          if (content.read) continue
          // Mark read immediately to prevent double-display
          writeFileSync(path, JSON.stringify({ ...content, read: true }, null, 2))
          const shortPrompt = content.prompt.length > 80 ? content.prompt.slice(0, 80) + '…' : content.prompt
          const header = content.failed
            ? `**[Vigil task failed]** \`${content.taskId.slice(0, 8)}\``
            : `**[Vigil task complete]** \`${content.taskId.slice(0, 8)}\``
          const filesSection = content.filesWritten && content.filesWritten.length > 0
            ? `\n\n**Files written:**\n${content.filesWritten.map(f => `- \`${f}\``).join('\n')}`
            : ''
          const errorsSection = content.toolErrors && content.toolErrors.length > 0
            ? `\n\n**Tool errors:**\n${content.toolErrors.map(e => `- ${e}`).join('\n')}`
            : ''
          setHistory(prev => [...prev, {
            id: String(entryIdRef.current++),
            role: 'assistant' as const,
            text: `${header}\n\n> ${shortPrompt}\n\n${content.output}${filesSection}${errorsSection}`,
          }])
        }
      } catch { /* result dir not yet created */ }
    }, 2_000)
    return () => clearInterval(poll)
  }, [])

  useEffect(() => {
    // 交互对话不暴露微信工具（仅 /wechat、/vigil wechat 可触发），故系统提示里也不列出。
    const tools = getInteractiveTools()
    const enabledTools = new Set(tools.map(t => t.name))
    getSystemPrompt({ modelId, enabledTools, mode: sessionMode }).then(prompt => {
      setSystemPrompt(prompt)
      setSessionSystemPrompt(prompt)
    }).catch(() => {
      const fallback = 'You are Astraea, an AI coding assistant.'
      setSystemPrompt(fallback)
      setSessionSystemPrompt(fallback)
    })
    // configVersion 在 /language 切换后 bump → 重建系统提示，注入新的回复语言。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelId, sessionMode, configVersion])

  // Poll running agents for spinner display.
  // ⚠️ 只在「运行中 agent 集合真正变化」时才 setState。否则每 500ms 都用一个全新数组
  // 调用 setRunningAgents，会强制整个 App 每秒重渲染两次；Ink 每次重渲染都要擦除并重绘
  // live frame，配合 <Static> 里多行 ANSI 内容会导致擦除越界、把刚落地的回复抹掉
  // （表现为「文字闪一下 0.1s 就消失」）。用签名比对消除空转重渲染。
  const [runningAgents, setRunningAgents] = useState<AgentTaskState[]>([])
  useEffect(() => {
    let lastSig = ''
    const interval = setInterval(() => {
      const agents = Object.values(getState().tasks).filter(
        (t): t is AgentTaskState => t.kind === 'agent' && t.status === 'running',
      )
      const sig = agents.map(a => `${a.id}:${a.status}`).join('|')
      if (sig !== lastSig) {
        lastSig = sig
        setRunningAgents(agents)
      }
    }, 500)
    return () => clearInterval(interval)
  }, [])

  // 目标激活时每秒 tick 一次，让 ◎ /goal active 横幅的计时实时刷新
  useEffect(() => {
    const interval = setInterval(() => {
      if (getActiveGoal()) setGoalTick(t => t + 1)
    }, 1000)
    return () => clearInterval(interval)
  }, [])

  // Subscribe to AskUserQuestion bridge
  useEffect(() => {
    const unsubscribe = onQuestion(q => {
      // 携带 planBody 的问题（ExitOrbitMode 的计划审批）：先把计划正文作为一条持久化的
      // assistant markdown 历史条目落进 <Static>。这样计划以 markdown 渲染（issue #1），
      // 且无论审批面板被 Enter 提交还是 ESC 关掉，计划都留在屏幕上不会消失（issue #2）。
      const planBody = q.questions[0]?.planBody
      if (planBody?.trim()) {
        setHistory(prev => [
          ...prev,
          { id: String(entryIdRef.current++), role: 'assistant', text: planBody },
        ])
      }
      setPendingQuestion(q)
      setInputValue('')
    })
    return unsubscribe
  }, [])

  // Subscribe to permission-confirm bridge → 渲染方向键确认选择器
  useEffect(() => {
    const unsubscribe = onConfirmRequest(req => {
      setPendingConfirm(req)
      setConfirmIndex(0)
    })
    return unsubscribe
  }, [])

  // Reset panel state whenever a new question set arrives
  useEffect(() => {
    const qs = pendingQuestion?.questions ?? []
    setQIndex(0)
    setOptCursor(qs.map(() => 0))
    setSelections(qs.map(() => []))
    setFreeTexts(qs.map(() => ''))
    setQuestionFreeText(false)
  }, [pendingQuestion])

  // ── runConversation：统一的流式查询执行器 ──────────────────────────────────
  // 普通消息和 /goal 共用同一条流式管线。promptText 是喂给模型的内容，
  // displayText 是在 history 里展示为 "You: …" 的内容（默认与 promptText 相同）。
  // 恢复一个历史会话：重建 conversationRef + history、续写其 transcript、token 计数作废。
  // 整屏清除 + 强制 <Static> 重挂载 —— 任何「整体替换 history」的入口（非追加）在调用
  // setHistory 前先调它，否则旧条目残留屏上、新条目又因 Static 的 append-only 语义不渲染。
  const wipeStatic = useCallback(() => {
    stdout?.write(CLEAR_TERMINAL)
    setStaticEpoch(e => e + 1)
  }, [stdout])

  // Terminal resize (columns/rows change) -> debounced full-screen redraw; otherwise <Static>
  // history re-wraps at the old width and ghosts/misaligns. The live frame and input box live
  // outside <Static> and already re-render reactively with columns; this only repaints scrollback.
  useResizeRedraw(columns, rows, wipeStatic)

  const restoreSession = useCallback((target: SessionSummary) => {
    const msgs = loadSessionMessages(target.path)
    conversationRef.current = msgs
    loggedLenRef.current = msgs.length
    transcriptRef.current = reopenTranscript(process.cwd(), target.sessionId)
    setAuditSession(transcriptRef.current.sessionId)
    resetCheckpoints()  // 切到别的会话 → 当前会话的 /rewind 检查点全部作废
    markSessionStale()
    // microcompact：从 transcript 回填最后一条 assistant 时间，让 resume 后首轮也能算 gap。
    { const ts = getLastAssistantTimestamp(target.path); if (ts !== null) setLastAssistantTs(ts) }
    wipeStatic()  // 抹掉当前会话屏内容 + 重挂载 Static，再铺恢复出的历史
    setHistory([
      { id: 'welcome', role: 'welcome', text: '' },
      ...rebuildHistoryEntries(msgs, () => String(entryIdRef.current++)),
      { id: String(entryIdRef.current++), role: 'assistant', text: `◎ resumed session — ${msgs.length} messages restored. Continue where you left off.` },
    ])
  }, [wipeStatic])

  // ── /rewind — 会话内时间倒流：回滚对话 + Write/Edit 改过的文件到第 turn 回合之前 ──
  const rewindTo = useCallback((turn: number) => {
    const res = applyRestore(turn)  // 先还原文件 + 丢弃 >=turn 的检查点/快照
    if (!res) {
      setHistory(prev => [...prev, { id: String(entryIdRef.current++), role: 'assistant', text: `⚠ /rewind — checkpoint #${turn} not found.` }])
      return
    }
    // 对话三层同步：内存截断 → transcript 追加 rewind 标记（append-only）→ loggedLen 回退
    const dropped = conversationRef.current.length - res.convLen
    conversationRef.current = conversationRef.current.slice(0, res.convLen)
    transcriptRef.current?.appendRewind(turn, res.convLen)
    loggedLenRef.current = res.convLen
    markSessionStale()
    // 文件回滚回执
    const fileBits: string[] = []
    if (res.restored.length) fileBits.push(`${res.restored.length} file${res.restored.length === 1 ? '' : 's'} reverted`)
    if (res.deleted.length) fileBits.push(`${res.deleted.length} created file${res.deleted.length === 1 ? '' : 's'} removed`)
    const fileNote = fileBits.length ? ` · ${fileBits.join(', ')}` : ''
    wipeStatic()  // 物理清屏 + 重挂载 Static，再铺回滚后的历史
    setHistory([
      { id: 'welcome', role: 'welcome', text: '' },
      ...rebuildHistoryEntries(conversationRef.current, () => String(entryIdRef.current++)),
      { id: String(entryIdRef.current++), role: 'assistant', text: `↩ rewound to checkpoint #${turn} — ${dropped} message${dropped === 1 ? '' : 's'} dropped${fileNote}.` },
    ])
  }, [wipeStatic])

  const runLocalExport = useCallback(async (args?: string) => {
    const { exportConversation } = await import('../commands/export')
    const res = await exportConversation(args)
    if (res.type === 'text') {
      setHistory(prev => [...prev, { id: String(entryIdRef.current++), role: 'assistant', text: res.value }])
    } else if (res.type === 'preformatted') {
      setHistory(prev => [...prev, { id: String(entryIdRef.current++), role: 'preformatted', text: res.value }])
    }
  }, [])

  const runConversation = useCallback(
    async (
      promptText: string,
      displayText?: string,
      // skill 斜杠入口（路径 A）的 per-query 线程化（实现文档 §1.6）：
      //   model     — skill frontmatter 的模型覆盖，仅作用于这一次 query
      //   extraTools — skill allowed-tools 的累加授权（把交互集之外的工具补进本次 query）
      //   skillName — 经斜杠入口命中的 skill 名，命中后在 user 行下补一行 "skill /<name> loaded." 提示
      runOpts?: { model?: string; extraTools?: import('../tools/Tool').Tool[]; skillName?: string },
    ) => {
      const controller = new AbortController()
      abortControllerRef.current = controller

      // 上一轮被 ESC / /stop 中断后残留的 todo：用户发起「下一个任务」即视为换题 → 清场，
      // 避免上一个任务的 Tasks 面板赖在新任务里。模型若仍需规划会在本轮重发 TodoWrite。
      if (interruptedRef.current) {
        for (const ns of getAllNamespaces()) clearTodos(ns)
        interruptedRef.current = false
      }

      // 终端标题栏：任务起跑 → ✸ + 即时输入摘要；后台用主模型精炼成极短短语后静静回填。
      const titleTurn = titleStartTask(displayText ?? promptText)
      runDetached(generateTitleSummary(promptText, controller.signal).then(s => {
        if (s) titleUpgradeSummary(titleTurn, s)
      }))

      commandHistoryRef.current.push(displayText ?? promptText)
      cancelRestoreRef.current = displayText ?? promptText  // ESC 叫停时回填用
      historyIndexRef.current = -1
      // /rewind 检查点：记录本回合用户消息追加「之前」的 conversationRef 长度。
      // 必须在 conversationRef 被改动前取（done 事件才会写回），故置于本函数顶部。
      beginCheckpoint({ convLen: conversationRef.current.length, userText: displayText ?? promptText })
      setInputValue('')
      setIsStreaming(true)
      runStartRef.current = Date.now()
      resetStreamingPreview()
      setActiveTool(null)
      setLiveOutput('')
      syncLiveTools([])

      setHistory(prev => [
        ...prev,
        { id: String(entryIdRef.current++), role: 'user', text: displayText ?? promptText },
        ...(runOpts?.skillName
          ? [{ id: String(entryIdRef.current++), role: 'skill_banner' as const, text: runOpts.skillName }]
          : []),
      ])

      const userMsg = createUserMessage(promptText)
      const messages = [...conversationRef.current, userMsg]

      // 闪退兜底：turn 起跑即把用户消息落盘，不等 done（设计文档 §10）。
      // 否则 appendMessages 只在本轮 done 触发——终端在流式途中崩溃，整轮 prompt 连同
      // 半截回复一起丢失。这里先写 user 行并前移 loggedLen，done 的 delta 会自然跳过它，
      // 不重复；若中途 compact，compact 快照在 loadSessionMessages 里整体替换累加器，亦无冲突。
      const preTurnLoggedLen = loggedLenRef.current
      let earlyAppended = false
      let turnCommitted = false  // done 走完（conversationRef+loggedLen 已对齐）才置真
      {
        const w = transcriptRef.current
        if (w?.enabled && loggedLenRef.current === conversationRef.current.length) {
          w.appendMessages([userMsg])
          loggedLenRef.current += 1
          earlyAppended = true
        }
      }

      let accumulated = ''
      // 整次运行是否产生过任何可见输出（文本/工具/裁决）。否则在 done 时补一行占位，
      // 避免「模型返回极简或空回复 → 界面一片空白看起来像卡死」。
      let anyVisibleOutput = false
      // 把当前累计的助手文本刷入 history（目标多轮运行时按 turn 分段展示）
      const flushAssistant = () => {
        if (accumulated.trim()) {
          setHistory(prev => [
            ...prev,
            { id: String(entryIdRef.current++), role: 'assistant', text: accumulated },
          ])
        }
        accumulated = ''
        resetStreamingPreview()
      }

      try {
        const queryTools = runOpts?.extraTools?.length
          ? [...getInteractiveTools(), ...runOpts.extraTools.filter(
              t => !getInteractiveTools().some(b => b.name === t.name))]
          : getInteractiveTools()
        for await (const event of query(messages, queryTools, {
          system: systemPrompt!,
          // 探索类任务（连续 Grep/Read）很容易跑十几二十轮。20 太低会把任务腰斩，
          // 表现为"运行到一半就结束"。抬到 100 作为防失控的硬上限，正常任务远够用；
          // 真撞到上限会经 max_turns_reached 提示用户继续，而非静默 return。
          maxTurns: 100,
          enablePromptCaching: true,
          abortSignal: controller.signal,
          autocompact: true,  // 仅主对话开启压缩 + token 计数（设计文档 §3/§6）
          model: runOpts?.model,  // skill frontmatter 模型覆盖（per-query）
        })) {
          switch (event.type) {
            case 'turn_start':
              // 轮边界落盘上一轮助手文本，按 turn 分段展示。对纯文本轮插队尤为关键：
              // 注入插队后续跑的下一轮文本不会与本轮回复粘连（interject 边界1）。
              // flushPrev=false 仅出现在 max_tokens 续写：此时要无缝拼接，不可切成两段气泡。
              if (event.flushPrev) flushAssistant()
              break

            case 'text':
              // 工具批结束、叙述恢复 → 先把在途批落盘，保证时序：…文本→工具批→文本…
              if (liveToolsRef.current.length > 0) {
                // 最短驻留：快工具刚结束就被落盘会截断扫光。落盘前补足 ~一趟扫光的停留（仅有色 TTY；
                // 工具早已结束则 dwell≤0 不等）。await 同时延后「落盘 + 累积该段文字」，时序天然不乱。
                const SWEEP_DWELL_MS = 320
                const dwell = SWEEP_DWELL_MS - (Date.now() - lastToolDoneAtRef.current)
                if (dwell > 0 && process.stdout.isTTY && !controller.signal.aborted) {
                  await new Promise(r => setTimeout(r, dwell))
                }
                commitLiveTools()  // 无条件落盘（与原逻辑一致；abort 仅用于跳过等待）
              }
              accumulated += event.text
              // 常驻状态行的实时输出量「估算」（非 API 真值，仅作活跃度指示）。
              // token ≈ chars/4，统计口径含叙述文本 + 工具入参（见 tool_use 分支）。
              // 真实上下文用量走另一条线：message_stop 的 usage 三项 input 之和。
              runOutCharsRef.current += event.text.length
              if (event.text.trim()) anyVisibleOutput = true
              if (publishStreamingPreview(accumulated)) {
                setLiveTokens(Math.ceil(runOutCharsRef.current / 4))
              }
              break

            case 'tool_use': {
              anyVisibleOutput = true
              // 叙述紧贴其工具调用：先把累积文本落盘，再把这次调用推进在途批。
              // live frame 由「文本」切到「工具行」，不会塌缩为 0 行 → 规避 done-bug 越界擦除。
              flushAssistant()
              setActiveTool(event.name)
              // 工具入参也是模型本轮的输出，计入活跃度估算——否则探索类任务
              // （连续 Grep/Read，几乎无叙述文本）状态行会一直显示接近 0 token。
              try {
                runOutCharsRef.current += JSON.stringify(event.input).length
                setLiveTokens(Math.ceil(runOutCharsRef.current / 4))
              } catch { /* 入参含循环引用等无法序列化时跳过 */ }
              const argPreview = formatToolArg(event.name, event.input)
              syncLiveTools([
                ...liveToolsRef.current,
                { toolUseId: event.id, name: event.name, argText: argPreview, status: 'running' },
              ])
              break
            }

            case 'tool_progress': {
              setLiveOutput(prev => prev + event.chunk)
              break
            }

            case 'tool_result': {
              setLiveOutput('')
              setActiveTool(null)
              const lines = buildResultLines(event.name, event.input, event.output, event.isError)

              // 结果按 id 回填到在途批对应调用（逐调用配对的核心）。
              syncLiveTools(liveToolsRef.current.map(c =>
                c.toolUseId === event.id
                  ? { ...c, status: event.isError ? 'error' : 'done', resultLines: lines }
                  : c,
              ))
              lastToolDoneAtRef.current = Date.now()  // 记录完成时刻 → 落盘前据此补足最短驻留

              const currentSingletonMode = getMode()
              setSessionModeState(prev => {
                if (prev !== currentSingletonMode) {
                  // 模式 banner 必须排在工具批之后 → 先把在途批落盘再插 banner。
                  commitLiveTools()
                  setHistory(h => [
                    ...h,
                    { id: String(entryIdRef.current++), role: 'mode_banner' as const, text: currentSingletonMode },
                  ])
                  return currentSingletonMode
                }
                return prev
              })
              break
            }

            // ── /goal Stop-hook 事件 ────────────────────────────────────────
            case 'goal_evaluated': {
              // 先把本轮助手文本落盘，再展示 evaluator 裁决
              flushAssistant()
              anyVisibleOutput = true
              const marker = event.met ? '✓ achieved' : '… continuing'
              setHistory(prev => [
                ...prev,
                {
                  id: String(entryIdRef.current++),
                  role: 'assistant',
                  text: `◎ **/goal** ${marker} · turn ${event.turns} — ${event.reason}`,
                },
              ])
              setGoalTick(t => t + 1)
              break
            }

            case 'goal_exhausted': {
              flushAssistant()
              const why =
                event.cause === 'tokens' ? `reached token ceiling (${event.maxTokens.toLocaleString()} output tokens)`
                : event.cause === 'stall' ? 'no progress detected over several turns — likely stuck, handing control back'
                : `reached safety cap of ${event.maxTurns} turns`
              setHistory(prev => [
                ...prev,
                {
                  id: String(entryIdRef.current++),
                  role: 'assistant',
                  text: `◎ **/goal** stopped — ${why}. Last check: ${event.reason}`,
                },
              ])
              setGoalTick(t => t + 1)
              break
            }

            // 只说不做：连续多轮复述计划却没有工具调用，加压用尽后交还控制权。
            // 必须显式告知——静默停下正是「跑一会儿就自己停了」的用户观感。
            case 'commitment_exhausted': {
              flushAssistant()
              setHistory(prev => [
                ...prev,
                {
                  id: String(entryIdRef.current++),
                  role: 'assistant',
                  text:
                    `⚠ Stopped after ${event.attempts} turns of restating the plan without calling a tool. ` +
                    `Last check: ${event.reason}`,
                },
              ])
              break
            }

            // ── 上下文压缩事件 ──────────────────────────────────────────────
            case 'compact_start': {
              flushAssistant()
              setActiveTool(null)
              setCompactChars(0)
              setIsCompacting(true)  // 转进度条，不落永久行
              break
            }

            case 'compact_progress': {
              setCompactChars(event.chars)
              break
            }

            case 'compact_done': {
              setIsCompacting(false)
              // transcript：写一条 compact 标记（含快照），并把已写盘长度重对齐到快照长度
              transcriptRef.current?.appendCompact(event.messages, event.summary, event.preTokens, event.trigger)
              loggedLenRef.current = event.messages.length
              setHistory(prev => [...prev, {
                id: String(entryIdRef.current++),
                role: 'assistant',
                text: `─────────  ✦ context compacted${event.willRetrigger ? ' (still large — may compact again)' : ''}  ─────────`,
              }])
              break
            }

            case 'compact_failed': {
              setIsCompacting(false)
              setHistory(prev => [...prev, {
                id: String(entryIdRef.current++),
                role: 'assistant',
                text: `⚠ compaction failed: ${event.reason}`,
              }])
              break
            }

            case 'compact_tripped': {
              setHistory(prev => [...prev, {
                id: String(entryIdRef.current++),
                role: 'assistant',
                text: '⚠ context can no longer be auto-compacted (circuit breaker). Trim manually with /compact, /clear, or start a new session.',
              }])
              break
            }

            case 'compact_blocked': {
              flushAssistant()
              setHistory(prev => [...prev, {
                id: String(entryIdRef.current++),
                role: 'assistant',
                text: `⚠ context full (~${Math.round(event.usedTokens / 1000)}K) and autocompact is off — run /compact to continue.`,
              }])
              break
            }

            case 'max_turns_reached': {
              // 撞到硬上限：之前会跟着 done 静默收尾，用户只看到任务半途而废、不知为何。
              // 这里显式落一行提示，并保留已产出的上下文——直接回车/补一句即可续跑。
              flushAssistant()
              setHistory(prev => [...prev, {
                id: String(entryIdRef.current++),
                role: 'assistant',
                text: t('turnLimit', { n: event.maxTurns }),
              }])
              break
            }

            case 'done': {
              conversationRef.current = event.messages
              // transcript：增量写本轮新产生的消息（设计文档 §10 逐条 append）
              {
                const w = transcriptRef.current
                if (w?.enabled) {
                  const delta = event.messages.slice(loggedLenRef.current)
                  if (delta.length) w.appendMessages(delta)
                  loggedLenRef.current = event.messages.length
                }
              }
              turnCommitted = true  // conversationRef + loggedLen 已对齐，finally 无需回退早写
              // ESC 中止：UI 已在 ESC 处理器里更新（显示了 [cancelled]），这里只清理流式状态。
              // 已跑完的工具调用落盘保留，避免中止时丢掉用户已看到的结果。
              if (controller.signal.aborted) {
                accumulated = ''
                resetStreamingPreview()
                setIsStreaming(false)
                commitLiveTools()
                titleTaskDone(titleTurn)  // 用户主动中止 = 本轮结束，标题转 ✓（非错误）
                break
              }
              // ── 修复「回复闪一下就消失」──────────────────────────────────────
              // 根因：live streaming frame（多行）在 done 这一帧塌缩为 0，而 <Static>
              // 同一帧新增同样多行内容 → Ink 擦除 live frame 时行数算越界，把刚落地的
              // 回复一起抹掉。reasoning 模型（gpt-5.x）整段突发输出时尤其明显。
              // 解法：分两帧——先收起 live frame，再到下一帧才把回复 append 进 Static。
              const finalText = accumulated
              accumulated = ''
              resetStreamingPreview()   // 帧 A：live frame 干净收起（含在途工具批），Static 不变，无越界
              setIsStreaming(false)
              setGoalTick(t => t + 1)
              titleTaskDone(titleTurn)  // 本轮干净收尾 → 标题转 ✓（摘要保持到下一任务）
              setTimeout(() => {        // 帧 B：live frame 已为 0，单纯向 Static 追加，安全
                // 先落盘以工具结尾的在途批（此时 finalText 为空），再落最终文本 → 顺序正确。
                commitLiveTools()
                if (finalText.trim()) {
                  setHistory(prev => [
                    ...prev,
                    { id: String(entryIdRef.current++), role: 'assistant', text: finalText },
                  ])
                } else if (!anyVisibleOutput) {
                  // 整次运行无任何可见输出（空回复且未调用工具）→ 补一行提示，避免界面像卡死
                  setHistory(prev => [
                    ...prev,
                    {
                      id: String(entryIdRef.current++),
                      role: 'assistant',
                      text: '_(model returned an empty reply — no text and no tool call. Try rephrasing, or switch model with /login.)_',
                    },
                  ])
                }
                // 创意 done 通知：仅当本轮产生过可见输出且非中止时，追加紫色灵感短语
                if (!controller.signal.aborted && (finalText.trim() || anyVisibleOutput)) {
                  const elapsed = Date.now() - runStartRef.current
                  const phrase = DONE_PHRASES[Math.floor(Math.random() * DONE_PHRASES.length)]
                  const h = Math.floor(elapsed / 3600000)
                  const m = Math.floor((elapsed % 3600000) / 60000)
                  const s = Math.floor((elapsed % 60000) / 1000)
                  const duration = [h ? h + 'h' : '', m || h ? m + 'm' : '', s + 's'].filter(Boolean).join(' ')
                  setHistory(prev => [
                    ...prev,
                    { id: String(entryIdRef.current++), role: 'done_notification' as const, text: `✻ ${phrase} for ${duration}` },
                  ])
                  // 终端通知：任务干净收尾 → Dock 弹一下 / 任务栏闪 / 通知中心横幅（仅后台时可见）。
                  notifyTaskDone({ elapsedMs: elapsed, summary: `Done in ${duration}` })
                }
              }, 0)
              break
            }
          }
        }
      } catch (err) {
        // 中止 = ESC，UI 已在 ESC 处理器里更新，这里静默清理（保留已跑完的工具批）。
        // SDK 把流式 abort 包成 APIUserAbortError（name='Error'，message='Request was aborted.'），
        // 故用 isAbortError + 当前 controller.signal 统一识别，避免中止被渲染成红色报错。
        if (isAbortError(err, controller.signal)) {
          resetStreamingPreview()
          setActiveTool(null)
          setLiveOutput('')
          commitLiveTools()
          // ESC//stop 处理器通常已复位，但 abort 也可能来自其他路径（如会话切换）——
          // 这里兜底复位，否则 UI 卡在 streaming 态（状态行常驻、输入框禁用）。幂等。
          setIsStreaming(false)
          interruptedRef.current = true  // 本轮被 ESC 中断 → 残留 todo 待下一个任务起跑时清场
          titleTaskDone(titleTurn)  // 中止 = 本轮结束，标题转 ✓（非错误）
        } else {
          const errMsg = err instanceof Error ? err.message : String(err)
          commitLiveTools()   // 报错前已跑完的工具批落盘，便于定位失败上下文
          setHistory(prev => [
            ...prev,
            { id: String(entryIdRef.current++), role: 'status', status: 'error', text: `■ Error. ${errMsg}` },
          ])
          resetStreamingPreview()
          setIsStreaming(false)
          setActiveTool(null)
          titleTaskError(titleTurn)  // 本轮报错 → 标题转 ✗（摘要保留）
          // 终端通知：本轮报错也提醒用户去看一眼。
          notifyTaskError({ elapsedMs: Date.now() - runStartRef.current, summary: errMsg.slice(0, 80) })
        }
      } finally {
        abortControllerRef.current = null
        setIsCompacting(false)  // 安全复位（覆盖压缩中途 abort 等边界）
        // 早写对账：若本轮没走到 done（异常/中断途中退出），conversationRef 仍停在轮前状态，
        // 而早写已把 loggedLen 前移了 1。回退 loggedLen 到轮前值，恢复「loggedLen==conversationRef.length」
        // 不变量，让下一轮的早写守卫仍能生效。磁盘上那条 user 行留作孤儿（append-only 无法撤销），
        // /resume 重放时正好把闪退前的这句 prompt 恢复出来——这正是我们要的兜底。
        if (earlyAppended && !turnCommitted) loggedLenRef.current = preTurnLoggedLen
      }
    },
    [systemPrompt],
  )

  // ── /stop —— 一键叫停 ────────────────────────────────────────────────────────
  // 取消正在进行的本轮流式查询 + 协作式中止所有运行中的子 Agent。
  // 与 ESC 等价（ESC 仅中断当前流），但 /stop 还会一并停掉后台 agent，且能在任意输入态触发
  // （ESC 在非流式时另有清空输入等语义）。落一行红色 status 回执（中断 = 红）。
  const stopActiveWork = useCallback(() => {
    const wasStreaming = isStreaming && !!abortControllerRef.current
    if (wasStreaming) {
      interruptedRef.current = true  // /stop 中断 → 残留 todo 待下一个任务起跑时清场
      abortControllerRef.current?.abort()
      clearInterjects()  // 叫停时丢弃未拾取的插队，与 ESC 语义一致
      setIsStreaming(false)
      resetStreamingPreview()
      setActiveTool(null)
      setLiveOutput('')
      commitLiveTools()  // 已跑完的工具批先落盘，排在 /stop 回执之前（顺序正确）
    }
    // 中止后没人会再回答 bridge 里挂起的确认/提问；不排空的话发起方工具永远悬挂。
    cancelAllConfirms()
    cancelAllQuestions()
    setPendingConfirm(null)
    setPendingQuestion(null)
    const killed = killAllRunningAgents()
    const parts: string[] = []
    if (wasStreaming) parts.push('current turn cancelled')
    if (killed > 0) parts.push(`${killed} running agent${killed === 1 ? '' : 's'} aborted`)
    if (parts.length > 0) {
      setHistory(prev => [...prev, {
        id: String(entryIdRef.current++),
        role: 'status',
        status: 'error',
        text: `■ /stop — ${parts.join(' · ')}.`,
      }])
    } else {
      setHistory(prev => [...prev, {
        id: String(entryIdRef.current++),
        role: 'status',
        status: 'pending',
        text: '◌ /stop — nothing is running.',
      }])
    }
  }, [isStreaming, commitLiveTools])

  const reportDetachedUiError = useCallback((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err)
    setIsStreaming(false)
    setActiveTool(null)
    setLiveOutput('')
    setHistory(prev => [...prev, {
      id: String(entryIdRef.current++),
      role: 'status',
      status: 'error',
      text: `■ Error. ${message}`,
    }])
  }, [])

  const handleSubmit = useCallback(
    async (text: string) => {
      const displayText = text.trim()
      const trimmed = expandPasteTokens(text, pasteStoreRef.current).trim()
      if (!trimmed) return

      if (pendingExportPath) {
        setInputValue('')
        historyIndexRef.current = -1
        setPendingExportPath(false)
        setPendingExportPanel(false)
        await runLocalExport(trimmed)
        return
      }

      // AskUserQuestion answer mode: this fires from the ✎ free-text box for the
      // current question. Store the typed text, then advance to the next unanswered
      // question or submit the whole set. (When not in free-text the input box is
      // hidden and navigation is handled in useInput.)
      if (pendingQuestion) {
        const questions = pendingQuestion.questions
        setInputValue('')
        setQuestionFreeText(false)
        const nextFt = setAt(freeTexts, qIndex, trimmed)
        const nextSel = setAt(selections, qIndex, [])
        setFreeTexts(nextFt)
        setSelections(nextSel)
        const allAnswered = questions.every((_, i) => qAnswered(nextSel[i], nextFt[i]))
        if (allAnswered) {
          submitQuestions(questions, nextSel, nextFt)
        } else {
          setQIndex(nextUnanswered(questions, nextSel, nextFt, qIndex))
        }
        return
      }

      // ── 执行中也允许随时切换模式，立即对下一次工具调用生效 ─────────────────
      // （query.ts 每批工具前重读 getMode()）。input box 不锁定，不显示 "wait for astraea"。
      if (isStreaming) {
        // /stop 在执行中也必须生效 —— 这正是它的主战场（叫停跑飞的任务）。
        if (trimmed === '/stop') {
          setInputValue('')
          historyIndexRef.current = -1
          stopActiveWork()
          return
        }
        const liveModeMatch = trimmed.match(/^\/mode\s+(default|orbit|cruise|forge|counsel)$/)
        const langCmd = resolveLanguageCommand(trimmed)
        if (liveModeMatch) {
          const newMode = liveModeMatch[1] as SessionMode
          setInputValue('')
          historyIndexRef.current = -1
          setMode(newMode)
          setSessionModeState(newMode)
          setHistory(prev => [
            ...prev,
            { id: String(entryIdRef.current++), role: 'mode_banner' as const, text: newMode },
          ])
        } else if (trimmed === '/mode') {
          setInputValue('')
          historyIndexRef.current = -1
          const currentIdx = MODE_OPTIONS.findIndex(o => o.value === getMode())
          setModeSelectorIndex(currentIdx >= 0 ? currentIdx : 0)
          setPendingModeSelect(true)
        } else if (langCmd) {
          // /language 在执行中也放行：切 locale / 弹向导都是纯本地 UI 操作，不碰在飞的流，
          // 与 /mode 同理（此前被「其它斜杠命令忽略」吞掉 → 输出时敲 /language 无反应）。
          setInputValue('')
          historyIndexRef.current = -1
          if (langCmd.kind === 'switch') runDetached(handleLanguageDone(langCmd.locale), reportDetachedUiError)
          else setShowLanguage(true)
        } else if (!trimmed.startsWith('/')) {
          // ── interject ───────────────────────────────────────────────────────
          // 执行中的非斜杠输入 = 插队指令：入队，query.ts 在下一轮工具批/纯文本轮末尾
          // 自动拾取并随上下文送入模型（延迟 ≤ 一轮，不打断在飞的流或工具）。
          // 立刻回显为 user 行，给用户「已收到」反馈；ESC 仍是即时叫停的快速通道。
          setInputValue('')
          historyIndexRef.current = -1
          enqueueInterject(trimmed)
          setHistory(prev => [
            ...prev,
            { id: String(entryIdRef.current++), role: 'user', text: trimmed },
          ])
        }
        // 其它斜杠命令在执行中忽略（仅 /mode、/language、/stop 生效），保留已输入文本供稍后提交
        return
      }
      if (!systemPrompt) return  // still loading

      // ── Slash 命令选择器：Enter 落在高亮命令上 ────────────────────────────────
      // 列表打开（/ 开头、无空格、有匹配）时，按高亮项的 enterAction 派发：
      //   complete → 补全 "/goal " 等待输参；execute/panel → 用全名重入正常路由。
      if (trimmed.startsWith('/') && !trimmed.includes(' ')) {
        const matches = allSlashCommands().filter(c => c.name.startsWith(trimmed))
        if (matches.length > 0) {
          const cmd = matches[Math.min(slashIndexRef.current, matches.length - 1)]!
          if (cmd.enterAction === 'complete') {
            setInputValue(cmd.name + ' ')
            return
          }
          if (cmd.name !== trimmed) {
            // 用户在前缀上回车（如 /cl）→ 用解析出的全名重入，命中下方精确路由
            runDetached(handleSubmit(cmd.name), reportDetachedUiError)
            return
          }
          // cmd.name === trimmed 的 execute/panel：继续走下方既有精确路由
        }
      }

      // /stop —— 空闲态：没有在跑的流式查询，但可能有后台子 Agent 仍在运行 → 一并停掉。
      if (trimmed === '/stop') {
        setInputValue('')
        historyIndexRef.current = -1
        stopActiveWork()
        return
      }

      if (trimmed === '/login') {
        setInputValue('')
        historyIndexRef.current = -1
        setShowLogin(true)
        return
      }

      // /internet（及别名 /search）— 配置联网搜索 provider + Key
      if (trimmed === '/internet' || trimmed === '/search') {
        setInputValue('')
        historyIndexRef.current = -1
        setShowInternet(true)
        return
      }

      // /language — 选择界面语言。带参（/language en）直接切，无参或未知码弹向导。
      const langCmdIdle = resolveLanguageCommand(trimmed)
      if (langCmdIdle) {
        setInputValue('')
        historyIndexRef.current = -1
        if (langCmdIdle.kind === 'switch') void handleLanguageDone(langCmdIdle.locale)
        else setShowLanguage(true)
        return
      }

      // ── /model — 查看当前 provider / 模型 / 端点（零 token，纯本地读取 config）──
      if (trimmed === '/model') {
        setInputValue('')
        historyIndexRef.current = -1
        const p = config.provider
        const lines = [
          '**Current model**',
          '',
          `  Provider     ${p}`,
          `  Model        ${p === 'deepseek' ? deepseekResolveModel(resolveAppliedEffort(), config.deepseek.model) : modelId}`,
          `  Endpoint     ${activeBaseUrl()}`,
          `  Max tokens   ${activeMaxTokens()}`,
        ]
        if (p === 'custom') {
          lines.push(`  API style    ${config.custom.apiStyle}`)
        }
        lines.push('', '_Switch with /login._')
        setHistory(prev => [...prev, {
          id: String(entryIdRef.current++),
          role: 'assistant',
          text: lines.join('\n'),
        }])
        return
      }

      // ── /clear — 把会话恢复到刚启动的干净状态，零 token ──────────────────────
      // 一次清空四层状态：① 模型侧对话历史 ② REPL 可见历史 ③ 实时流式缓冲
      // ④ 全局单例（goal / todos / 调度任务）。语义对齐 Claude Code 的 /clear：
      // 新会话从零开始，不向模型发送任何内容。
      if (trimmed === '/clear') {
        setInputValue('')
        historyIndexRef.current = -1

        // ① 模型侧对话历史 —— 下一次 query 不再携带任何上文
        conversationRef.current = []
        clearSectionCache()  // env_info 等会话级 section 与对话一并作废

        // ② 实时流式缓冲 —— 清掉可能残留的半截流式文本 / 工具指示 / 待答问题
        resetStreamingPreview()
        setActiveTool(null)
        setLiveOutput('')
        setPendingQuestion(null)
        setPendingConfirm(null)
        // bridge 队列同步排空：/clear 后没人会再回答，挂着会让发起方工具永远悬挂，
        // 且残留队头会挡住新会话里后续确认/提问的展示。
        cancelAllConfirms()
        cancelAllQuestions()

        // ③ 全局单例 —— goal、todos、所有在跑/已结束的调度任务
        resetSessionStates()                             // 清除 goal/contextTokens/microcompactState                      // 清空 microcompact 时间戳单例（新会话重新计时）
        resetEclipse()                                // 清空 Eclipse 折叠 store（跨会话不残留）
        resetCheckpoints()                            // 清空 /rewind 检查点（新会话无可回滚点）
        transcriptRef.current = createTranscript(process.cwd())  // 新会话 → 新 transcript 文件
        setAuditSession(transcriptRef.current.sessionId)
        loggedLenRef.current = 0
        for (const ns of getAllNamespaces()) clearTodos(ns)  // 清空所有命名空间的 todo
        const aborted = clearAllTasks()               // 协作式中止子 Agent 并丢弃任务字典
        setGoalTick(t => t + 1)
        titleIdle()                                   // 终端标题回到 ◌ 空闲 + 品牌名

        // ④ REPL 可见历史 —— 只留 welcome 面板 + 一行创意清空回执
        const CLEAR_LINES = [
          '◌  slate wiped. the void welcomes you.',
          '◌  all threads cut. silence restored.',
          '◌  context: none. clarity: maximum.',
          '◌  memory dissolved. begin again.',
          '◌  the conversation never happened.',
          '◌  nothing remains. everything is possible.',
          '◌  tabula rasa.',
          '◌  a clean room awaits.',
          '◌  you are new here.',
          '◌  signal lost. static cleared.',
        ]
        const clearLine = CLEAR_LINES[Math.floor(Math.random() * CLEAR_LINES.length)]
        wipeStatic()  // 物理清屏 + 重挂载 Static，否则旧对话残留、welcome/回执不渲染
        const fresh: HistoryEntry[] = [{ id: 'welcome', role: 'welcome', text: '' }]
        fresh.push({
          id: String(entryIdRef.current++),
          role: 'assistant',
          text: aborted > 0
            ? `◎ **/clear** — context cleared. Aborted ${aborted} running agent${aborted === 1 ? '' : 's'}.`
            : (clearLine ?? '◌  tabula rasa.'),
        })
        setHistory(fresh)
        return
      }

      // ── /compact — 手动压缩当前会话（设计文档 §9）────────────────────────────
      if (trimmed === '/compact' || trimmed.startsWith('/compact ')) {
        setInputValue('')
        historyIndexRef.current = -1
        const custom = trimmed.slice('/compact'.length).trim() || undefined
        if (conversationRef.current.length < 4) {
          setHistory(prev => [...prev, {
            id: String(entryIdRef.current++),
            role: 'assistant',
            text: '◌ /compact — conversation too small to compact.',
          }])
          return
        }
        const overhead = Math.ceil(
          ((systemPrompt ?? '').length +
            JSON.stringify(getInteractiveTools().map(t => ({ name: t.name, description: t.description, input_schema: t.inputSchema }))).length) / 4,
        )
        setCompactChars(0)
        setIsCompacting(true)
        try {
          // compactConversation 是 async generator：驱动它、把进度喂给进度条，done 时取返回值。
          const gen = compactConversation(conversationRef.current, {
            trigger: 'manual',
            customInstructions: custom,
            fixedOverheadTokens: overhead,
          })
          let r = await gen.next()
          while (!r.done) {
            if (r.value.type === 'compact_progress') setCompactChars(r.value.chars)
            r = await gen.next()
          }
          const res = r.value
          setIsCompacting(false)
          if (res.compacted) {
            conversationRef.current = res.messages
            resetEclipse() // 手动 /compact 后消息已重建，旧折叠施工图作废
            recordInputTokens(estimateTokens(res.messages) + overhead)
            recordCompactionResult(res.willRetrigger ?? false)
            transcriptRef.current?.appendCompact(res.messages, res.summary ?? '', res.preTokens ?? 0, 'manual')
            loggedLenRef.current = res.messages.length
            setHistory(prev => [...prev, {
              id: String(entryIdRef.current++),
              role: 'assistant',
              text: `─────────  ✦ context compacted${res.willRetrigger ? ' (still large)' : ''}  ─────────`,
            }])
          } else {
            setHistory(prev => [...prev, {
              id: String(entryIdRef.current++),
              role: 'assistant',
              text: '◌ /compact — nothing to compact.',
            }])
          }
        } catch (err: unknown) {
          setIsCompacting(false)
          recordCompactionFailure()
          setHistory(prev => [...prev, {
            id: String(entryIdRef.current++),
            role: 'assistant',
            text: `⚠ /compact failed: ${String(err)}`,
          }])
        }
        return
      }

      // ── /resume — 恢复历史会话（设计文档 §10）────────────────────────────────
      if (trimmed === '/resume' || trimmed.startsWith('/resume ')) {
        setInputValue('')
        historyIndexRef.current = -1
        const arg = trimmed.slice('/resume'.length).trim()
        const sessions = listSessions(process.cwd())
        if (sessions.length === 0) {
          setHistory(prev => [...prev, { id: String(entryIdRef.current++), role: 'assistant', text: '◌ /resume — no past sessions in this directory.' }])
          return
        }
        if (!arg) {
          // 无参 → 打开键盘 picker（↑↓ 选 · Enter 恢复 · Esc 取消）
          resumeSessionsRef.current = sessions.slice(0, 30)
          setResumePickerIndex(0)
          setPendingResumePicker(true)
          return
        }
        const n = parseInt(arg, 10)
        const target = (Number.isFinite(n) && n >= 1 && n <= sessions.length)
          ? sessions[n - 1]
          : sessions.find(s => s.sessionId === arg || s.sessionId.startsWith(arg))
        if (!target) {
          setHistory(prev => [...prev, { id: String(entryIdRef.current++), role: 'assistant', text: `⚠ /resume — session "${arg}" not found.` }])
          return
        }
        restoreSession(target)
        return
      }

      // ── /rename — 给当前会话设置自定义标题（零 token，本地 transcript 元数据）──
      if (trimmed === '/rename' || trimmed.startsWith('/rename ')) {
        setInputValue('')
        historyIndexRef.current = -1
        let title = trimmed.slice('/rename'.length).trim()
        if (!title) {
          try {
            title = await generateRenameTitle(conversationRef.current) ?? ''
          } catch {
            title = ''
          }
          if (!title) {
            setHistory(prev => [...prev, {
              id: String(entryIdRef.current++),
              role: 'assistant',
              text: 'Could not generate a name: no conversation context yet. Usage: /rename <name>',
            }])
            return
          }
        }

        // INTENT: A rename is metadata about the session, not a user turn. Keep it
        // out of conversationRef so it changes resume/UI labels without spending tokens.
        transcriptRef.current?.appendCustomTitle(title)
        titleCustom(title)
        setHistory(prev => [...prev, {
          id: String(entryIdRef.current++),
          role: 'assistant',
          text: `◎ Session renamed to: ${title}`,
        }])
        return
      }

      // ── /rewind — 会话内回滚（对话 + Write/Edit 文件，per-turn 粒度）──────────
      if (trimmed === '/rewind' || trimmed.startsWith('/rewind ')) {
        setInputValue('')
        historyIndexRef.current = -1
        const arg = trimmed.slice('/rewind'.length).trim()
        const cps = listCheckpoints()
        if (cps.length === 0) {
          setHistory(prev => [...prev, { id: String(entryIdRef.current++), role: 'assistant', text: '◌ /rewind — no checkpoints yet in this session.' }])
          return
        }
        if (!arg) {
          // 无参 → 打开键盘 picker（↑↓ 选 · Enter 回滚 · Esc 取消）
          rewindCheckpointsRef.current = cps
          setRewindPickerIndex(0)
          setPendingRewindPicker(true)
          return
        }
        // /rewind N → 直接回滚到第 N 回合之前
        const n = parseInt(arg, 10)
        if (!Number.isFinite(n) || !getCheckpoint(n)) {
          setHistory(prev => [...prev, { id: String(entryIdRef.current++), role: 'assistant', text: `⚠ /rewind — checkpoint #${arg} not found. Use /rewind to pick one.` }])
          return
        }
        rewindTo(n)
        return
      }

      // ── /goal — 设定 / 查看 / 清除完成条件 ───────────────────────────────────
      if (trimmed === '/goal' || trimmed.startsWith('/goal ')) {
        setInputValue('')
        historyIndexRef.current = -1
        const arg = trimmed.slice('/goal'.length).trim()

        // /goal （无参数）→ 显示状态
        if (!arg) {
          setHistory(prev => [...prev, {
            id: String(entryIdRef.current++),
            role: 'assistant',
            text: formatGoalStatus(),
          }])
          return
        }

        // /goal clear|stop|off|reset|none|cancel → 清除激活目标
        if ((GOAL_CLEAR_ALIASES as readonly string[]).includes(arg.toLowerCase())) {
          const cleared = clearGoal()
          setGoalTick(t => t + 1)
          setHistory(prev => [...prev, {
            id: String(entryIdRef.current++),
            role: 'assistant',
            text: cleared
              ? `◎ **/goal** cleared.\n\n> ${cleared.condition}`
              : '◎ **/goal** — no active goal to clear.',
          }])
          return
        }

        // ⑥ 预设模板：/goal test|lint|typecheck|build → 展开为规范、可验证的条件。
        const presetKey = arg.toLowerCase()
        const preset = GOAL_PRESETS[presetKey]
        const condition = preset ?? arg
        if (preset) {
          setHistory(prev => [...prev, {
            id: String(entryIdRef.current++),
            role: 'assistant',
            text: `◎ **/goal** 预设 \`${presetKey}\` 已展开为:\n\n> ${condition}`,
          }])
        }

        // /goal <condition> → 设定目标并立即以 condition 为指令开跑
        if (condition.length > GOAL_MAX_CONDITION_LENGTH) {
          setHistory(prev => [...prev, {
            id: String(entryIdRef.current++),
            role: 'assistant',
            text: `◎ **/goal** condition too long (${condition.length} > ${GOAL_MAX_CONDITION_LENGTH} chars).`,
          }])
          return
        }

        // 先即时反馈 + 开跑，绝不让"设定→开跑"之间出现无任何输出的空白（会被误以为卡死/崩溃）。
        setGoal(condition)
        setGoalTick(t => t + 1)
        setHistory(prev => [...prev, {
          id: String(entryIdRef.current++),
          role: 'assistant',
          text: `◎ **/goal** set — working until this holds:\n\n> ${condition}`,
        }])

        // ③ 质量门（非阻断、后台并发）：非预设条件用小快模型判可验证性，模糊则**异步**补一条
        // 提醒+改写建议。刻意不 await —— 这是辅助提示，不能挡在开跑前拖出 1~2s 无反馈空窗。
        if (!preset) {
          void assessGoalVerifiability(condition)
            .then(verdict => {
              if (!verdict.verifiable) {
                const tip = verdict.suggestion ? `\n\n  建议改写:${verdict.suggestion}` : ''
                setHistory(prev => [...prev, {
                  id: String(entryIdRef.current++),
                  role: 'assistant',
                  text: `◎ **/goal** ⚠ 这个目标可能难以客观验证，容易被误判为完成或诱发走捷径。${tip}\n\n_仍按原条件继续。如要改，敲 \`/goal clear\` 后重设。_`,
                }])
              }
            })
            .catch(() => { /* 质量门是辅助提醒，出错绝不影响主流程 */ })
        }

        // condition 本身就是 directive —— 直接开跑（runConversation 立即置 isStreaming，
        // StreamStatus 的「耗时 · token · Threading the cosmos」状态行随即显示）。
        await runConversation(condition, `/goal ${condition}`)
        return
      }

      if (trimmed === '/help') {
        setInputValue('')
        historyIndexRef.current = -1
        setHistory(prev => [...prev, {
          id: String(entryIdRef.current++),
          role: 'assistant',
          text: [
            '**Available commands:**',
            '',
            '**Session control:**',
            '  /init    — analyze this repo and create/update AGENTS.md project instructions',
            '  /clear   — clear conversation history (also clears any active goal)',
            '  /rename  — rename the current session for /resume and the terminal title',
            '  /resume  — resume a past session (args: session-id or number from /resume list)',
            '  /rewind  — rewind this session — restore conversation + edited files',
            '  /compact — force context compaction now (optional: /compact <focus>)',
            '  /export  — export conversation with folder/path picker',
            '',
            '**Mode:**',
            '  /mode    — select session mode: orbit · cruise · forge · counsel · default (or press Shift+Tab to cycle)',
            '  /goal    — set a completion condition Astraea works toward autonomously',
            '  /stop    — stop current task and any running sub-agents',
            '',
            '**Configuration:**',
            '  /login     — configure API key and provider',
            '  /language  — choose UI & reply language',
            '  /internet  — configure web search provider',
            '  /reason    — set reasoning effort: low · medium · high · max · auto',
            '',
            '**Info:**',
            '  /model   — show the current provider, model, and endpoint',
            '  /usage   — show session token usage & cost',
            '  /mcp     — show MCP server status',
            '  /plugin  — show installed plugins',
            '  /help    — show this message',
            '',
            '**Tasks & automation:**',
            '  /vigil   — manage scheduled background tasks: add · list · delete',
            '  /wechat  — run WeChat chat summary (configured via settings.json)',
          ].join('\n'),
        }])
        return
      }

      if (trimmed === '/export' || trimmed.startsWith('/export ')) {
        setInputValue('')
        historyIndexRef.current = -1
        const arg = trimmed.slice('/export'.length).trim()
        if (arg) {
          await runLocalExport(arg)
        } else {
          setExportPanelIndex(0)
          setPendingExportPath(false)
          setPendingExportPanel(true)
        }
        return
      }

      // /mode <name> — 直接切换到指定模式，零 token 消耗
      const modeArgMatch = trimmed.match(/^\/mode\s+(default|orbit|cruise|forge|counsel)$/)
      if (modeArgMatch) {
        const newMode = modeArgMatch[1] as SessionMode
        setInputValue('')
        historyIndexRef.current = -1
        setMode(newMode)
        setSessionModeState(newMode)
        setHistory(prev => [
          ...prev,
          { id: String(entryIdRef.current++), role: 'mode_banner' as const, text: newMode },
        ])
        return
      }

      // /mode — 展示方向键导航选择器，不走 AI，零 token 消耗
      if (trimmed === '/mode') {
        setInputValue('')
        historyIndexRef.current = -1
        // 预设光标停在当前模式
        const currentIdx = MODE_OPTIONS.findIndex(o => o.value === getMode())
        setModeSelectorIndex(currentIdx >= 0 ? currentIdx : 0)
        setPendingModeSelect(true)
        return
      }

      // /reason <arg> — 带参直接执行（不走 UI），无参弹选择器
      if (trimmed === '/reason' || trimmed.startsWith('/reason ')) {
        setInputValue('')
        historyIndexRef.current = -1
        const arg = trimmed.slice('/reason'.length).trim()
        if (arg) {
          const r = executeReason(arg)
          runDetached(persistReason(r).then(() => {
            setHistory(prev => [...prev, {
              id: String(entryIdRef.current++),
              role: 'assistant',
              text: r.message,
            }])
          }), reportDetachedUiError)
        } else {
          setReasonSelectorIndex(0)
          setPendingReasonSelect(true)
        }
        return
      }

      // pendingModeSelect 激活时，文本输入被 useInput 接管，此分支不应触发
      if (pendingModeSelect) return

      // /vigil — 弹出方向键导航面板
      if (trimmed === '/vigil') {
        setInputValue('')
        historyIndexRef.current = -1
        setVigilPanelIndex(0)
        setPendingVigilPanel(true)
        return
      }

      // /wechat — 立即执行微信聊天整理
      if (trimmed === '/wechat') {
        setInputValue('')
        historyIndexRef.current = -1
        resetSettingsCache()                 // 读取最新 settings.json，避免会话内缓存陈旧
        const wechatRaw = getSettings().wechat
        const validErr = validateWechatSettings(wechatRaw)
        if (validErr) {
          setHistory(prev => [...prev,
            { id: String(entryIdRef.current++), role: 'user', text: '/wechat' },
            { id: String(entryIdRef.current++), role: 'assistant', text: `⚠️ 微信整理配置不完整：\n\n${validErr}` },
          ])
          return
        }
        const wechatSettings = resolveWechatSettings(wechatRaw!)
        // Ensure outputDir exists
        if (!existsSync(wechatSettings.outputDir)) {
          mkdirSync(wechatSettings.outputDir, { recursive: true })
        }
        const today = new Date().toISOString().slice(0, 10)
        const outFile = join(wechatSettings.outputDir, `wechat-summary-${today}.md`)
        const scopeDesc = wechatSettings.scope.type === 'contacts'
          ? `指定联系人：${(wechatSettings.scope as { names: string[] }).names.join('、')}`
          : wechatSettings.scope.type === 'top'
            ? `最近 ${(wechatSettings.scope as { k: number }).k} 个联系人`
            : `所有联系人（上限 ${(wechatSettings.scope as { limit: number }).limit}）`

        setHistory(prev => [...prev, { id: String(entryIdRef.current++), role: 'user', text: '/wechat' }])
        commandHistoryRef.current.push('/wechat')
        setIsStreaming(true); resetStreamingPreview(); setActiveTool('WechatRead'); setLiveOutput('')

        ;(async () => {
          let acc = ''
          const controller = new AbortController()
          const sigintHandler = () => { controller.abort(); abortWechatRead() }
          process.once('SIGINT', sigintHandler)
          try {
            // ── 1. 确定性收集：直接调用工具，scope/days/contacts/organize 全部来自
            //       settings.json，不交给 LLM 决策（杜绝漏联系人 / 错天数 / 错分类）。
            const collected = await WechatReadTool.call(
              { use_settings: true, wechat_settings: wechatSettings },
              { mode: 'default', abortSignal: controller.signal },
            )
            setActiveTool(null)

            if (collected.isError) {
              setHistory(prev => [...prev,
                { id: String(entryIdRef.current++), role: 'assistant', text: `⚠️ 微信读取失败：\n\n${collected.output}` },
              ])
              resetStreamingPreview(); setIsStreaming(false)
              return
            }

            // Per-contact coverage — use the actual contact names from settings,
            // NOT regex-parsed ## headers which would also match prompt sections
            // like "背景说明", "原始聊天记录", "整理任务".
            const contactNames: string[] =
              wechatSettings.scope.type === 'contacts'
                ? (wechatSettings.scope as { names: string[] }).names
                : (() => {
                    const m = collected.output.match(/涉及联系人：(.+)/)
                    return m ? m[1]!.split('、').map((s: string) => s.trim()).filter(Boolean) : []
                  })()

            const coverage = contactNames.map(name => {
              const idx = collected.output.indexOf(`## ${name}`)
              if (idx === -1) return { name, ok: false }
              const body = collected.output.slice(idx).split(/\n## /)[0] ?? ''
              const ok = !body.includes('（未找到消息）') && !/\nError:/.test(body) && !body.includes('No text found')
              return { name, ok }
            })

            // ── 2. LLM 只生成摘要正文（不调用任何工具，杜绝"假装写入"）──
            const aiPrompt = [
              `以下是已收集完毕的微信聊天记录与整理指令（范围：${scopeDesc}；最近 ${wechatSettings.days} 天；整理方式：${wechatSettings.organize.join('、')}）。`,
              `请严格按指令生成摘要。**只输出最终 Markdown 正文本身：不要任何前后说明、不要代码围栏。** 联系人名字保持原始中文，不得翻译。`,
              ``,
              collected.output,
            ].join('\n')

            const msgs = [...conversationRef.current, createUserMessage(aiPrompt)]
            for await (const ev of query(msgs, [], { system: systemPrompt!, maxTurns: 1, enablePromptCaching: true })) {
              if (ev.type === 'text') { acc += ev.text; publishStreamingPreview(acc) }
              else if (ev.type === 'done') { conversationRef.current = ev.messages }
            }

            // ── 3. App 层确定性写入 + 校验 + 如实汇报 ──
            const summary = acc.trim()
            let report: string
            if (!summary) {
              report = `✗ 摘要生成为空，未写入文件。原始采集：\n${coverage.map(c => `${c.name}${c.ok ? ' ✓' : ' ✗未找到消息'}`).join('、')}`
            } else {
              try {
                writeFileSync(outFile, summary + '\n', 'utf-8')
                const missing = coverage.filter(c => !c.ok).map(c => c.name)
                report = [
                  `✓ 摘要已写入：${outFile}（${summary.length} 字）`,
                  `联系人覆盖：${coverage.map(c => `${c.name}${c.ok ? ' ✓' : ' ✗未找到消息'}`).join('、')}`,
                  ...(missing.length ? ['', `⚠️ ${missing.join('、')} 未读到内容——可能是 settings.json 里的名字与微信显示不完全一致，或导航/OCR 失败。`] : []),
                ].join('\n')
              } catch (e) {
                report = `✗ 写入失败：${outFile}\n${String(e)}`
              }
            }
            setHistory(prev => [...prev, { id: String(entryIdRef.current++), role: 'assistant', text: report }])
            resetStreamingPreview(); setIsStreaming(false)
          } catch { setActiveTool(null); resetStreamingPreview(); setIsStreaming(false) }
          finally { process.removeListener('SIGINT', sigintHandler) }
        })()
        return
      }

      // ── Skill 斜杠入口（路径 A，实现文档 §1.2/§1.6）──────────────────────────
      // /<name> [args] 命中 prompt 命令（= skill）且 user-invocable → 读全文注入对话，
      // 并把 skill 的 model / allowed-tools 经 per-query 线程化作用于本次 query。
      // 内置命令是 local/local-jsx，不会落到这里（上方已各自精确路由）。
      if (trimmed.startsWith('/')) {
        const m = trimmed.match(/^\/(\S+)(?:\s+([\s\S]*))?$/)
        if (m) {
          const cmd = findCommand(m[1]!)
          // prompt 命令（= skill）：读全文注入 + per-query model/allowedTools 线程化
          if (cmd && cmd.type === 'prompt' && cmd.userInvocable) {
            const skillArgs = m[2]?.trim() || undefined
            const blocks = await cmd.getPrompt(skillArgs)
            const content = blocks.map(b => b.text).join('\n')
            const extraTools = (cmd.allowedTools ?? [])
              .map(name => findTool(name))
              .filter((t): t is import('../tools/Tool').Tool => !!t)
            await runConversation(content, trimmed, { model: cmd.model, extraTools, skillName: cmd.name })
            return
          }
          // local 命令（表内本地逻辑，如 /mcp）：跑 run() 显示文本，零 token。
          // 注：/model //help 等内置仍由上方既有 handler 抢先 return，不会落到这里。
          if (cmd && cmd.type === 'local' && cmd.userInvocable) {
            setInputValue('')
            historyIndexRef.current = -1
            const res = await cmd.run(m[2]?.trim() || undefined)
            if (res.type === 'text') {
              setHistory(prev => [...prev, { id: String(entryIdRef.current++), role: 'assistant', text: res.value }])
            } else if (res.type === 'preformatted') {
              // 预格式化（/audit 表格等）：落进 <Static> 逐行原样渲染，绕开 markdown，保住对齐与盒线。
              setHistory(prev => [...prev, { id: String(entryIdRef.current++), role: 'preformatted', text: res.value }])
            }
            return
          }
        }
      }

      // 注：不再用关键词正则猜测任务大小来自动切 counsel —— 模式由用户掌控。
      // 是否在执行前先向用户确认方向，交给模型在默认模式下自行判断（见系统提示词）；
      // 需要强制「先问后做」时由用户手动 /mode 进入 counsel。

      // 展开粘贴占位符 → 真实内容喂给模型；history 仍显示用户提交时看到的文本。
      await runConversation(trimmed, displayText)
    },
    [isStreaming, systemPrompt, pendingQuestion, pendingModeSelect, pendingVigilPanel, pendingExportPath, qIndex, selections, freeTexts, submitQuestions, runConversation, stopActiveWork, runLocalExport, reportDetachedUiError],
  )

  const handleLoginDone = useCallback(async (result: LoginResult | null) => {
    setShowLogin(false)
    if (!result) return
    const modelSelectionChanged = updateProviderConfig(result.provider, result.model, result.apiKey, {
      baseUrl: result.baseUrl,
      apiStyle: result.apiStyle,
    })
    resetAllApiClients()
    clearSectionCache()  // drop cached env_info so system prompt shows the new Model/Provider
    markSessionStale()  // 换模型 → 旧分词器的 token 数作废，等新 usage 刷新（设计文档 §6）
    resetEclipse()       // 换模型 → 折叠的 spawn token 计数按旧分词器，作废重来
    setConfigVersion(v => v + 1)  // 让 modelId 重算 → 触发 system prompt 按新模型重建
    if (modelSelectionChanged) await persistReason({ message: '', disk: 'clear' })
    await saveLoginConfigToEnvFiles()
    const successText = formatLoginSuccess(result)
    setHistory(prev => [
      ...prev,
      { id: String(entryIdRef.current++), role: 'assistant', text: successText },
    ])
    // 首次启动：/login 配完模型后，紧接着弹 /language 让用户选语言（两步开机流程）。
    if (firstRunRef.current) {
      firstRunRef.current = false
      setShowLanguage(true)
    }
  }, [])

  const handleLanguageDone = useCallback(async (locale: Locale | null) => {
    setShowLanguage(false)
    if (!locale) return
    setLocale(locale)                          // 先切模块单例，下面的重渲/重建即读新语言
    await updateSettings({ language: locale }) // 显式选择 → 持久化到 settings.json
    setConfigVersion(v => v + 1)               // 触发系统提示重建，注入新的回复语言
    const successText = formatLanguageSuccess(locale)
    setHistory(prev => [
      ...prev,
      { id: String(entryIdRef.current++), role: 'assistant', text: successText },
    ])
    wipeStatic()                               // 重挂载 Static → welcome + 历史按新语言重绘
  }, [wipeStatic])

  const handleInternetDone = useCallback(async (result: InternetResult | null) => {
    setShowInternet(false)
    if (!result) return
    await saveSearchProviderKey(result.provider, result.apiKey)
    resetSearchAdapter()  // 让 WebSearchTool 丢弃单例缓存，下次按新 Key 重建适配器
    const successText = formatInternetSuccess(result)
    setHistory(prev => [
      ...prev,
      { id: String(entryIdRef.current++), role: 'assistant', text: successText },
    ])
  }, [])

  const handleVigilInlineAction = useCallback((actionKey: string, text: string) => {
    if (!text.trim() || !systemPrompt) return
    const trimmed = text.trim()
    setPendingVigilPanel(false)
    setVigilInlineValues({})

    let userText: string
    let aiPrompt: string

    if (actionKey === 'wechat') {
      // Validate settings before creating the vigil task
      const wechatRaw = getSettings().wechat
      const validErr = validateWechatSettings(wechatRaw)
      if (validErr) {
        setHistory(prev => [...prev,
          { id: String(entryIdRef.current++), role: 'user', text: `/vigil wechat ${trimmed}` },
          { id: String(entryIdRef.current++), role: 'assistant', text: `⚠️ 微信整理配置不完整：\n\n${validErr}` },
        ])
        return
      }
      const wechatSettings = resolveWechatSettings(wechatRaw!)
      userText = `/vigil wechat: ${trimmed}`
      aiPrompt = [
        `用户要创建一个定时微信聊天整理任务，执行时间为：${trimmed}`,
        ``,
        `任务配置（来自 settings.json）：`,
        `  范围：${JSON.stringify(wechatSettings.scope)}`,
        `  时间：最近 ${wechatSettings.days} 天`,
        `  整理方式：${wechatSettings.organize.join('、')}`,
        `  输出目录：${wechatSettings.outputDir}`,
        ``,
        `请使用 VigilOnce 或 VigilSchedule 注册任务，任务 prompt 为：`,
        `"整理微信聊天记录。调用 WechatRead 工具，传入参数 { use_settings: true, wechat_settings: ${JSON.stringify(wechatSettings)} }，`,
        `按返回的指令生成摘要，将结果写入 ${wechatSettings.outputDir}/ 目录下以日期命名的 .md 文件。"`,
        ``,
        `重要：`,
        `- 任务 prompt 中联系人名字必须保持原始中文`,
        `- 如果无法从 "${trimmed}" 中识别出明确的执行时间，请创建失败并说明原因`,
      ].join('\n')
    } else {
      userText = actionKey === 'add' ? trimmed : `/vigil delete ${trimmed}`
      aiPrompt = actionKey === 'add'
        ? `Schedule the following as a background task using VigilOnce (one-time) or VigilSchedule (recurring) — choose based on the user's intent: ${trimmed}`
        : `Delete the scheduled vigil task with ID: ${trimmed}. Use VigilDelete.`
    }

    setHistory(prev => [...prev, { id: String(entryIdRef.current++), role: 'user', text: userText }])
    commandHistoryRef.current.push(userText)
    setIsStreaming(true); resetStreamingPreview(); setActiveTool(null); setLiveOutput('')

    const msgs = [...conversationRef.current, createUserMessage(aiPrompt)]
    ;(async () => {
      let acc = ''
      try {
        for await (const ev of query(msgs, getInteractiveTools(), { system: systemPrompt, maxTurns: 10, enablePromptCaching: true })) {
          if (ev.type === 'text') { acc += ev.text; publishStreamingPreview(acc) }
          else if (ev.type === 'done') {
            conversationRef.current = ev.messages
            setHistory(prev => [...prev, { id: String(entryIdRef.current++), role: 'assistant', text: acc }])
            resetStreamingPreview(); setIsStreaming(false)
          }
        }
      } catch { setIsStreaming(false) }
    })()
  }, [systemPrompt])

  // ── 粘贴折叠：大段粘贴 → 占位符；小段 → 原样；拖入文件 → 规整路径 ──────────────
  // 作为 TextInput 的 transformPaste 钩子：只负责「把原始粘贴文本转换成要插入的字符串」，
  // 真正的插入（插到光标处、推进光标）由 TextInput.insertText 完成——这样粘贴就会落在
  // 光标位置，而不是像以前那样一律追加到末尾。
  const transformPaste = useCallback((text: string): string | null => {
    if (!text) return null
    // 拖文件进终端：终端把文件路径当作一段「粘贴」塞进来（含 shell 转义 / 引号 / 末尾空格）。
    // 识别出来就还原成干净的绝对路径，后面跟一个空格方便继续输入。
    const dragged = normalizeDraggedPath(text)
    if (dragged) return dragged + ' '

    const lineCount = text.split('\n').length
    const isLarge = lineCount > 1 || text.length > 200
    if (!isLarge) return text // 小段单行粘贴：原样插入

    const id = ++pasteCounterRef.current
    const summary = lineCount > 1 ? `+${lineCount} lines` : `+${text.length} chars`
    const token = `[Pasted text #${id} ${summary}]`
    pasteStoreRef.current.set(token, text)
    return token
  }, [])

  // 切换会话模式并写入 history 横幅（/mode、ModeSelector、Shift+Tab 共用同一落点）。
  const applyMode = useCallback((newMode: SessionMode) => {
    setMode(newMode)
    setSessionModeState(newMode)
    setHistory(prev => [
      ...prev,
      { id: String(entryIdRef.current++), role: 'mode_banner' as const, text: newMode },
    ])
  }, [])

  useInput((input, key) => {
    if (showLogin || showInternet || showLanguage) return

    // ── 权限确认选择器键盘控制（最高优先，工具执行中也响应）──────────────────
    if (pendingConfirm) {
      if (key.escape) {
        setPendingConfirm(null)
        resolveConfirm({ proceed: false, remember: null }) // Esc = 取消
        return
      }
      const confirmChoices = getConfirmChoices(pendingConfirm.kind)
      if (key.upArrow) {
        setConfirmIndex(i => (i - 1 + confirmChoices.length) % confirmChoices.length)
        return
      }
      if (key.downArrow) {
        setConfirmIndex(i => (i + 1) % confirmChoices.length)
        return
      }
      if (key.return) {
        const choice = confirmChoices[confirmIndex]
        setPendingConfirm(null)
        resolveConfirm(choice ? choice.result : { proceed: false, remember: null })
        // 文件写「本会话全允许」→ 让用户看到模式已切到 cruise。
        // setMode 由 fileWriteGate 统一负责（兼顾无 UI 的 readline 路径，且保证审计在切模式前读到旧 getMode）；
        // 这里只同步 React 状态 + 落一条模式横幅，不重复 setMode，避免抢在 gate 审计判定前改写 getMode()。
        if (choice?.result.remember === 'session-cruise' && getMode() !== 'cruise') {
          setSessionModeState('cruise')
          setHistory(prev => [
            ...prev,
            { id: String(entryIdRef.current++), role: 'mode_banner' as const, text: 'cruise' },
          ])
        }
        return
      }
      return // 吞掉其它按键，确认期间不打字
    }

    // ── ResumePicker 键盘控制 ─────────────────────────────────────────────────
    if (pendingResumePicker) {
      const list = resumeSessionsRef.current
      if (key.escape) { setPendingResumePicker(false); return }
      if (list.length === 0) { setPendingResumePicker(false); return }
      if (key.upArrow) { setResumePickerIndex(i => (i - 1 + list.length) % list.length); return }
      if (key.downArrow) { setResumePickerIndex(i => (i + 1) % list.length); return }
      if (key.return) {
        const target = list[resumePickerIndex]
        setPendingResumePicker(false)
        if (target) restoreSession(target)
        return
      }
      return // 吞掉其它按键
    }

    // ── ExportPanel 键盘控制 ─────────────────────────────────────────────────
    if (pendingExportPanel && !pendingExportPath) {
      if (key.escape) { setPendingExportPanel(false); return }
      if (key.upArrow) { setExportPanelIndex(i => (i - 1 + EXPORT_ACTIONS.length) % EXPORT_ACTIONS.length); return }
      if (key.downArrow) { setExportPanelIndex(i => (i + 1) % EXPORT_ACTIONS.length); return }
      if (key.return) {
        const action = EXPORT_ACTIONS[exportPanelIndex]
        if (!action) return
        if (action.key === 'current') {
          setPendingExportPanel(false)
          runDetached(runLocalExport(undefined), reportDetachedUiError)
        } else if (action.key === 'path') {
          setPendingExportPath(true)
          setInputValue('')
        } else {
          setPendingExportPanel(false)
        }
        return
      }
      return
    }
    if (pendingExportPanel && pendingExportPath && key.escape) {
      setPendingExportPath(false)
      setInputValue('')
      return
    }

    // ── RewindPicker 键盘控制 ─────────────────────────────────────────────────
    if (pendingRewindPicker) {
      const list = rewindCheckpointsRef.current
      if (key.escape) { setPendingRewindPicker(false); return }
      if (list.length === 0) { setPendingRewindPicker(false); return }
      if (key.upArrow) { setRewindPickerIndex(i => (i - 1 + list.length) % list.length); return }
      if (key.downArrow) { setRewindPickerIndex(i => (i + 1) % list.length); return }
      if (key.return) {
        const target = list[rewindPickerIndex]
        setPendingRewindPicker(false)
        if (target) rewindTo(target.turn)
        return
      }
      return // 吞掉其它按键
    }

    // ── VigilPanel 键盘控制 ───────────────────────────────────────────────────
    if (pendingVigilPanel) {
      if (key.escape) { setPendingVigilPanel(false); return }
      if (key.upArrow) { setVigilPanelIndex(i => (i - 1 + VIGIL_ACTIONS.length) % VIGIL_ACTIONS.length); return }
      if (key.downArrow) { setVigilPanelIndex(i => (i + 1) % VIGIL_ACTIONS.length); return }
      if (key.return) {
        const action = VIGIL_ACTIONS[vigilPanelIndex]
        if (!action) return
        if (action.key === 'list') {
          setPendingVigilPanel(false)
          setVigilInlineValues({})
          setHistory(prev => [...prev, { id: String(entryIdRef.current++), role: 'user', text: '/vigil list' }])
          setIsStreaming(true); resetStreamingPreview(); setActiveTool(null); setLiveOutput('')
          const msgs = [...conversationRef.current, createUserMessage('List all scheduled vigil tasks using VigilList.')]
          ;(async () => {
            let acc = ''
            try {
              for await (const ev of query(msgs, getInteractiveTools(), { system: systemPrompt!, maxTurns: 3, enablePromptCaching: true })) {
                if (ev.type === 'text') { acc += ev.text; publishStreamingPreview(acc) }
                else if (ev.type === 'done') {
                  conversationRef.current = ev.messages
                  setHistory(prev => [...prev, { id: String(entryIdRef.current++), role: 'assistant', text: acc }])
                  resetStreamingPreview(); setIsStreaming(false)
                }
              }
            } catch { setIsStreaming(false) }
          })()
        }
        // add / delete: TextInput's onSubmit handles submission — do nothing here
        return
      }
      return
    }

    // ── ModeSelector 键盘控制 ─────────────────────────────────────────────────
    if (pendingModeSelect) {
      if (key.escape) {
        setPendingModeSelect(false)
        return
      }
      if (key.upArrow) {
        setModeSelectorIndex(i => (i - 1 + MODE_OPTIONS.length) % MODE_OPTIONS.length)
        return
      }
      if (key.downArrow) {
        setModeSelectorIndex(i => (i + 1) % MODE_OPTIONS.length)
        return
      }
      if (key.return) {
        const selected = MODE_OPTIONS[modeSelectorIndex]
        if (selected) {
          setPendingModeSelect(false)
          setMode(selected.value)
          setSessionModeState(selected.value)
          setHistory(prev => [
            ...prev,
            {
              id: String(entryIdRef.current++),
              role: 'mode_banner' as const,
              text: selected.value,
            },
          ])
        }
        return
      }
      return
    }

    // ── ReasonSelector 键盘控制 ──────────────────────────────────────────────
    if (pendingReasonSelect) {
      if (key.escape) {
        setPendingReasonSelect(false)
        return
      }
      if (key.upArrow) {
        setReasonSelectorIndex(i => (i - 1 + REASON_OPTIONS.length) % REASON_OPTIONS.length)
        return
      }
      if (key.downArrow) {
        setReasonSelectorIndex(i => (i + 1) % REASON_OPTIONS.length)
        return
      }
      if (key.return) {
        const selected = REASON_OPTIONS[reasonSelectorIndex]
        if (selected) {
          setPendingReasonSelect(false)
          // 滑块选 = 显式确认，对 DeepSeek reasoner 档自动带 --confirm
          const autoConfirm = config.provider === 'deepseek' && ['medium', 'high', 'max'].includes(selected.value)
          const r = executeReason(autoConfirm ? `${selected.value} --confirm` : selected.value)
          runDetached(persistReason(r).then(() => {
            setHistory(prev => [...prev, {
              id: String(entryIdRef.current++),
              role: 'assistant',
              text: r.message,
            }])
          }), reportDetachedUiError)
        }
        return
      }
      return
    }

    // ── Shift+Tab 快速循环会话模式 ────────────────────────────────────────────
    // 终端对 Shift+Tab 发的是 CSI Z（"\x1b[Z"，backtab）；Ink 统一解析为
    // key.tab && key.shift，在 macOS / Linux / Windows Terminal / conhost 上一致，
    // 无需平台分支。必须排在下方 slash 列表的纯 Tab 补全之前，否则会被当成补全吞掉。
    // 流式执行中也允许切换（与 /mode 一致），但 ModeSelector 打开时让它走方向键。
    if (key.tab && key.shift && !pendingModeSelect) {
      applyMode(nextCycleMode(getMode()))
      return
    }

    // ── Ctrl+V：在普通输入态交给主输入框（TextInput enablePaste）自行读剪贴板插到光标处。──
    // 这里只吞掉事件，避免下方逻辑把字面 'v' 当普通输入；真正的粘贴由 TextInput 完成，
    // 这样 Ctrl+V 也能落在光标位置而非追加到末尾。
    if (key.ctrl && (input === 'v' || input === 'V')) {
      return
    }

    // ── Slash 命令选择器：列表打开时 ↑/↓ 导航、Tab 补全 ───────────────────────
    // 列表「打开」⟺ 输入以 / 开头、无空格、有匹配，且非流式/非问答态。
    // Enter 不在此拦截：交给 TextInput.onSubmit → handleSubmit 按 enterAction 派发，
    // 避免 useInput 与 TextInput 同时响应回车导致双触发。
    const slashMatches = matchSlashCommands(inputValue)
    if (slashMatches.length > 0 && !isStreaming && !pendingQuestion) {
      const len = slashMatches.length
      if (key.upArrow) {
        setSlashIndex(i => { const n = (i - 1 + len) % len; slashIndexRef.current = n; return n })
        return
      }
      if (key.downArrow) {
        setSlashIndex(i => { const n = (i + 1) % len; slashIndexRef.current = n; return n })
        return
      }
      if (key.tab) {
        const cmd = slashMatches[Math.min(slashIndexRef.current, len - 1)]!
        // 只替换末尾正在输入的 slash token，保留前面已有文字（句中补全）："我爱 /fron" → "我爱 /frontend-design"
        const prefix = trailingSlashToken(inputValue)?.prefix ?? ''
        setInputValue(prefix + cmd.name)  // 只补全高亮项，永不执行
        return
      }
    }

    // ── 子命令补全：输入 "/selection " 后 ↑/↓ 选、Tab 补全 ─────────────────────
    // 与上方 slash 列表互斥（那个要求无空格，这个要求恰好一个空格）。Tab 只补全，
    // 不执行；补成 "/selection start" 后用户再按 Enter 才运行。
    const subMatch = matchSubcommands(inputValue)
    if (subMatch && subMatch.options.length > 0 && !isStreaming && !pendingQuestion) {
      const len = subMatch.options.length
      if (key.upArrow) {
        setSlashIndex(i => { const n = (i - 1 + len) % len; slashIndexRef.current = n; return n })
        return
      }
      if (key.downArrow) {
        setSlashIndex(i => { const n = (i + 1) % len; slashIndexRef.current = n; return n })
        return
      }
      if (key.tab) {
        const pick = subMatch.options[Math.min(slashIndexRef.current, len - 1)]!
        setInputValue(`${subMatch.name} ${pick}`)
        return
      }
    }

    if (key.escape) {
      // Priority 1: ESC while streaming → cancel the AI request
      if (isStreaming && !pendingQuestion) {
        abortControllerRef.current?.abort()
        clearInterjects()  // 叫停 = 连未拾取的插队一并丢弃，不让它泄漏到下一次运行
        setIsStreaming(false)
        resetStreamingPreview()
        setActiveTool(null)
        setLiveOutput('')
        commitLiveTools()  // 已跑完的工具批先落盘，排在中断回执之前（顺序正确）
        setHistory(prev => [
          ...prev,
          { id: String(entryIdRef.current++), role: 'status', status: 'error', text: '■ cancelled' },
        ])
        // 把刚发出的原文回填到 input box，免得用户重打一遍（仅在框为空时，不覆盖插队草稿）。
        if (cancelRestoreRef.current && !inputValue) {
          setInputValue(cancelRestoreRef.current)
          historyIndexRef.current = -1
        }
        cancelRestoreRef.current = ''
        return
      }

      // Priority 1.5: Esc from ✎ free-text → back to the option list (keep panel open)
      if (pendingQuestion && questionFreeText) {
        setQuestionFreeText(false)
        setInputValue('')
        return
      }

      // Priority 2: Dismiss pending question
      if (pendingQuestion) {
        setPendingQuestion(null)
        setInputValue('')
        setQuestionFreeText(false)
        answer('')
        return
      }

      // Priority 3: Double-press to clear input (800ms window)
      const now = Date.now()
      const isDoublePress = (now - lastEscPressRef.current) <= 800 && escPendingTimerRef.current !== null

      if (escPendingTimerRef.current) {
        clearTimeout(escPendingTimerRef.current)
        escPendingTimerRef.current = null
      }

      if (isDoublePress && inputValue) {
        // Second ESC: clear input, save to command history
        setEscClearHint(false)
        lastEscPressRef.current = 0
        if (inputValue.trim()) commandHistoryRef.current.push(inputValue)
        setInputValue('')
        historyIndexRef.current = -1
      } else if (inputValue) {
        // First ESC with non-empty input: show "Esc again to clear" hint
        lastEscPressRef.current = now
        setEscClearHint(true)
        escPendingTimerRef.current = setTimeout(() => {
          setEscClearHint(false)
          escPendingTimerRef.current = null
        }, 800)
      } else {
        // Empty input: clear history navigation, dismiss any stale hint
        setEscClearHint(false)
        lastEscPressRef.current = 0
        historyIndexRef.current = -1
      }
      return
    }
    if (isStreaming && !pendingQuestion) return

    // AskUserQuestion multi-question panel navigation.
    //   ←→ switch question · ↑↓ move cursor · Space toggle/pick · Enter confirm/submit
    // The last row (index === options.length) is the ✎ free-text escape.
    // While free-text is active the TextInput owns keystrokes, so do nothing here.
    if (pendingQuestion && !questionFreeText) {
      const questions = pendingQuestion.questions
      const q = questions[qIndex]
      if (!q) return
      const otherRow = q.options.length
      const cursor = optCursor[qIndex] ?? 0

      const nav = navigateQuestionPanel({
        questionsLength: questions.length,
        qIndex,
        optCursor,
        optionCount: otherRow,
      }, key)
      if (nav) {
        setQIndex(nav.qIndex)
        setOptCursor(nav.optCursor)
        return
      }

      // Space: open free-text on the ✎ row, otherwise toggle/pick the cursor option
      if (input === ' ') {
        if (cursor === otherRow) { setQuestionFreeText(true); return }
        if (q.multiSelect) {
          setSelections(prev => {
            const arr = (prev[qIndex] ?? []).slice()
            const at = arr.indexOf(cursor)
            if (at >= 0) arr.splice(at, 1)
            else arr.push(cursor)
            return setAt(prev, qIndex, arr.sort((a, b) => a - b))
          })
        } else {
          // single-select radio: pick this one, clear the rest (toggle off if same)
          setSelections(prev => setAt(prev, qIndex, (prev[qIndex] ?? []).includes(cursor) ? [] : [cursor]))
        }
        // choosing an option supersedes any free text for this question
        setFreeTexts(prev => setAt(prev, qIndex, ''))
        return
      }

      if (key.return) {
        if (cursor === otherRow) { setQuestionFreeText(true); return }
        // Ensure the current question has an answer; if none, take the cursor option.
        let sel = selections
        if (!qAnswered(selections[qIndex], freeTexts[qIndex])) {
          sel = setAt(selections, qIndex, [cursor])
          setSelections(sel)
        }
        const allAnswered = questions.every((_, i) => qAnswered(sel[i], freeTexts[i]))
        if (allAnswered) submitQuestions(questions, sel, freeTexts)
        else setQIndex(nextUnanswered(questions, sel, freeTexts, qIndex))
        return
      }
      return
    }

    if (key.upArrow) {
      const hist = commandHistoryRef.current
      if (hist.length === 0) return
      if (historyIndexRef.current === -1) draftInputRef.current = inputValue
      historyIndexRef.current =
        historyIndexRef.current === -1 ? hist.length - 1 : Math.max(0, historyIndexRef.current - 1)
      setInputValue(hist[historyIndexRef.current]!)
      return
    }
    if (key.downArrow) {
      if (historyIndexRef.current === -1) return
      const hist = commandHistoryRef.current
      if (historyIndexRef.current >= hist.length - 1) {
        historyIndexRef.current = -1
        setInputValue(draftInputRef.current)
      } else {
        historyIndexRef.current++
        setInputValue(hist[historyIndexRef.current]!)
      }
    }
  })

  const toolNames = getInteractiveTools().map(t => t.name)

  const modelName =
    config.provider === 'deepseek'
      ? deepseekResolveModel(resolveAppliedEffort(), config.deepseek?.model ?? '')
      : activeModel()

  // 执行中输入框保持可用（不锁定）：用户可随时 /mode 切换。仅在模式/面板覆盖层时让出焦点。
  const inputFocused = !pendingReasonSelect && !pendingModeSelect && !pendingVigilPanel && !pendingConfirm && !pendingResumePicker && !pendingRewindPicker && (!pendingExportPanel || pendingExportPath)
  const inputPlaceholder = pendingQuestion
    ? 'Type your answer… (Esc to skip)'
    : pendingExportPath
      ? 'Paste export file or folder path…'
      : isStreaming
      ? 'Astraea is working… type to interject · Esc to cancel'
      : systemPrompt === null
        ? 'Initializing...'
        : 'Message Astraea… (Ctrl+C to exit)'

  // ─────────────────────────── 渲染 ──────────────────────────────────────────

  return (
    <Box flexDirection="column">
      <Static key={staticEpoch} items={history}>
        {(entry, index) => {
          if (entry.role === 'welcome') {
            return (
              <WelcomePanel
                key={entry.id}
                version={VERSION}
                cwd={process.cwd()}
                model={modelName}
                tools={toolNames}
              />
            )
          }
          if (entry.role === 'status') {
            // 状态行：marker 与「第一个提醒词」一起按状态色上色（marker 作状态锚点，
            // 与工具头 ⏺ 同规则），仅补充文字留白（success 绿 / pending 黄 / error 红）。
            const { marker, keyword, rest } = splitStatusLine(entry.text)
            return (
              <Box key={entry.id} marginBottom={1}>
                <Text wrap="truncate-end">
                  <Text color={STATUS_COLOR[entry.status ?? 'pending']}>{marker}{keyword}</Text>
                  {rest}
                </Text>
              </Box>
            )
          }
          if (entry.role === 'done_notification') {
            return (
              <Box key={entry.id} marginBottom={1}>
                <Text color={INDIGO}>{entry.text}</Text>
              </Box>
            )
          }

          if (entry.role === 'preformatted') {
            // 预格式化块（/audit 表格）：逐行原样渲染（ANSI 透传），不走 markdown，保住对齐/盒线。
            // 每行独立 <Text>，避免单个超长 Text 在窄终端被 Ink 折行打乱表格。
            return (
              <Box key={entry.id} flexDirection="column" marginBottom={1}>
                {entry.text.split('\n').map((line, i) => (
                  <Text key={i}>{line}</Text>
                ))}
              </Box>
            )
          }
          if (entry.role === 'mode_banner') {
            // 切换模式不再在 scrollback 里展示 "── switched to X ──" 横幅（用户嫌刷屏）。
            // 当前模式仍由输入框的 ModeInputFrame 边框标签持续可见，足够。
            return null
          }
          if (entry.role === 'skill_banner') {
            return (
              <Box key={entry.id} marginBottom={1}>
                <Text color={INDIGO}>✦ skill </Text>
                <Text bold color={INDIGO}>/{entry.text}</Text>
                <Text color={INDIGO} dimColor> loaded.</Text>
              </Box>
            )
          }
          if (entry.role === 'tools') {
            // 已落盘的工具批：逐调用配对 + 同类折叠由 <ToolBatch> 统一渲染。
            return <ToolBatch key={entry.id} calls={entry.calls ?? []} />
          }
          if (entry.role === 'user') {
            // 用户消息（含斜杠命令）整块铺 DEEP 深蓝底 + 横向内边距 → 与 Astraea 回复明显区分。
            // 对齐 CC 的 userMessageBackground；底色 hug 内容（最宽行决定块宽）。
            return (
              <Box key={entry.id} flexDirection="column" marginBottom={1} backgroundColor={DEEP} paddingX={1}>
                <Text bold color="green">❯ You</Text>
                <Text>{entry.text}</Text>
              </Box>
            )
          }
          // 其余（assistant 及以 assistant 角色落盘的系统提示）走 markdown 渲染。
          // 一个 turn 会被拆成「文本→工具批→文本→…」多条 assistant/tools 条目，但它们同属
          // Astraea 的一次发言。仅在 turn 起点（上一条不是 assistant/tools）打一次 ✦ Astraea，
          // 其余续接条目不再重复刷头（eval Item 6：✦ Astraea 只该展示一次）。
          const prevRole = index > 0 ? history[index - 1]?.role : undefined
          const showHeader = prevRole !== 'assistant' && prevRole !== 'tools'
          // turn 起点打全头「✦ Astraea」独占一行、正文在其下；续接的工具前叙述句则把
          // 一颗靛蓝 ✦ 与该句正文排在同一行（行内前导星，折行走悬挂缩进）。
          if (showHeader) {
            return (
              <Box key={entry.id} flexDirection="column" marginBottom={1}>
                <Text bold color={INDIGO}>{STAR} Astraea</Text>
                <Text bold>{renderMarkdown(entry.text)}</Text>
              </Box>
            )
          }
          return (
            <Box key={entry.id} flexDirection="row" marginBottom={1}>
              <Text bold color={INDIGO}>{STAR} </Text>
              <Box flexDirection="column" flexGrow={1}>
                <Text bold>{renderMarkdown(entry.text)}</Text>
              </Box>
            </Box>
          )
        }}
      </Static>

      {/* 启动动画 —— 仅 booting 期间在 live 区独占顶部，结束后由 handleBootDone 收起。 */}
      {booting && <AstraeaIntro onDone={handleBootDone} />}

      {shouldRenderAgentActivity({
        isStreaming,
        hasPendingConfirm: pendingConfirm !== null,
      }) && (() => {
        // live 区与 Static 同一套去重逻辑：若本 turn 已经在前面的 assistant/tools 条目打过
        // ✦ Astraea，续接的流式文本就不再重复刷头（eval Item 6）。
        const lastRole = history.length > 0 ? history[history.length - 1]?.role : undefined
        const showHeader = lastRole !== 'assistant' && lastRole !== 'tools'
        // 状态行（StreamStatus）已移到 Tasks 面板下方（eval Item 12），live frame 不再有常驻
        // 末行兜底。本帧是否该渲染只看「真有正文/工具」——不把 showHeader 算进去（详见
        // hasLiveBody 注释）：否则 turn 起点会先画一个空的 ✸ Astraea 头、干等思考、内容才
        // 姗姗冒出（问题3）。空窗期交给下方 StreamStatus 思考行表示「在干活」。
        const hasBody = hasLiveBody({ streamingText, liveToolCount: liveTools.length, activeTool })
        if (!hasBody) return null
        // 视口预算：流式预览 + 在途工具批 共享 (终端行数 - 页脚预留)，避免 live frame 超过视口
        // 高度导致 Ink 擦除越界、视口跳到最顶。页脚预留按「当前激活的常驻页脚元素」动态累加
        // （取代写死的 12）：页脚越高，留给 live frame 的预算越小，从根上杜绝越界；一律向上估 +2 余量。
        const goalLines = getActiveGoal() ? 7 : 0            // GoalPanel 带框约 7 行
        const todoLines = getTodos('main').length > 0 ? 1 : 0   // TodoStatusLine 恒高单行
        const agentLines = runningAgents.length               // 已移到输入框下方，但仍占视口高度
        const ctxUsed = getInputTokens()
        const ctxLines = ctxUsed !== null && ctxUsed >= activeThresholds().warning ? 1 : 0
        const compactLines = isCompacting ? 1 : 0
        const footerReserve =
          FOOTER_RESERVE_BASE + 1 /* StreamStatus 常驻 */ +
          goalLines + todoLines + agentLines + ctxLines + compactLines + 2 /* 安全余量 */
        const liveBudget = Math.max(8, (rows ?? 24) - footerReserve)
        // 有工具批时预览收窄（只留个"还在写"的尾巴），把更多预算让给工具行；纯文本时给足。
        const previewMax = liveTools.length > 0
          ? Math.max(4, Math.floor(liveBudget * 0.35))
          : Math.max(8, (rows ?? 24) - 14)
        // 工具批余下预算（按每次调用约 2 行估算），只渲染最近 maxToolCalls 次，更早的折叠成一行提示。
        const toolBudgetLines = liveBudget - (streamingText ? Math.min(previewMax, 6) : 0)
        const maxToolCalls = Math.max(3, Math.floor(toolBudgetLines / 2))
        const foldedToolCount = Math.max(0, liveTools.length - maxToolCalls)
        const shownTools = foldedToolCount > 0 ? liveTools.slice(-maxToolCalls) : liveTools
        return (
        <Box flexDirection="column" marginBottom={1}>
          {(() => {
            // 流式正文预览（落盘前的"进行中"截断版；完整版本轮结束进 <Static>）。
            // 实时预览只渲染尾部若干行，把帧高封顶 → 避免越界擦除把页脚/输入框盖住。
            const maxLines = previewMax
            // 所有平台都按列宽硬截断流式预览：Ink 擦除按"换行符行数"算，但超宽行（尤其
            // 中文全角=2 宽）会被终端自动折行成多物理行，导致擦不干净、星与正文一层层
            // 重影堆叠（eval Item 14：同一行 ✸… 在 REPL 里复印了几十遍）。把预览截成
            // "每行不超宽的纯文本"，让逻辑行数==物理行数，擦除才数得准。富文本完整版
            // 仍在本轮结束进 <Static>，仅流式中的瞬时预览退化为无色纯文本。
            //
            // 关键：行内续接态（!showHeader）预览左侧多出 "✸ "（2 列）前缀，与正文同行。
            // 若仍按整宽截断，星+正文合计会超出终端 1~2 列 → 末行软折行 → Ink 擦除少算
            // 行数 → ✸ 行一层层重影堆叠（Windows 实测：同一句叙述被复印数遍）。这里按
            // 是否带前导星预留对应列宽，保证含星后整行仍不超宽。
            const starCols = showHeader ? 0 : 2   // 行内分支左侧 "✸ " 占 2 列
            const cols = Math.max(1, (columns ?? 80) - 1 - starCols)
            const previewEl = streamingText
              ? <Text bold>{safeAnsiPreview(renderMarkdown(streamingText), cols, maxLines)}</Text>
              : null
            // turn 起点：「STAR Astraea」独占一行、正文在下。
            if (showHeader) {
              return (
                <>
                  <Text bold color={INDIGO}>{STAR} Astraea</Text>
                  {previewEl}
                </>
              )
            }
            // 续接的工具前叙述句：星与正文同一行（行内前导星，折行悬挂缩进）。
            // 纯工具续接（无流式正文）时不画孤星。
            if (!previewEl) return null
            return (
              <Box flexDirection="row">
                <Text bold color={INDIGO}>{STAR} </Text>
                <Box flexDirection="column" flexGrow={1}>{previewEl}</Box>
              </Box>
            )
          })()}
          {/* 在途工具批：逐调用配对 + 同类折叠，liveOutput 挂在 running 调用下。
              只渲染最近 maxToolCalls 次（封顶 live frame 高度）；更早的已会在轮末落进 <Static>，
              这里用一行 dim 提示占位，不丢信息也不撑爆视口。 */}
          {foldedToolCount > 0 && (
            <Text color="gray" dimColor>⋯ {foldedToolCount} earlier tool call{foldedToolCount === 1 ? '' : 's'} above</Text>
          )}
          {liveTools.length > 0 && <ToolBatch calls={shownTools} liveOutput={liveOutput} />}
          {/* 次要查询循环（如 WechatRead）只设 activeTool、不入 liveTools → 退回单行 spinner。 */}
          {liveTools.length === 0 && activeTool && (
            <Box flexDirection="column">
              <Text><Text color="yellow">{'⏺ '}{activeTool}</Text>…</Text>
              {liveOutput && (
                <Box flexDirection="column" marginLeft={4}>
                  {liveOutput.trimEnd().split('\n').slice(-20).map((line, i) => (
                    // 同样按列数硬截断，避免超宽行折行后擦不干净、一层层重影（见 safeWinPreview）。
                    <Text key={i} color="gray" dimColor>⎿  {clampLineWidth(line, Math.max(1, (columns ?? 80) - 6))}</Text>
                  ))}
                </Box>
              )}
            </Box>
          )}
        </Box>
        )
      })()}

      {/* ◎ /goal 进度统一交给下方常驻 GoalPanel（此前这里另有一行 inline ◎ /goal active，
          与 GoalPanel 信息重复、徒占一行，已移除——单一真相源见 <GoalPanel/>）。 */}

      {/* ◌ 压缩进度条（设计文档 §9）—— 摘要流式生成驱动 */}
      {isCompacting && (() => {
        const CELLS = 24
        const TARGET = 60_000 // 典型摘要字符数（~15K tokens），到 99% 封顶等收尾
        const frac = Math.min(0.99, compactChars / TARGET)
        const filled = Math.round(frac * CELLS)
        const bar = '█'.repeat(filled) + '░'.repeat(CELLS - filled)
        const approxK = (compactChars / 4 / 1000).toFixed(1)
        return (
          <Box marginBottom={1}>
            <Text color={INDIGO}>◌ compacting  [{bar}]  ~{approxK}K tokens</Text>
          </Box>
        )
      })()}

      {/* ✦ 上下文用量指示器 —— 接近自动压缩时常驻提示（设计文档 §9）*/}
      {(() => {
        void goalTick // 借用每秒 tick 触发刷新
        const used = getInputTokens()
        if (used === null) return null
        const th = activeThresholds()
        if (used < th.warning) return null
        const pctOfEff = Math.min(100, Math.round((used / th.effectiveWindow) * 100))
        const left = percentLeft(used, th.autocompact)
        const atCompact = used >= th.autocompact
        return (
          <Box marginBottom={1}>
            <Text color={atCompact ? 'red' : 'yellow'}>
              {atCompact ? '⚠' : '◔'} context {pctOfEff}% · ~{left}% to autocompact
            </Text>
          </Box>
        )
      })()}

      {/* AskUserQuestion multi-question panel */}
      {pendingQuestion && (
        <QuestionPanel
          questions={pendingQuestion.questions}
          qIndex={qIndex}
          optCursor={optCursor}
          selections={selections}
          freeTexts={freeTexts}
        />
      )}

      {showLogin && <LoginWizard onDone={handleLoginDone} />}
      {showInternet && <InternetWizard onDone={handleInternetDone} />}
      {showLanguage && <LanguageWizard onDone={handleLanguageDone} />}

      {/* ConfirmSelector — 权限确认方向键选择器，覆盖输入框 */}
      {pendingConfirm && (
        <ConfirmSelector
          command={pendingConfirm.command}
          description={pendingConfirm.description}
          selectedIndex={confirmIndex}
          kind={pendingConfirm.kind}
        />
      )}

      {/* ModeSelector — 方向键导航，覆盖输入框 */}
      {pendingModeSelect && (
        <ModeSelector
          currentMode={sessionMode}
          selectedIndex={modeSelectorIndex}
        />
      )}

      {/* ReasonSelector — 方向键导航选推理强度 */}
      {pendingReasonSelect && (
        <ReasonSelector
          selectedIndex={reasonSelectorIndex}
          provider={config.provider}
        />
      )}

      {/* ResumePicker — 历史会话恢复选择器（/resume） */}
      {pendingResumePicker && (
        <ResumePicker
          sessions={resumeSessionsRef.current}
          selectedIndex={resumePickerIndex}
        />
      )}

      {pendingExportPanel && (
        <ExportPanel
          selectedIndex={exportPanelIndex}
          pathMode={pendingExportPath}
        />
      )}

      {/* RewindPicker — 会话内回滚检查点选择器（/rewind） */}
      {pendingRewindPicker && (
        <RewindPicker
          checkpoints={rewindCheckpointsRef.current}
          selectedIndex={rewindPickerIndex}
        />
      )}

      {/* VigilPanel — 定时任务操作选择 */}
      {pendingVigilPanel && (
        <VigilPanel
          selectedIndex={vigilPanelIndex}
          inlineValues={vigilInlineValues}
          onInlineChange={(key, value) => setVigilInlineValues(prev => ({ ...prev, [key]: value }))}
          onInlineSubmit={handleVigilInlineAction}
        />
      )}

      {/* /goal 实时进度面板 —— 目标激活期间常驻输入框上方，随 goalTick 每秒刷新。 */}
      <GoalPanel running={isStreaming} />

      {/* 恒高单行 todo 摘要（○p ◉i ●c · 当前任务）：永远 1 行或 0 行，不再顶飞输入框。
          清单本体随 TodoWrite 工具调用内联进 <Static> 滚走（见上方移除的 TodoWrite 跳过）。 */}
      <TodoStatusLine columns={columns} />

      {/* 常驻状态行：流式期间一直显示（轮换短语 + 实时秒数 + token + esc 提示），
          解决"跑到一半停住、不知是否还在运行"的问题。钉在 Tasks 面板下方（eval Item 12：
          状态行应展示在 Tasks 列表下面，而非其上方）。 */}
      {shouldRenderAgentActivity({
        isStreaming,
        hasPendingConfirm: pendingConfirm !== null,
      }) && <StreamStatus startTime={streamStart} tokens={liveTokens} />}

      {!showLogin && !showInternet && !showLanguage && !pendingReasonSelect && !pendingModeSelect && !pendingVigilPanel && !pendingConfirm && !pendingResumePicker && !pendingRewindPicker && (!pendingExportPanel || pendingExportPath) && (
        <ModeInputFrame mode={sessionMode} running={isStreaming} value={inputValue}>
          {/* While the question panel is open, hide the text input — the panel owns
              ←→/↑↓/Space/Enter. Once the user picks ✎ 自填 (questionFreeText), reveal
              the box so they can type a free answer for the current question. */}
          {pendingQuestion && !questionFreeText ? (
            <Box>
              <Text bold color="yellow">←→ question · ↑↓ move · Space select · Enter confirm · Esc skip</Text>
            </Box>
          ) : (
            <>
              {escClearHint && (
                <Box>
                  <Text color="gray" dimColor>Esc again to clear</Text>
                </Box>
              )}
              {!pendingExportPath && <SlashHint input={inputValue} selectedIndex={slashIndex} />}
              {!pendingExportPath && <SubcommandHint input={inputValue} selectedIndex={slashIndex} />}
              <GoalHint input={inputValue} />
              <Box>
                <Text bold color={inputFocused && !isStreaming ? INDIGO : pendingQuestion ? 'yellow' : 'gray'}>
                  {pendingQuestion ? '? ' : isStreaming ? '  ' : '✦ '}
                </Text>
              <TextInput
                  value={inputValue}
                  onChange={val => {
                    historyIndexRef.current = -1
                    setInputValue(val)
                  }}
                  onSubmit={value => runDetached(handleSubmit(value), reportDetachedUiError)}
                  focus={inputFocused}
                  placeholder={inputPlaceholder}
                  enablePaste
                  transformPaste={transformPaste}
                />
              </Box>
            </>
          )}
        </ModeInputFrame>
      )}

      {/* 后台子 Agent spinner —— 移到输入框下方（此前在输入框上方，与 GoalPanel/Tasks 一起把
          输入框越顶越低）。即便主 Agent 空闲也显示；高度已计入上方 footerReserve。 */}
      {runningAgents.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {runningAgents.map(agent => (
            <Box key={agent.id}>
              <Text color="cyan">⟳  [{agent.id}] {agent.description}</Text>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  )
}
