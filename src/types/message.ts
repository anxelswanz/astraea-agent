// 核心消息类型 — 对齐 Anthropic API 格式
// 参考源码: claude-code-main/src/types/message.ts

import type { MessageParam } from '@anthropic-ai/sdk/resources/messages'

// ───────────────────────────────── 基础块类型 ─────────────────────────────────

export interface TextBlock {
  type: 'text'
  text: string
}

export interface ToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  content: string | TextBlock[]
  is_error?: boolean
}

// ───────────────────────────────── 消息类型 ──────────────────────────────────

// 用户消息（内部表示）
export interface UserMessage {
  role: 'user'
  content: string | (TextBlock | ToolResultBlock)[]
  // 引擎注入的一次性指令（stop-hook 续跑、目标续跑、截断续写…）。仅对「当轮」有效：
  // 下次 query() 启动时由 stripReminders 剥离，绝不沉淀进持久历史，否则会被后续轮次
  // 当成「用户的要求」反复重放（v0.10.27 旧任务复读 bug）。toAPIMessage 只取
  // role/content，本字段不会外泄到 API。
  ephemeral?: true
}

// 助手消息（内部表示）
export interface AssistantMessage {
  role: 'assistant'
  content: (TextBlock | ToolUseBlock)[]
}

export type Message = UserMessage | AssistantMessage

// ───────────────────────────────── 流式事件 ──────────────────────────────────

// 模型停止本轮输出的原因。'max_tokens' 表示撞到输出上限被截断（产物可能不完整）。
export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'other'

// 我们自己的流事件，比 SDK 原始事件更精简
export type StreamEvent =
  | { type: 'text'; text: string }
  // 扩展思考（extended thinking / reasoning_content）的增量。仅作"连接仍活跃"的心跳信号：
  // 空闲看门狗据此重置计时，避免长思考被误判成半开连接而 abort。上层（query/UI）可忽略，
  // 不计入 assistantMessage 的 content（思考内容不回灌对话历史）。
  | { type: 'thinking'; text: string }
  // incomplete: 工具入参 JSON 在累积过程中被截断、parse 失败 —— 不可执行，需让模型重试
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown>; incomplete?: boolean }
  // 开启 prompt caching 后，input 被服务器拆成三份：input_tokens（本轮未命中缓存的新增）、
  // cache_read_input_tokens（命中缓存读取）、cache_creation_input_tokens（写入缓存）。
  // 三者都实打实占着上下文窗口，量真实上下文用量时必须三项相加（见 TokenUsage 工具）。
  // cache_* 为可选：仅 Anthropic 返回，其它 provider（无缓存概念）省略 → 视为 0。
  | {
      type: 'message_stop'
      usage: {
        input_tokens: number
        output_tokens: number
        cache_read_input_tokens?: number
        cache_creation_input_tokens?: number
      }
      stopReason?: StopReason
    }

// 真实上下文 input 用量 = 三项 input 之和（不含 output，对齐状态行/压缩阈值口径）。
// 参照 claude-code-main/src/utils/context.ts:131 calculateContextPercentages。
export function contextInputTokens(usage: {
  input_tokens: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}): number {
  return (
    usage.input_tokens +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0)
  )
}

// ───────────────────────────────── 工具函数 ──────────────────────────────────

// 把内部 Message 转成 Anthropic API 需要的 MessageParam 格式
export function toAPIMessage(msg: Message): MessageParam {
  if (msg.role === 'user') {
    if (typeof msg.content === 'string') {
      return { role: 'user', content: msg.content }
    }
    return {
      role: 'user',
      content: msg.content.map((block) => {
        if (block.type === 'tool_result') {
          return {
            type: 'tool_result' as const,
            tool_use_id: block.tool_use_id,
            content: typeof block.content === 'string' ? block.content : block.content,
            is_error: block.is_error,
          }
        }
        return block
      }),
    }
  }

  // assistant
  return {
    role: 'assistant',
    content: msg.content,
  }
}

export function createUserMessage(text: string): UserMessage {
  return { role: 'user', content: text }
}

export function createAssistantMessage(content: (TextBlock | ToolUseBlock)[]): AssistantMessage {
  return { role: 'assistant', content }
}
