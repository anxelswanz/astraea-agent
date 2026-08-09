// Langfuse 后端接线的回归测试。
//
// 为什么值得单独测：这条链路的失败模式全是「静默」的 —— span 发不出去不会抛错，
// 只是 Langfuse 面板永远空着，人要好几天后才发现。尤其是 shouldExportSpan：
// SDK 默认过滤器会把 astraea 手工建的 span 全部丢掉（详见 client.ts 里的注释），
// 哪天有人手滑删了那行，测试必须立刻红。
//
// 做法：起一个假的 Langfuse OTLP 收集器，跑真实的建 span 流程，
// 直接在 OTLP 请求体里断言（protobuf 里字符串是明文，includes 即可）。

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { initPhoenix, shutdownPhoenix, getActiveBackends } from './client'
import { createTrace, recordLLMObservation, recordToolObservation, endTrace } from './tracing'

/** 起一个假收集器，收集所有 OTLP 请求体。 */
function startFakeCollector() {
  const hits: { path: string; auth: string; body: string }[] = []
  const server = Bun.serve({
    port: 0, // 随机端口，避免 CI 撞车
    async fetch(req) {
      hits.push({
        path: new URL(req.url).pathname,
        auth: req.headers.get('authorization') ?? '',
        body: Buffer.from(await req.arrayBuffer()).toString('latin1'),
      })
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  return { server, hits, url: `http://localhost:${server.port}` }
}

const ENV_KEYS = [
  'LANGFUSE_PUBLIC_KEY',
  'LANGFUSE_SECRET_KEY',
  'LANGFUSE_BASE_URL',
  'PHOENIX_ENABLED',
  'PHOENIX_COLLECTOR_ENDPOINT',
  'PHOENIX_USER_ID',
] as const

function clearEnv() {
  for (const k of ENV_KEYS) delete process.env[k]
}

// client 是进程级单例，且 bun test 全量跑时同进程共享：
// 别的测试文件只要跑过 query() 就会 initPhoenix()，把 initialized latch 住
// （本机 ~/.astraea/settings.json 里的 PHOENIX_ENABLED=1 会被 config.ts 注进 env，
//   所以它们初始化的是 phoenix 后端）。不先复位的话，本文件的 initPhoenix() 会被
//   幂等判断直接挡掉 —— 单跑绿、全量红。shutdownPhoenix() 会一并复位 initialized。
beforeEach(async () => {
  await shutdownPhoenix()
  clearEnv()
})

afterEach(async () => {
  await shutdownPhoenix()
  clearEnv()
})

describe('Langfuse 后端', () => {
  test('span 真的发到 Langfuse，且带齐两边词汇 + 已脱敏', async () => {
    const lf = startFakeCollector()
    clearEnv()
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-lf-t'
    process.env.LANGFUSE_SECRET_KEY = 'sk-lf-t'
    process.env.LANGFUSE_BASE_URL = lf.url
    process.env.PHOENIX_USER_ID = 'tester'

    await initPhoenix()
    expect(getActiveBackends()).toEqual(['langfuse'])

    const t = createTrace({ sessionId: 'sess-1', input: 'hello' })
    expect(t?.traceId).toMatch(/^[0-9a-f]{32}$/) // traceId 出口：score 回挂全靠它

    recordLLMObservation(t, {
      input: [{ role: 'user', content: 'hello' }],
      output: [{ type: 'text', text: 'hi' }],
      usage: { input_tokens: 10, output_tokens: 3 },
      model: 'claude-opus-4-8',
      startTime: new Date(Date.now() - 500),
      completionStartTime: new Date(Date.now() - 300),
      endTime: new Date(),
    })
    recordToolObservation(t, {
      toolName: 'FileReadTool',
      toolUseId: 'toolu_1',
      input: { file_path: '/tmp/x.md', api_key: 'sk-leak-me' },
      output: 'z'.repeat(100),
    })
    endTrace(t, 'bye')

    await shutdownPhoenix() // 强制 flush
    lf.server.stop()

    const raw = lf.hits.map((h) => h.body).join('')
    expect(lf.hits.length).toBeGreaterThan(0)
    expect(lf.hits.every((h) => h.path === '/api/public/otel/v1/traces')).toBe(true)
    expect(lf.hits[0]!.auth).toBe('Basic ' + Buffer.from('pk-lf-t:sk-lf-t').toString('base64'))

    // Langfuse 只认这个来分类 observation；openinference.span.kind 它不读
    expect(raw).toContain('langfuse.observation.type')
    // 这几个是 Langfuse 原生就认的 OpenInference 属性，不需要额外翻译
    expect(raw).toContain('session.id')
    expect(raw).toContain('sess-1')
    expect(raw).toContain('user.id')
    expect(raw).toContain('llm.model_name')
    expect(raw).toContain('llm.token_count')
    // metadata 得按 key 铺平才能在面板里筛
    expect(raw).toContain('langfuse.trace.metadata.')
    expect(raw).toContain('langfuse.observation.metadata.')
    expect(raw).toContain('langfuse.observation.completion_start_time') // TTFT
    // Phoenix 的词汇必须原样还在，双写不能顾此失彼
    expect(raw).toContain('openinference.span.kind')

    // 脱敏红线：密钥和文件内容一个字都不许出去
    expect(raw).not.toContain('sk-leak-me')
    expect(raw).toContain('[REDACTED]')
    expect(raw).not.toContain('z'.repeat(100))
    expect(raw).toContain('file content redacted')
  })

  test('双开时同一份 span 扇出到两个后端', async () => {
    const lf = startFakeCollector()
    const px = startFakeCollector()
    clearEnv()
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-lf-d'
    process.env.LANGFUSE_SECRET_KEY = 'sk-lf-d'
    process.env.LANGFUSE_BASE_URL = lf.url
    process.env.PHOENIX_ENABLED = '1'
    process.env.PHOENIX_COLLECTOR_ENDPOINT = px.url

    await initPhoenix()
    expect(getActiveBackends()).toEqual(['phoenix', 'langfuse'])

    const t = createTrace({ sessionId: 'sess-dual', input: 'x' })
    recordToolObservation(t, {
      toolName: 'GrepTool',
      toolUseId: 'toolu_d',
      input: { pattern: 'marker-abc' },
      output: 'hit marker-abc',
    })
    endTrace(t)

    await shutdownPhoenix()
    lf.server.stop()
    px.server.stop()

    const lfRaw = lf.hits.map((h) => h.body).join('')
    const pxRaw = px.hits.map((h) => h.body).join('')

    // 同一份数据两边都到了，且各自的词汇都在
    expect(lfRaw).toContain('marker-abc')
    expect(pxRaw).toContain('marker-abc')
    expect(lfRaw).toContain('langfuse.observation.type')
    expect(pxRaw).toContain('openinference.span.kind')
  })

  test('两个后端都没配 → 全程 no-op，不建 provider 不发请求', async () => {
    clearEnv()
    await initPhoenix()
    expect(getActiveBackends()).toEqual([])
    // 没激活时 createTrace 返回 null，所有 record* 拿 null 也不许抛
    const t = createTrace({ sessionId: 'nope', input: 'x' })
    expect(t).toBeNull()
    expect(() =>
      recordToolObservation(t, { toolName: 'T', toolUseId: 'i', input: {}, output: 'o' }),
    ).not.toThrow()
    expect(() => endTrace(t)).not.toThrow()
  })
})
