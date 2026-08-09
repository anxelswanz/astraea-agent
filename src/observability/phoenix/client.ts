// ─────────────────────────────────────────────────────────────────────────────
// 总电源（client）—— 初始化/关闭 OTel Provider，并缓存 @arizeai/phoenix-otel 命名空间。
// 对标 claude-code: src/services/langfuse/client.ts
//
// 设计要点：
//   • 懒加载 + fail-open —— 用 `await import()` 动态加载 phoenix-otel。
//     未设 PHOENIX_ENABLED / 未 `bun add` 该依赖 / register 抛错 → 一律降级 no-op，
//     astraea 主流程绝不受影响（连"包没装"都不会让进程崩）。
//   • 路线 B 用「手工建 span」，不依赖自动埋点，因此不要求"早于 SDK import 初始化"——
//     在 query() 顶部调一次 initPhoenix() 即可覆盖所有入口（CLI/REPL/headless/子 agent）。
//   • 默认即时导出（batch=false）：CLI 单发跑完即退，避免 BatchSpanProcessor 缓冲丢 span。
//     高吞吐场景设 PHOENIX_BATCH=1 切回批量。
//
// 后端（可单开、可双开，互不感知）：
//   • Phoenix  —— PHOENIX_ENABLED=1
//   • Langfuse —— LANGFUSE_PUBLIC_KEY + LANGFUSE_SECRET_KEY
//   两者只是挂在同一个 provider 上的两个 SpanProcessor：同一份 span 同时发往两边。
//   之所以能这么省事，是因为 register() 支持传 spanProcessors[]，且 tracing.ts 写的
//   OpenInference 属性里 session.id / user.id / input.value / llm.* 恰好也是 Langfuse
//   原生认的（详见 tracing.ts 顶部的属性对照表）。
// ─────────────────────────────────────────────────────────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any */

import { sanitizeGlobal } from './sanitize'

let otel: any = null // 缓存的 @arizeai/phoenix-otel 命名空间（含 trace/context/SemanticConventions…）
let provider: any = null // register() 返回的 TracerProvider（带 forceFlush/shutdown）
let initialized = false
let backends: string[] = [] // 实际接通的后端，供 /audit 之类的自检展示

/** 是否启用 Phoenix 后端（显式开关，默认关 → 零开销）。 */
export function isPhoenixEnabled(): boolean {
  const v = process.env.PHOENIX_ENABLED?.trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'on' || v === 'yes'
}

/** 是否启用 Langfuse 后端（有密钥即启用，对标 claude-code 的判定）。 */
export function isLangfuseEnabled(): boolean {
  return !!(process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY)
}

/** 实际接通的后端列表（如 ['phoenix','langfuse']）。未激活时为空数组。 */
export function getActiveBackends(): string[] {
  return backends
}

/** 是否「真正激活」：启用 + 依赖已加载成功。所有建 span 的 helper 据此 fail-open。 */
export function isPhoenixActive(): boolean {
  return otel !== null
}

/** 取缓存的 phoenix-otel 命名空间（未激活时为 null）。 */
export function getOtel(): any {
  return otel
}

/** 取 astraea 专用 tracer（未激活时为 null）。 */
export function getTracer(): any {
  if (!otel) return null
  try {
    return otel.trace.getTracer('astraea')
  } catch {
    return null
  }
}

/**
 * 造 Langfuse 的 SpanProcessor。可选依赖，装没装都不影响主流程。
 * 返回 null = 这个后端接不通（已打印原因），调用方继续用剩下的后端。
 */
async function createLangfuseProcessor(): Promise<any> {
  try {
    // @ts-ignore optional peer dependency, resolved at runtime
    const { LangfuseSpanProcessor } = await import('@langfuse/otel')
    return new LangfuseSpanProcessor({
      publicKey: process.env.LANGFUSE_PUBLIC_KEY,
      secretKey: process.env.LANGFUSE_SECRET_KEY,
      baseUrl: process.env.LANGFUSE_BASE_URL ?? 'https://cloud.langfuse.com',
      environment: process.env.LANGFUSE_TRACING_ENVIRONMENT ?? 'development',
      // 与 PHOENIX_BATCH 对齐：默认即时导出，CLI 单发跑完即退不丢 span。
      exportMode: process.env.LANGFUSE_BATCH === '1' ? 'batched' : 'immediate',
      flushAt: Number.parseInt(process.env.LANGFUSE_FLUSH_AT ?? '20', 10),
      flushInterval: Number.parseInt(process.env.LANGFUSE_FLUSH_INTERVAL ?? '10', 10),
      timeout: Number.parseInt(process.env.LANGFUSE_TIMEOUT ?? '5', 10),
      // ⚠️ 必须显式放行，否则 span 会被「静默」丢光（不报错、面板永远空着）。
      // 默认过滤器是 isLangfuseSpan || isGenAISpan || isKnownLLMInstrumentor：
      //   · isLangfuseSpan        → 要求 tracer 名 == langfuse 自己的，我们是 'astraea'  ✗
      //   · isGenAISpan           → 要求有 gen_ai.* 属性，我们用 OpenInference 的 llm.*  ✗
      //   · isKnownLLMInstrumentor→ 要求 scope ∈ 已知自动埋点库，我们是手工建 span      ✗
      // 三条全不满足，所以这里必须自己接管。
      shouldExportSpan: () => true,
      // 兜底脱敏：tracing.ts 在写属性时已经过一遍 sanitize（更早、且覆盖全部词汇），
      // 这里再兜一层，防止日后有人绕过 asAttrValue 直接 setAttribute 泄露。
      mask: ({ data }: { data: unknown }) => sanitizeGlobal(data),
      // 关掉媒体上传：astraea 进 span 的都是脱敏后的纯文本（文件内容早被抹成字数、
      // shell 输出截断），不可能有 base64 媒体，扫了也是白扫。
      // 另一个实际原因：媒体扫描按 `startsWith('langfuse.observation.metadata')` 前缀匹配，
      // 会把我们铺平的 metadata.<key> 一并扫到，遇到非字符串值（isError 是 boolean、
      // ttft_ms 是 number）就 WARN 一行 —— 每个 span 刷两条，REPL 里没法看。
      mediaUploadEnabled: false,
    })
  } catch (e) {
    console.error('[langfuse] 后端接入失败，已跳过：', (e as Error).message)
    return null
  }
}

/** 进程内调一次即可（幂等）。建议放在 query() 顶部。 */
export async function initPhoenix(): Promise<void> {
  if (initialized) return

  // 一个后端都没配 → 直接返回，且「不」置 initialized。
  // 这里不 latch 是有意的：latch 的话，任何在 env 就绪前调过 initPhoenix() 的路径
  // 都会把整个进程的可观测性永久锁死（后续再调全被幂等判断挡掉，且无声无息）。
  // 代价只是每次 query() 多读两个 env 变量，可以忽略。
  if (!isPhoenixEnabled() && !isLangfuseEnabled()) return

  // 真正尝试初始化了才 latch —— 失败也认，避免每个 turn 重试 + 重复刷错误。
  initialized = true

  try {
    // 可选依赖：未 `bun add @arizeai/phoenix-otel` 时此处在运行时被 catch 降级，
    // ts-ignore 让核心在「依赖未安装」状态下仍能 typecheck 通过（fail-open 的延伸）。
    // 注意：即使只开 Langfuse 也需要这个包 —— tracing.ts 的 OpenInference 语义约定
    // 常量由它 re-export，它同时是「OTel API 入口」而不只是「Phoenix 后端」。
    // @ts-ignore optional peer dependency, resolved at runtime
    const mod: any = await import('@arizeai/phoenix-otel')

    // 一个 provider + 多个 processor = 同一份 span 扇出到多个后端。
    // 传了 spanProcessors 后 register() 不再自建默认 processor，url/apiKey/batch 会被忽略，
    // 所以 Phoenix 那条得自己用 getDefaultSpanProcessor() 造。
    const spanProcessors: any[] = []
    const active: string[] = []

    if (isPhoenixEnabled()) {
      spanProcessors.push(
        mod.getDefaultSpanProcessor({
          url: process.env.PHOENIX_COLLECTOR_ENDPOINT ?? 'http://localhost:6006',
          apiKey: process.env.PHOENIX_API_KEY,
          batch: process.env.PHOENIX_BATCH === '1', // 默认 false = 即时导出
        }),
      )
      active.push('phoenix')
    }

    if (isLangfuseEnabled()) {
      const lf = await createLangfuseProcessor()
      if (lf) {
        spanProcessors.push(lf)
        active.push('langfuse')
      }
    }

    // 所有后端都接不通 → 别白建 provider，直接维持 no-op。
    if (spanProcessors.length === 0) return

    provider = mod.register({
      projectName: process.env.PHOENIX_PROJECT ?? 'astraea',
      spanProcessors,
    })
    otel = mod
    backends = active

    // 进程自然退出时兜底 flush（不劫持 SIGINT/SIGTERM，避免干扰 REPL 自己的 Ctrl+C 处理）
    process.once('beforeExit', () => {
      void provider?.forceFlush?.().catch(() => {})
    })
  } catch (e) {
    console.error('[observability] 初始化失败，已降级为 no-op：', (e as Error).message)
    otel = null
    provider = null
    backends = []
  }
}

/** 显式刷盘并关闭。用于会主动 process.exit() 的路径（如 headless），防止丢最后几个 span。 */
export async function shutdownPhoenix(): Promise<void> {
  try {
    await provider?.forceFlush?.()
    await provider?.shutdown?.()
  } catch {
    /* ignore */
  } finally {
    otel = null
    provider = null
    backends = []
    // 一并复位 initialized，让 shutdown 真正回到「未初始化」状态：
    // 否则 shutdown 之后再 initPhoenix() 会被幂等判断挡掉，永远起不来
    // （现实影响：headless 那种 shutdown 完就 exit 的路径无所谓，但测试里
    //   跑完一个后端组合就再也换不了，且「关掉还能重开」本就该成立）。
    initialized = false
  }
}
