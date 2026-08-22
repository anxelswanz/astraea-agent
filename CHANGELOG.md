# Changelog

本文件记录 Astraea 的版本变更，遵循 [Keep a Changelog](https://keepachangelog.com/) 与
[语义化版本 SemVer](https://semver.org/lang/zh-CN/)。

版本号的权威来源是 `package.json` 的 `version` 字段；UI 显示（`src/ui/App.tsx` 的 `VERSION`）
直接读取它，请勿在别处硬编码版本号。

> **1.0.0 发布门槛**（达成后才从 0.x 升到 1.0 并打首个 `git tag v1.0.0`）：

## [0.10.30] - 2026-08-22

### 修复（Linux：拖拽缩放终端窗口后，窗口内容消失且几乎无法恢复）

根因是一个转义符：`\x1b[3J`（擦除滚动回溯缓冲）。xterm / VTE(GNOME Terminal) / Konsole /
Alacritty / kitty 都实现它，**macOS Terminal.app 忽略它**——所以同一份代码在 mac 上看不出问题，
只在 linux 端炸。两条路径都在往终端里灌这个序列：

- **终端 resize（本次报告的路径）**：`useResizeRedraw` 的回调是 `wipeStatic`，它写的整屏清除
  序列带 `\x1b[3J`。拖拽一次窗口 = 屏内容 + 回溯缓冲一起删空，补救全靠紧接着那次「重挂载
  `<Static>` 全量重印历史」——而那是 O(整段会话) 的同步 TTY 写（pty 实测：800 轮的会话，单次
  resize 吐 **212 KB**）。拖拽期间会连着触发好几轮，终端被灌爆、进程卡在阻塞写上；只要这一步
  没能完整落屏，被 3J 删掉的东西就再也回不来，只能重开终端。
  修复：清屏序列拆成两档 —— `CLEAR_SCREEN`（`\x1b[2J\x1b[H`，只擦可视屏、回溯原样保留）与
  `CLEAR_SCROLLBACK`（含 3J）。resize / `/resume` / `/rewind` / `/language` 一律走前者，
  `\x1b[3J` 只留给 `/clear`——那是用户明确要求「擦干净」的场合。屏幕重画是可恢复的，删掉用户
  的滚动回溯不是。
- **启动动画（同一类缺陷的另一个触发点）**：`AstraeaIntro` 只检查终端**宽度**，不看高度。字标
  6 行 + 女神 25 行 + 输入框 3 行 = 34 行，任何不到 35 行的终端（默认 24、常见 30~40 都算）都
  会让 live frame 比窗口还高，于是 Ink 走 `renderInteractiveFrame` 的 fullscreen 分支：**每一帧**
  写一次 `ansiEscapes.clearTerminal`（含 3J）。pty 实测一次 30 行终端的普通启动就打出 **26 次**
  回溯擦除——用户跑 astraea 之前留在那个终端里的东西全没了。
  修复：尺寸检查同时看宽和高，放不下就降级（只播字标 / 直接跳过），绝不画一个比窗口还高的帧。

pty + winsize 回归实测（30 行终端，启动 + 一次 100→60 列的拖拽）：修复前整场打出 27 次
`\x1b[3J`，修复后 **0 次**，而拖拽后的最终屏幕与修复前逐行一致（历史照常按新宽度重印）；
`/clear` 仍照旧擦掉回溯。

## [0.10.29] - 2026-08-17

### 修复（「跑二三十秒就自己停了」—— 空转时无人挽救，且 guard 挂掉会静默放行）

用户实测症状（Linux 新接入环境）：任务做到后半程，Astraea 连续输出「我立即创建剩余页面并
接线、注册、编译，中途不询问」这类叙述，却一个工具都不发，重复四五次后就停下交还控制权。

- **承诺桥接只救一次（`src/query.ts`）**：`commitmentNudged` 是个一次性 boolean。模型一旦
  卡进「复述计划 → 不动手」的循环，第二轮起 guard 连评估都不再做（`!commitmentNudged` 把
  整个 `assessCompletion` 调用都圈在里面），纯文本被直接当成最终回复 `yield done`。改为
  计数器 `COMMITMENT_MAX_NUDGES = 3`，并**逐级加压**：第一次仍是温和提醒，第二次起换成硬
  约束——「下一条消息的第一个东西必须是工具调用，不许前言、不许复述记忆和日期、不许再列
  剩余项」。
- **guard 不可用时 fail-open 静默放行（`src/services/completion-guard.ts`）**：guard 走的是
  各 provider 硬编码的小模型（haiku / gpt-4o-mini / …），在自建网关、本地 ollama、模型名不
  存在的环境里整条链路很容易挂掉；旧实现 catch 到异常和解析失败时一律返回 `complete`，于是
  模型吐一句「我立即开始」就被放行。新增**不依赖 LLM 的本地启发式兜底** `looksLikeActionPromise()`：
  中英文行动承诺模式（含「立即**连续**创建」这类夹副词的写法），排除条件句（「如果你确认」）
  与问句收尾。guard 挂掉时不再无条件放行，而是降级到启发式判定，reason 里标明是降级路径。
- **用尽加压后不再静默停止**：新增 `commitment_exhausted` 事件，REPL 显式打出
  「⚠ Stopped after N turns of restating the plan without calling a tool. Last check: …」。
  用户此前看到的「莫名其妙停了」，现在会说清楚它空转了几轮、guard 的最后判词是什么——
  guard 链路故障也会在这条消息里露出来。

### 测试
- 新增 `src/services/completion-guard.test.ts`（10 例）：中英文承诺模式命中、条件句/问句/
  普通说明不误判、guard 输出垃圾时降级到启发式而非 fail-open、有效判词不被启发式覆盖、
  单参数旧调用签名兼容、加压措辞随 attempt 升级。
- `src/query.completion-guard.test.ts` 更新为新契约：一次承诺被续跑后放行；持续空转则加压
  3 次并发出 `commitment_exhausted`，最后仍以 `done` 收尾。

### 已知未处理
日志里模型每轮都在复述「今天是 …／记忆已完整核对／系统提醒我 N 个 todo，但我审视相关性后
发现…」——注入的 reminder（记忆召回、todo 提醒、v0.10.28 的陈旧任务守卫）在长对话里叠加得
过厚，模型花大量输出跟 reminder 角力而非干活。这次没动 reminder 的注入密度与措辞，属于独立
的一批调优。

## [0.10.28] - 2026-08-09

### 修复（续跑指令不再沉淀成历史 —— 「做到一半停下，回头重做最早那个任务」）

用户实测症状：连做几个任务后再提新需求，Astraea 执行到一半停住，转头反复重做最初那个任务。
三个缺陷叠成一个自我强化的闭环，缺一环都不会复现：

- **`stripReminders()` 漏掉数组形式的注入消息（主因，`src/query.ts`）**：它只过滤
  `typeof content === 'string'` 的用户消息，而五个注入点（截断续写、/goal 续跑、Todo 收尾
  stop-hook、TaskGraph 重规划、承诺桥接）用的**全是数组 content**，于是一条都没被剥掉，
  随 `done` 事件沉淀进 `conversationRef`。历史里越堆越多「你还有未完成任务 X」的**伪用户
  消息**，模型看到的就是用户在反复要求做那个旧任务。现改为 `isEngineDirective()` 判定：
  `UserMessage.ephemeral` 标记为主、文本前缀（`<system-reminder>` / `[/goal]` / `[system]`）
  兜底升级前的历史与 transcript 回放。只认「全部 text block 都是指令」的消息——混入
  `tool_result` 的、`<user_interjection>` 用户插话的、空 content 的一律保留，绝不误删真实输入。
- **`latestUserText()` 把注入指令当成用户输入（`src/query.ts`）**：它从后往前找
  `role: 'user'`，而 directive 恰好就是 `role: 'user'` 带 text。结果 `completionAssessor`
  拿**旧任务**去比对本轮工作，判成 `unfulfilled_commitment`，再注入一条指令把模型拽回旧
  任务——闭环的第二环。记忆召回 query 与 Phoenix trace 的 input 同样被污染。现跳过指令消息。
- **TodoWrite 证据门禁没有出口（`src/tools/TodoWriteTool/index.ts`）**：模型收尾想关掉旧
  任务，却想不起 `toolu_` id（压缩之后尤其如此），报错只说「completed tasks require
  evidenceRefs」不给任何线索，于是这条 todo 永远卡在 `in_progress`，stop-hook 每轮把它拽
  回来重做——闭环的第三环。**门禁强度一行未改**，但报错现在附上可引用的 tool_use id 清单
  （最近 20 条，带工具名）与三条合法退路：保持 pending / 从列表移除 / `todos: []` 清空。

### 变更
- **所有 stop-hook 文案加「陈旧任务守卫」**（`src/query.ts` 的 `STALE_TASK_GUARD`、
  `src/services/task-graph.ts` 的 `buildReplanDirective`）：stop-hook 只知道清单里还有没做完
  的条目，不知道用户早就换了话题。现明确要求——用户已转向就**不要**重启这些条目，先完成
  用户当前的请求，未尽事项在末尾提一行或直接从清单移除。
- **`UserMessage` 新增 `ephemeral?: true`**（`src/types/message.ts`）：标记引擎注入的一次性
  指令，仅对注入的那一轮有效。`toAPIMessage` 只取 `role`/`content`，该字段不会外泄到 API。
- **TodoWrite description 补充退出路径**：显式说明 evidenceRefs 是 tool_use id，以及绝不能
  把没做完的任务硬标 completed——要退役陈旧任务就从列表里移除或整体清空。

### 测试
- 新增 `src/query.directive-hygiene.test.ts`（5 例）：数组 content 指令被剥离、无标记的历史
  指令按前缀兜底、真实输入/插话/tool_result/混合消息绝不误删、`latestUserText` 越过指令取到
  真实请求。
- `TodoWriteTool.test.ts` +4 例：报错列出可引用 id 与退路、无证据时明说、清空列表始终放行。
- `taskGraph.test.ts` +1 例：重规划指令必须带陈旧任务守卫。

### 已知未处理
`getTodos` / `getTaskRecords` 是跨用户消息存活的内存单例，话题切换时旧节点不会自动作废。
本版用文案守卫压住危害，未改状态生命周期——「新用户请求到来时是否自动把上一轮残留任务标为
陈旧」是产品决策，留待后续。

## [0.10.27] - 2026-07-15

### 新增（Langfuse 后端 —— 可观测性桥接从「单后端」变「多后端扇出」）
- **`src/observability/phoenix/client.ts` 支持 Langfuse**：配 `LANGFUSE_PUBLIC_KEY` +
  `LANGFUSE_SECRET_KEY` 即启用,与 `PHOENIX_ENABLED=1` 可单开可双开。实现方式是把两个后端
  做成挂在同一个 provider 上的两个 SpanProcessor（`register({ spanProcessors: [...] })`）,
  同一份 span 扇出到两边,tracing.ts 的建 span 逻辑一行没动。
  可选配置:`LANGFUSE_BASE_URL`(默认 cloud.langfuse.com)、`LANGFUSE_TRACING_ENVIRONMENT`、
  `LANGFUSE_BATCH`(默认即时导出,与 PHOENIX_BATCH 对齐)、`LANGFUSE_FLUSH_AT/FLUSH_INTERVAL/TIMEOUT`。
- **属性双写（`tracing.ts`）**：Langfuse 与 OpenInference 的核心属性名天然重合——
  `session.id`/`user.id`/`input.value`/`output.value`/`llm.model_name`/`llm.token_count.*`
  两边都认,无需翻译。只补两处:①`langfuse.observation.type`(Langfuse 不读
  `openinference.span.kind`,AGENT/LLM/TOOL → agent/generation/tool);②metadata 按 key 铺平成
  `langfuse.{trace,observation}.metadata.<k>`(塞 JSON 串只会落进不可筛选的 metadata.attributes)。
  另补 `langfuse.observation.completion_start_time` 供 Langfuse 算 TTFT。补写对 Phoenix 无害。
- **`PhoenixTrace.traceId` + `trace_start` 事件**：query() 在根 trace 建好后 yield
  `{ type:'trace_start', traceId, sessionId }`。这是给 trace 回挂 Langfuse score
  (`score.create({ traceId, … })`)、关联外部 eval 的唯一入口,此前 traceId 没有出口。
  未启用可观测性时该事件不发,消费方无需改动。
- **`src/observability/phoenix/langfuse.test.ts`**：起假 OTLP 收集器做端到端回归——
  断言请求真的发出、Basic auth、两边词汇齐全、脱敏红线(密钥/文件内容不外泄)、双写扇出、
  未配置时全程 no-op。

### 修复
- **`shouldExportSpan` 静默丢 span（接入 Langfuse 时必踩）**：LangfuseSpanProcessor 的默认
  过滤器是 `isLangfuseSpan || isGenAISpan || isKnownLLMInstrumentor`,astraea 手工建的 span
  三条全不满足(tracer 名是 'astraea'、用 OpenInference 的 `llm.*` 而非 `gen_ai.*`、非自动
  埋点),会被**静默**丢光——不报错,面板永远空着。现显式 `shouldExportSpan: () => true`,
  并有变异测试守着(删掉该行 → 测试立刻红)。
- **`initPhoenix()` 的 latch 会永久锁死可观测性**：此前「一个后端都没配」时也会置
  `initialized = true`,导致任何在 env 就绪前调过 initPhoenix() 的路径都会让整个进程的
  可观测性再也起不来(且无声无息)。现只有真正尝试初始化了才 latch。
- **`shutdownPhoenix()` 未复位 `initialized`**：关掉之后再也开不起来。现一并复位,
  让 shutdown 真正回到「未初始化」状态。
- **关闭 Langfuse 媒体上传**（`mediaUploadEnabled: false`）：astraea 进 span 的都是脱敏后的
  纯文本,不可能有 base64 媒体;且媒体扫描按前缀匹配会扫到我们铺平的 metadata.<key>,遇到
  非字符串值(isError 是 boolean、ttft_ms 是 number)就每个 span 刷两条 WARN。

## [0.10.26] - 2026-07-14

### 新增（Retry / 熔断 / Fallback + fail-closed 收口 —— 可靠性审计 PR-4,审计四批次完结）
- **`src/utils/retry.ts`**：指数退避重试原语（默认 2 次,500ms 起倍增）。瞬态错误分类:
  HTTP 4xx 不重试（鉴权/参数/配额,重试只会更糟）,5xx / 超时 / DNS / 连接层错误重试;
  用户 ESC 取消立即停止,绝不把取消变成「再试两次」。
- **WebFetch / WebSearch 接入重试**：每次尝试独立计超时（WebFetch 30s、WebSearch 15s）,
  5xx 抛出进重试,4xx 原样快速失败;WebFetch 的 ctx.abortSignal 顺带贯通（PR-3 漏网点）。
- **MCP 熔断器（T2 补完）**：按 server 计的进程内熔断——连续 3 次传输层失败（不含工具自身
  isError 语义错误）→ 熔断,60s 冷却期内快速失败并提示检查 /mcp,不再让每次调用干等 60s
  超时;期满放行一次探测（half-open）,成功即复位。带 readOnlyHint 的 MCP 工具幂等,
  瞬态失败自动重试一次;写工具可能有副作用,绝不自动重试。

### 修复
- **AskUserQuestion fail-open（T10）**：无人值守时此前返回「no user available… use your
  best judgment」,headless/子代理里模型会替用户拍板方向性决策。现与 fileWriteGate/BashTool
  的 §3.0 fail-closed 约定对齐:非交互一律 isError 并指示「走保守路径或停下报告待决事项」;
  交互会话中问题被清空/退订同样不默认任何选项。desc 同步声明该行为。
- **WebBrowser 降级指引**：navigate 超时/崩溃的错误消息现在明确建议「静态页改用 WebFetch」
  （保持指引式降级,不做静默自动切换——避免模型误以为拿到了 JS 渲染结果）。

## [0.10.25] - 2026-07-14

### 修复（超时补齐 + AbortSignal 贯通 —— 可靠性审计 PR-3,消灭「永久挂起」路径）
- **SendMessage 永久挂起（T1）**：UDS/TCP 发送以对端 close 为唯一 resolve 点,对端不关闭
  连接即卡死整个 turn。现 10s 墙钟超时 + ctx.abortSignal,超时/ESC 主动断连并报错。
- **MCP 挂起（T2）**：`callTool` 显式 60s 超时 + AbortSignal(ESC 可中止在途请求);
  `connect` 握手 10s 超时,server 起不来不再拖死启动期 initMcp。
- **WebSearch 无超时（T3）**：adapter 的 fetch 本就接受 signal 但从没人传;现统一
  15s 墙钟 + ESC 取消,断网/黑洞不再挂到 OS 层超时。
- **WechatWrite 挂起 + 不可逆（T4）**：python 键盘模拟卡住时此前无限 await;现 30s 超时
  SIGKILL + ctx.abortSignal,超时消息明确提示「可能未发出,重试前先检查」;标记
  `isDestructive`。WechatRead 的 OCR 子进程同样补 5 分钟墙钟。
- **Bash ESC 取消失效（T5）**：executor 早已支持 AbortSignal(`AbortSignal.any` 组合超时),
  但三个调用点从不传——ESC 后命令继续跑满 600s。现 ctx.abortSignal 全线贯通(前台/只读/流式)。
- **子 Agent 失控（T7）**：runSubAgent 新增 10 分钟墙钟 + 200k 输出 token 预算双闸,
  且 abortSignal 首次传入 streamMessage——provider 流 stalled(无事件)也能从请求层掐断;
  撞闸记 failed 并回报明确原因与部分结果。
- **PowerShell 三连**：
  - **Windows 子代理全瘫（T8）**：`isReadOnly` 恒 false → fail-closed 下连 Get-ChildItem
    都被拒。新增保守只读命令识别（白名单动词 + 拒绝一切复合结构/scriptblock/重定向）,
    只读命令免确认直接执行,对齐 Bash 流程。
  - **超时伪装成功**：超时 kill 后成功路径返回 `timedOut:false` + `exitCode ?? 0`,模型会把
    超时命令当成功。现从信号推导 timedOut/interrupted,exitCode 为 null 时归一为 -1
    （对齐 Bash executor 同款修复）。
  - executor 接受 AbortSignal(ESC 可取消)+ findPwsh 探测 5s 超时。
- **WebBrowser**：动作超时后关闭当前 page,让在途 Playwright 操作立即 reject（此前竞速超时
  只是工具先返回,底层操作仍在后台继续跑）;`chromium.launch` 加 30s 超时;browser 断连后
  ensurePage 自动重启。
- **Spreadsheet**：unzip/zip 子进程加 30s 墙钟,损坏的 xlsx 不再挂死。

### 新增
- `src/utils/withTimeout.ts`：`withTimeout`（墙钟包装 + 超时清理回调）与 `combineSignals`
  （调用方信号 × 超时信号合并）两个统一原语,上述各点全部复用,不再各写各的定时器。

## [0.10.24] - 2026-07-14

### 改进（工具 description/schema 精确化 —— 可靠性审计 PR-2,防「选错工具/传错参数」）
- **VigilOnce 单位冲突修复（审计 T6）**：description 原文写 "delay (in minutes)" 而参数
  `delaySeconds` 按秒执行——模型按分钟传 30 会提前 60 倍触发。现 desc 与参数说明统一为秒,
  并给出换算示例（5 minutes = 300）。
- **Write ↔ Edit 双向互指**：Write 补充「小改动优先用 Edit,Write 仅用于新文件或整体重写」,
  此前只有 Edit 单向指回 Write。
- **Bash ↔ PowerShell 平台归属**：两者 desc 各自声明平台（macOS/Linux → Bash,Windows →
  PowerShell）;PowerShell 补充与 Bash 的行为差异（无后台任务、无输出截断）。
- **Agent ↔ TaskCreate 反向边界**：Agent desc 补充「要的只是可追踪工作记录 → 用 TaskCreate」,
  此前区分只写在 TaskCreate 一侧。
- **TodoWrite ↔ TaskCreate 分工声明**：两套并行任务系统首次互相提及——TodoWrite=会话内轻量
  清单,TaskCreate/TaskUpdate=带依赖、证据门槛与生命周期钩子的任务记录。
- **TaskUpdate 转移表与实现对齐**：补上实现里本就允许但 desc 漏写的
  `blocked → in_progress` 与 `failed → in_progress (retry)`;evidence.items 五个字段
  逐一补 description。
- **WebFetch 限值入 desc**：30s 超时 / 50k 字符截断 / 最多 5 跳重定向此前只是代码常量。
- **WebBrowser 确认行为入 desc**：声明 click/type 是需用户确认的写操作（无人值守直接失败）,
  navigate/screenshot/scroll 免确认。
- **Bash schema**：command 参数注明「仅查询后台任务时可省略」;timeout 注明须为正整数。

### 修复
- **VigilList**：一次性任务（无 cron 字段）不再打印 `Cron: undefined`,改为显示
  `Type: one-time / recurring`。
- **SendMessage desc**：注明 `bridge:` 目标保留未实现,避免模型误用。

## [0.10.23] - 2026-07-10

### 新增（工具入口统一参数校验 —— 可靠性审计 PR-1）
- **`src/tools/validateInput.ts`**：基于工具自带 JSON Schema 的零依赖运行时校验器,覆盖
  required 缺失 / type 不符（含 union type、integer、NaN 拒绝）/ enum 非法 / 数组 items
  元素类型与嵌套对象 required。错误消息固定格式指出「哪个参数、期望什么」并附 schema 片段,
  模型可直接自我修正,不再收到 `Tool execution error: TypeError: Cannot read properties
  of undefined` 这类不可行动的原始异常。
- **query.ts 两条执行路径接线**：普通与流式工具在 orbit/counsel 拦截之后、`call()` 之前
  统一过闸,校验失败返回结构化 isError,不进入工具执行层。此前 10 个工具（Agent/Edit/
  Write/LSP/SendMessage/ReviewArtifact/TaskCreate/VigilOnce/VigilSchedule/
  VerifyOrbitExecution）缺必填参数会穿透抛原始 TypeError,现全部在入口拦截。
- **容错设计**：MCP server 自报的非标 schema 解析不了一律放行、未知字段不拒绝,绝不因
  校验器自身局限误杀合法调用。

### 修复
- **TodoWrite**：todos 数组含 `null` / 非对象元素时,此前在 `.status` 访问处直接抛
  TypeError;现返回带下标定位的结构化错误（入口校验之外的第二道防线）。
- **TaskOutput**：`offset` 缺失/负数/NaN 时输出里出现 `nextOffset: NaN`;现防御性归一为
  0 起读,`limit` 同样归一（默认 100）。

## [0.10.22] - 2026-07-04

### 修复（GrepTool 阻塞事件循环）
- **`spawnSync` 改为异步 `Bun.spawn`**：此前 Grep 用同步子进程调用 ripgrep，大仓库慢搜索
  期间会把整个事件循环焊住——按键无响应、界面不刷新、ESC 无效，与 v0.10.19 修的"闪退/卡死"
  同一类根因（耗时操作同步阻塞主线程），只是换了个触发点。现在改用 `Bun.spawn` + 复用
  `readStreamBounded`（与 BashTool 同款、带 10MB/1MB 输出上限），搜索期间 REPL 保持响应。
- **新增 `AbortSignal` 支持**：搜索期间用户按 ESC 或轮次中止时，直接 kill 掉还在跑的
  ripgrep 进程，不再干等它自己跑完。
- **副带修复：非零退出码（如正则语法错误）不再被误判为"无匹配"**：旧代码只检查
  `spawnSync` 的 `result.error`（仅覆盖“可执行文件找不到”），ripgrep 因无效正则等原因
  以退出码 2 结束时，`result.error` 为空、stdout 为空，会被误报成"No matches found"，
  真实的正则解析错误被静默吞掉。现在按 ripgrep 的退出码语义分类（0=有匹配，1=无匹配，
  其余=真错误），错误会带着 ripgrep 的原始 stderr 正确回传。

## [0.10.21] - 2026-07-04

### 改进（GrepTool）
- **content 模式新增 `context_lines` 参数**：映射 ripgrep 的 `-C`，对称展示匹配行前后各 N 行
  上下文。此前 Grep 只回传孤立的匹配行，模型想看懂上下文往往要再发一轮 Read 把整个文件读一遍——
  多耗一次工具调用往返。现在一次 Grep 调用就能带够上下文,省掉这趟往返。
- `renderResult` 的匹配计数同步修正：`--context` 会在结果里混入非匹配的上下文行
  （`path-lineno-text`）和分组分隔符（`--`），只统计真正的匹配行（`path:lineno:text`），
  避免"Found N matches"被上下文行灌水。

## [0.10.20] - 2026-07-04

### 改进（闪退恢复 / transcript）
- **中途闪退不再丢当前这一轮的 prompt**：transcript 原先只在每轮 `done` 事件落盘，
  终端在模型流式生成途中崩溃时，本轮用户 prompt 连同半截回复一起丢失。现在
  `runConversation` 在 turn 起跑即把用户消息追加进 transcript（不等 `done`），
  `/resume` 重放时能恢复到「闪退前问的那句话」。已完成轮次本就逐轮落盘、不受影响。
- **早写与 done 增量不重复、异常路径对账**：`done` 的 delta 写盘会自然跳过已早写的
  user 行（`turnCommitted` 标记）；若本轮异常/中断没走到 `done`，`finally` 把 `loggedLen`
  回退到轮前值，恢复「loggedLen==conversationRef.length」不变量，保证后续轮次早写仍生效。
  磁盘上那条 user 行留作孤儿（append-only 无法撤销），正是 `/resume` 要还原的兜底。
  利用 transcript append-only + compact 快照整体替换的重放语义，早写与 compact/rewind
  交错均不冲突。
- 注：流式途中半截的**助手回复**仍不落盘（只保完整轮）；保住半截回复需流式增量落盘，改动更大，暂未纳入。

## [0.10.19] - 2026-07-03

### 修复（终端闪退 / 卡死专项）
- **后台 Promise 拒绝不再整进程闪退**：进程级护栏此前把 `unhandledRejection` 与
  `uncaughtException` 同等对待——任何 fire-and-forget 的后台失败（MCP 连接、标题摘要、
  剪贴板读取…）都会复位终端并 `exit 1`，表现为「任务跑着跑着整个终端闪退」。现在
  `unhandledRejection` 只上报（stderr + `~/.astraea/crash.log` 持久化），REPL 保持存活；
  `uncaughtException` 仍复位终端后退出。新增 `runDetached()` 统一给 fire-and-forget
  任务装本地拒绝边界，UI 层挂接 `reportDetachedUiError` 落红色状态行。
- **权限确认 / AskUserQuestion 桥改为 FIFO 队列**：两个 bridge 原是单槽位，主 agent 与
  后台 sub-agent（或并发工具批）同时发起确认/提问时，后到的会覆盖先到的，先到的 Promise
  永远悬挂 → 工具调用连同任务整体卡死。现在请求排队逐个展示，resolve 队头后自动推送
  下一个；最后一个 UI 订阅者退订时 fail-closed 排空队列。新增 `cancelAllConfirms()` /
  `cancelAllQuestions()`，`/stop` 与 `/clear` 会排空挂起请求，不再留下永远悬挂的工具。
- **UDS server 信号处理**：此前 SIGINT/SIGTERM 直接 `process.exit(0)` 绕过 Ink 清理
  （终端 raw mode / 光标状态残留）。现在：清理 socket → 复位终端 → 按约定码（130/143）退出。
- **后台任务输出无界内存**：`spawnBackground` 用 `Response(stream).text()` 收集输出，
  64MB 截断发生在完整读取之后——长跑后台命令（`yes`、冗长构建日志）会把 REPL 进程
  OOM 打崩。改用 `readStreamBounded` 边读边截断，且以 `proc.exited` 为读取边界（脱离的
  常驻孙进程占住管道时不再永久挂死）。
- **Bash 超时/中断伪装成功**：超时与 ESC 中断走 `proc.kill()`，`exited` 正常 resolve 不进
  catch——`timedOut`/`interrupted` 永远是 false，且被信号杀死时 `exitCode` 为 null 被
  `?? 0` 报告成 exit 0，模型把超时命令当成功继续推进。现在标志在退出后从信号推导，
  被杀进程按非 0 退出码上报，stderr 附超时说明（前台 + 流式 + 后台三条路径一致）。
- **runConversation abort 分支兜底复位 `isStreaming`**：abort 来自 ESC//stop 之外的路径时
  UI 会卡在 streaming 态（状态行常驻、输入框禁用）。
- **权限确认面板期间暂停 live frame 重绘**（`shouldRenderAgentActivity`）：确认选择器是
  模态交互，流式帧的计时器重绘会让 Ink 反复擦除/回流选择器。

### 修复（其他）
- **`bun run typecheck` 修复回绿**：v0.10.17 的 `FileReadTool/image.ts` 带入 24 个
  strict-null 错误；越界字节参与位运算会得 NaN、尺寸静默算错。统一经 `byteAt()`（越界按
  0）读取，`readU32BE/LE` 修正为无符号语义，JPEG marker 越界时终止扫描，移除重复的
  WebP `'VP8 '` 判等与恒假的 `!== 0xC4` 死条件。
- **welcome 版本条目**：`RECENT_UPDATES` 停在 0.10.12 导致「当前版本必须有专属欢迎条目」
  测试常红；补 0.10.19 条目（六语言），测试改为语义断言（存在 + 排首位）而非硬编码文案。

## [0.10.18] - 2026-07-03

### 修复
- **Windows 流式内容重复渲染**：Windows 终端下 Ink 默认的整帧擦除重绘可能无法稳定清除上一帧，
  导致思考文本随 token 增量呈阶梯式重复。现在仅在 Windows 启用 Ink 逐行增量渲染，直接覆盖变化行；
  macOS 与 Linux 保持原有渲染策略。

## [0.10.17] - 2026-07-02

### 新增
- **FileReadTool 图片元信息读取**：此前 Read tool 遇到 >256KB 的图片文件直接报 "File too large"，
  用户无法确认文件基本信息。现在遇到常见图片格式（PNG/JPEG/GIF/WebP/BMP/TIFF/ICO/AVIF）时，
  通过文件头魔数检测格式、解析尺寸，返回 `Format / Size / File` 元信息（不依赖第三方库，
  不读完整文件入内存）。

## [0.10.15] - 2026-06-30

### 优化
- **Evidence critique 直接消费证据真值（改动①）**：收尾的 `critiqueGoalEvidence` 此前只读截断到 16k
  的对话 transcript，长任务中早期的关键证据（如 `npm test → exit 0`）会滚出窗口，导致 critique 盲判、
  把已完成的工作误判为「证据不足」逼着重做。现在让它直接消费 `evidence-registry` 里**永不裁剪**的工具真值：
  - `evidence-registry` 新增 `getToolEvidence(namespace)` 回读接口。
  - `goal-evaluator` 新增 `serializeEvidenceLedger`：把 registry 真值序列化成一份「证据账本」——
    按时间序、单条只保留结论所在的尾部、整体设字符上限以控延迟，优先保留近期记录。
  - `critiqueGoalEvidence` 接收账本并优先于 transcript 判断；`CRITIQUE_SYSTEM` 边界改为「以账本为
    ground truth」。`query.ts` 在 `/goal` 停止钩子里把 `getToolEvidence(todoNamespace)` 喂给它。

### 新增
- **TaskGraph re-plan 停止钩子（改动②）**：`reconcileTaskGraph` 只会把坏掉的计划点亮成 `failed` /
  `invalidated`，却不主动把模型拽回来修——此前指望模型下一轮自己想起，失败任务容易被静默遗忘。新增
  `buildReplanDirective`，在真正停止点（模型给最终回复、无 tool call）检查任务图，若仍有坏节点则注入一次
  指令并再跑一轮：
  - `failed` → 复盘：重试 / 换方法 / 拆成更小的子任务；
  - `invalidated` → 重验证：点名是哪个上游依赖变了导致证据失效，要求重跑验证并经 `TaskUpdate` 重交证据。
  - 与 Todo 收尾钩子同构：仅主对话生效、仅提醒一次（`taskGraphNudged`）、受 `turnCap` 兜底，绝不死循环。

## [0.10.14] - 2026-06-25

### 新增
- **斜杠命令句中识别 + Tab 补全**：此前 slash 候选只在输入「以 `/` 开头且无空格」时才弹出，前面有文字
  （如「我爱 /fron」）就不认。新增 `trailingSlashToken`：识别输入**末尾正在输入**的 `/token`（行首或空白后
  紧跟 `/`、到行尾不含第二个 `/`），句中也能弹出候选；Tab 只替换该 token、保留前缀文字
  （「我爱 /fron」→「我爱 /frontend-design」）。覆盖所有内置命令与已装 skill。
  - 消歧：词中斜杠（`src/foo`）、含第二个斜杠的路径（`/tmp/foo`）、带参命令（`/goal foo`）都不误弹。
  - 执行语义不变：句中 `/命令` 仍作为消息文本（Tab 补全、Enter 发送），只有「整行以 `/` 开头」才执行。

### 修复
- **快工具扫光被截断 → 最短驻留**：Read/Grep/Write 等瞬时工具结束后，模型常立刻接着输出文字，
  `commitLiveTools` 立即把它落盘冻结，扫光还没播完就被截断（表现为「这些工具好像没特效」）。
  在 `text` 事件落盘前补足 `SWEEP_DWELL_MS = 320ms` 的停留（仅有色 TTY；工具早已结束则不等），
  让每个工具都看得到完整扫光再落盘。中断 / `/stop` / 报错路径不等待，保持即时响应。

## [0.10.13] - 2026-06-25

### 优化
- **`/model` 输出改为 Markdown 表格**：从三行纯文本（Provider / Model / Context window）
  改为 Key-Value 表格格式，若有 endpoint 配置则额外显示一行，与 `/usage` 风格的表格统一。

## [0.10.12] - 2026-06-25

### 修复
- **REPL 文字流式卡顿**：`COPY_FRIENDLY_PREVIEW_INTERVAL_MS` 由 1200ms 降到 80ms。此前 live 文本
  预览每 1.2s 才刷新一次——首个 token 立即显示、之后整段被缓冲约一秒才一次性蹦出（「好，」…等…后文），
  读起来像卡住。80ms（≈12fps）让流式重新像「正常打字」，仍合并快速 token 突发；完整文本的鼠标选择在
  落盘到 `<Static>` 后照常可用。

### 优化
- **扫光大幅提速且必定扫完**：亮柱位置改为**时间驱动**——`hlStart = floor(elapsed/SWEEP_PASS_MS*band) % band`，
  每 `SWEEP_PASS_MS = 300ms` 扫满整条带一趟（与带宽无关，不再因带宽大而变慢）。此前按列步进、一趟需 ~2.9s，
  工具早早结束、扫光没走几步就被冻结；现在 720ms 收尾期内能完整扫 ~2.4 趟，每个工具都看得到完整扫光。
  共享节拍 `TICK_MS` 33ms（≈30fps）只负责催重绘、不再决定速度。

## [0.10.11] - 2026-06-25

### 优化
- **扫光每次从头起步**：此前所有 running 行共用全局相位，中途开始的工具亮柱已在带中间。改为
  每个工具块在 `useSweepLifecycle` 里记录开始时的全局相位作基线，`本地相位 = 全局-基线` → 起始帧
  亮柱位于最左、从头扫起（同块内多行仍同相、竖柱按列对齐；跨工具各自独立）。
- **扫光速度翻倍**：`sweepClock` 节拍 `TICK_MS` 由 120ms 降到 60ms，亮柱移动明显更快、更有「扫描」感。

## [0.10.10] - 2026-06-25

### 修复
- **扫光收尾保活，瞬时工具也连贯**：此前 Read/Edit/Grep 等 <120ms 的瞬时工具，扫光只渲染第 1 帧、
  亮柱还没移动就被冻结，看着「没动画、不连贯」（只有偶尔跑得久的 Glob 才肉眼可见）。新增
  `useSweepLifecycle` + `SWEEP_GRACE_MS = 720`：工具结束后扫光至少再播 ~720ms（亮柱明显扫一段）
  才落盘定格——运行→收尾→冻结无缝衔接，**每个工具都有一段连贯可见的收尾动画**。
  - 用「是否曾经历过 running」(startRef) 自动区分 live 在途行与 `<Static>` 历史行：历史行直接以
    done 挂载、从没经历 running → 永不动画、零背景，行为不变。
  - 共享时钟仅在动画期间订阅，收尾期满 + setTimeout 兜底一次重渲染翻到冻结态，最后一条停扫即停钟。

## [0.10.9] - 2026-06-25

### 新增
- **工具调用扫光背景（Sweep）**：每次工具调用**运行时**，`⏺` 头行连同下方实时输出尾巴整块铺一条
  品牌靛蓝底带（`#6A5ACD`），一根星辉银（`#C8D8FF`）「亮柱」按列横扫——多行同相位、形成一根竖亮柱
  整体右移的「扫描仪」观感。并行多条 running 行同时扫、折叠组（`Read/Grep/Glob/Bash ×N`）组内有调用
  在跑时头块也扫。
  - **纯运行态语言**：工具落盘进 `<Static>` 后扫光完全消失，历史回归现状（零背景，成败仍只靠 `⏺`
    marker 状态色区分）。落盘渲染路径零改动。
  - **带宽**：`clamp(块内最长行宽, 下限 48, 上限 = 终端宽-4)`，文字永不截断、封顶防软折行残影；
    所有 `running` 行共用**一个** 120ms 全局时钟（`src/ui/sweepClock.ts`），同相对齐、空闲自动停钟。
  - **自动降级**：仅在有色终端（`chalk.level > 0`）启用；CI / 管道 / 哑终端自动回退到现状渲染，无手动开关。

### 修复
- **补回 0.10.8 遗漏的版本欢迎通知**：`RECENT_UPDATES` 新增当前版本（0.10.9）专属条目（扫光特性），
  顶置为最近更新首项，修复 `recentUpdates` 校验「当前版本应有专属欢迎通知」自 0.10.8 起的失败。

## [0.10.7] - 2026-06-25

### 优化
- **欢迎面板「最近更新」主打 `/selection` 与 `/init`**：把这两条更新通知重新指向当前版本，
  作为两个独立 bullet 排在最近更新最前面（位于常驻通知之上）。

### 文档
- **README 补全 `/selection` 与 `/init` 命令介绍**：在 §3 In-REPL Configuration 的 slash-command
  表中新增 `/selection`（浮动选区 UI 的 start/open/stop/status/setup 子命令）和
  `/init [focus]`（项目初始化指令生成）两条条目。

## [0.10.6] - 2026-06-25

### 优化
- **输入框圆角**：四角由直角 `┌┐└┘` 改为圆角 `╭╮╰╯`，观感更柔和。
- **打字呼吸辉光**：用户打字时（仅非流式态）边框整体瞬间亮成品牌靛蓝，停键约 420ms 内渐隐回模式色——
  与进行中跑马灯、结束闪光同路数（逐格上色），互不冲突。

### 修复
- **补回 0.10.5 遗漏的版本欢迎通知**：`RECENT_UPDATES` 新增当前版本条目（输入框动效新观感），
  修复 `recentUpdates` 校验「当前版本应有专属欢迎通知」的失败。

## [0.10.5] - 2026-06-25

### 新增
- **输入框任务动效**：把输入框由「上下两条横线」升级为**手绘四边矩形框**，并随任务状态变化：
  - **进行中**（`isStreaming`）：一段品牌色渐变彗星（星辉→靛蓝→琴琶）带拖尾，沿边框**顺时针流动**（~100ms/帧）。
  - **结束时**：一道更亮更快的星辉彗星带 `✦/✧` 星符沿同一圈**快速扫一圈**（~800ms）后落回模式色静态边框。
  - **空闲**：完全静止的模式色边框，零定时器、零额外重绘。模式标签仍嵌在上边框中央。
  - 实现：逐格上色 + 相邻同色合并为单个 `<Text>` 控制节点数；用 `measureElement` 量内容高度绘制左右 `│`。

## [0.10.4] - 2026-06-25

### 优化
- **`/selection` 启动需显式 `start`**：裸 `/selection` 不再静默启动，而是打印用法（start/open/stop/status/setup）；
  启动一律用 `/selection start`，避免误触。
- **slash 子命令补全**：输入 `/selection ` 后在输入框下方灰色列出 start/open/stop/status/setup，↑↓ 选择、Tab
  补全、Enter 运行；输入 `s` 会过滤到 start/stop/status/setup。`/mode`、`/reason` 同样支持子命令补全。

## [0.10.3] - 2026-06-25

### 新增
- **`/selection` 命令（REPL 内置）**：在交互式 REPL 里敲 `/selection` 即可**后台自动拉起** bridge 服务并提示如何绑
  macOS 快捷指令；配套 `/selection open`（立即弹面板）、`/selection stop`（关闭服务）、`/selection status`（健康
  检查）、`/selection setup`（打印带本机绝对路径的快捷指令配置）。与 `astraea selection` CLI 子命令共享同一套自愈逻辑。
- **Windows / Linux 适配**：选区捕获与开窗改为按平台分发——Windows 用 PowerShell（保存剪贴板→发 Ctrl+C→读取→
  还原，隐藏窗口不抢焦点）捕获选区，并以 Edge/Chrome 的 `--app` 无边框窗口作为悬浮面板的等价物（取不到则回退默认
  浏览器）；Linux 直接读 X11/Wayland 的 PRIMARY 选区（`xclip`/`wl-paste`），用 `xdg-open` 开窗。`selection setup`
  现按平台输出对应快捷键绑定指引（Windows 给 AutoHotkey 与 .lnk 两种方案）。
- **`selection stop` 关闭服务**：bridge 新增 `POST /shutdown` 路由，`astraea selection stop` 与 `/selection stop`
  可一键关闭后台常驻的 bridge 服务并释放端口。
- **`astraea selection` 命令行入口**：新增 `astraea selection` 子命令，作为 floating selection UI 的统一入口。
  `astraea selection`（= `open`）会先检测本地 bridge 服务是否在跑，没跑则**自动在后台拉起**再捕获选区、弹出悬浮
  面板——单条命令即可，无需再单独常驻 `bun run bridge:selection`。把它绑到 macOS 快捷指令上即可一键唤起。
  配套子命令：`start`（前台常驻 bridge）、`status`（健康检查）、`setup`（打印带本机绝对路径的快捷指令配置说明）。
  自愈逻辑抽到 `src/services/selection-bridge-client.ts`，`bridge:selection:open` 直接入口也共享，因此无论从
  哪个入口触发，「打开 UI 即自动起服务」的行为完全一致。
- **macOS 原生悬浮命令面板**：`bridge:selection:open` 在 macOS 上不再跳转浏览器标签页，而是弹出一个
  无边框、置顶、跟随鼠标出现的小窗口（Swift `NSPanel` + `WKWebView`，源码 `macos/AstraeaPanel.swift`）。
  选中文本自动带入，用户只需输入命令并点发送；按 `Esc`、点 `✕` 或点窗外即可关闭，全程不离开当前 app。
  Swift 面板首次运行经 `swiftc` 编译并缓存到 `macos/.build/astraea-panel`，仅在源码变更时重建。
  可用 `ASTRAEA_SELECTION_UI=browser` 回退到旧的浏览器标签页行为。
- **极简单输入框命令 UI**：companion 重做为以一个精致大圆角输入框为唯一核心的界面（白 + indigo 微光、
  圆形发送键、淡入动效）。选区文本自动预填在输入框里，用户在后面追加一句指令即可发送；回复**默认不展开**，
  发送后才在输入框下方淡入。新增 `?embedded=1` 视图供悬浮面板加载，通过 `webkit.messageHandlers` 与原生
  宿主通信。
- **悬浮窗随回复动态增高 + 可拖动**：回复不再固定高度，窗口高度随内容**顶部锚定向下增长**，接近屏幕高才滚动；
  顶部留出透明拖动条，可用鼠标拖动整窗到任意位置（右上 ✕ 关闭按钮保持可点）。
- **选区/指令自动拆分**：发送时自动把「预填的选区原文」与「用户追加的指令」分离，分别作为 `selection`（不可信
  上下文）与 `instruction`（权威命令）提交；不追加指令也能发送（使用默认指令兜底），不再出现 “need command”。

### 优化
- **悬浮面板 UI 极简重做**：去掉外层卡片那一层，整个界面收敛为**单个描边输入框**——「✦ Astraea · 来自 macOS
  selection」标题嵌进输入框顶部描边线（`<legend>` 缺口），关闭 ✕ 收进框内右上角，回复区默认隐藏（修复了
  `[hidden]` 被 `display:flex` 盖过导致回复区常驻的问题），发送后才在下方淡入。输入框更紧凑、文字垂直居中。
  原生面板尺寸相应收窄（440→400），最小高度下调。
- **关闭键改为清晰的「ESC ✕」**：右上角换成带 X 描边图标 + “esc” 文字的关闭键（白底嵌在描边线上），同时提示
  按 Esc 可关闭。
- **标题不再被裁/发灰**：给标题 chip 加白底并禁止换行，「✦ Astraea · 来自 macOS selection」完整可读；移除
  WKWebView 的 16px 圆角遮罩（它会裁掉落在左上角的标题文字），改由白色输入框自身的圆角呈现。
- **悬浮面板可鼠标拖动**：顶部拖动条加厚到覆盖整条标题行（避开右侧 ESC✕ 与下方输入框），标题行即拖拽手柄，
  修复收窄后窗口无法用鼠标拖动移动的问题。
- **ESC 关闭键与发送键分开**：增大输入框上内边距、上移 ESC chip，消除右上角 ESC✕ 与右侧发送圆钮的轻微重合。

### 修复
- **draft 创建不再要求 instruction**：`/draft` 此前误用 `/ask` 的校验逻辑，对空 `instruction` 报
  “instruction is required”，导致快捷键捕获选区后无法建 draft。现在 draft 允许空命令（命令在 UI 里再输入），
  `/ask` 仍要求非空 instruction。

## [0.10.1] - 2026-06-24

### 新增
- **本地选区命令桥接服务**：新增 `bridge:selection` 启动脚本和 `/ask` 本地 HTTP 入口，接收任意捕获端传入的
  `instruction`、`selection` 与来源元数据，并把选区文本作为不可信上下文交给 Astraea 回复。该入口为后续
  桌面全局快捷键、浏览器右键菜单、PDF/doc/web 选区浮窗以及 Obsidian/Codex/Claude Code adapter 打底。
- **Selection Companion 白色/indigo 命令面板**：本地 bridge 现在直接提供高级小窗口 UI，支持选区预填、
  命令输入、回复展示与复制；新增 draft 暂存机制，供快捷键或右键入口传递长选区文本而不塞进 URL。
- **选区快捷键与浏览器右键入口雏形**：新增 `bridge:selection:open` macOS 选区捕获启动脚本，以及
  `extensions/astraea-selection` 浏览器扩展骨架，网页选中文本后可右键打开 Astraea 小窗口。
- **/init 项目初始化命令**：新增内置 prompt command `/init [focus]`，会引导 Astraea 扫描当前仓库的
  `package.json` / README / `.mcp.json` / `.cursor/rules` / 既有 AI 指令等高信号文件，询问用户要创建
  团队共享 `AGENTS.md`、个人私有 `AGENTS.local.md` 还是两者，并按 Astraea 真实加载规则生成精简项目说明。
  命令默认使用 Bun 语义，明确禁止误建 `CLAUDE.md`，并可按需创建 `.astraea/skills/<name>/SKILL.md`
  项目技能。

### 优化
- **Welcome 最新更新允许四条并置顶 /init**：最近更新列表上限从 3 条放宽到 4 条，新增 `/init`
  项目初始化提示并排在第一条，方便用户启动时第一时间发现项目上手能力。
- **astraea-community 官网同步 v0.10.1**：社区站首页 current release 与 Recent updates 已更新为
  `/init` 项目初始化向导，并在命令文档中加入 `/init` 的用途、示例与使用场景。

## [0.10.0] - 2026-06-24

### 修复
- **/login 选择 DeepSeek V4 Flash 后仍显示/使用 Pro**：`/login` 现在把用户刚选择的
  provider/model 视为最高优先级。若 provider 或 model 发生变化，会清除当前会话里的
  `/reason` 档位，并同步移除持久化和运行时 env reasoning override，避免旧的 `high` / `max`
  推理档在 DeepSeek V4 下继续把 `deepseek-v4-flash` 临时升到 `deepseek-v4-pro`。

### 优化
- **DeepSeek V4 prompt cache 前缀更稳定**：系统提示构建现在把稳定的 memory 行为指令前移到
  `# Environment` 等动态环境信息之前，扩大可命中缓存的静态 system prompt 前缀；模型请求也不再把
  AGENTS/日期/MEMORY index 这类每轮变化的 reminder 放在对话消息最前面，而是放到历史消息之后、
  相关记忆之前，避免高频变化内容破坏 DeepSeek V4 低价 cache-hit 的前缀复用。
- **DeepSeek V4 长上下文下按 80/90/95 策略 compact**：DeepSeek provider 现在按 effective window
  计算上下文阈值：80% 启动 Eclipse ctx-agent 后台折叠，90% 提醒并触发 commit/autocompact，
  95% 进入阻塞式折叠或硬阻塞，优先保留原始长任务上下文，减少过早摘要带来的细节损失；同时
  `FileReadTool` 的单次读取 token 上限从 25K 提高到 80K，让 1M 窗口下按 6% 比例放宽到 60K，
  但仍保留绝对上限，避免单次读取失控。
- **DeepSeek 小模型默认固定 Flash**：内部轻量调用和 Eclipse ctx-agent 默认使用
  `deepseek-v4-flash`，不再跟随主模型切到 `deepseek-v4-pro`；需要高保真内部任务时可用
  `DEEPSEEK_SMALL_MODEL` 显式覆盖。
- **小模型结构化响应抽象**：`querySmallModel` 新增 provider-neutral 的
  `structuredResponse: 'json'` 选项。所有 provider 都会强化 JSON-only 系统提示，OpenAI-compatible
  provider 额外透传 `response_format: { type: 'json_object' }`，空响应或非法 JSON 会自动重试一次。
  `/goal` evaluator / critique / verifiability 已切到该能力，减少结构化判定的格式漂移。
- **Welcome 面板展示 Astraea 官网**：启动欢迎页现在在模型/目录/工具信息下方显示
  `astraea website: https://astraea-community.vercel.app/`，方便用户直接找到社区站点。
- **/export 改为交互式导出面板**：`/export` 现在会弹出方向键面板，用户可直接导出到当前文件夹、
  选择粘贴文件/文件夹路径，或取消；仍兼容 `/export <path>` 直接导出。路径解析支持绝对路径、
  相对路径和目录路径，并会自动创建目标目录。

## [0.9.49] - 2026-06-23

### 新增
- **Spreadsheet 工具支持 Excel `.xlsx` 读写**：新增结构化 `Spreadsheet` 工具，`action="read"`
  会解包 `.xlsx` workbook/worksheet XML 并输出 sheet 列表与 Markdown 表格预览；`action="write"`
  可从二维 rows 创建/覆盖一个真实 `.xlsx` 工作簿。普通 `Read` 碰到 `.xlsx` 现在会明确提示改用
  `Spreadsheet`，避免把 Excel 当文本或二进制乱码处理。旧 `.xls` 仍保持拒绝并提示先转换为 `.xlsx`。

### 修复
- **WebBrowser 任务不再频繁卡顿**：截图动作只返回可读摘要和 PNG 字符数，不再把原始 Base64 写入
  工具结果；同时将 UI/web 验证规则改为按需选择工具，静态页面、文档和 README 链接优先使用 WebFetch，
  只有需要视觉渲染或交互验证时才使用 WebBrowser。WebBrowser 动作新增默认超时和返回文本上限，
  避免视觉验证在慢页面或超长页面内容上长期卡住。

## [0.9.48] - 2026-06-23

### 新增
- **/rename 会话命名命令**：新增本地 slash command `/rename <session-name>`，给当前会话写入
  `custom-title` transcript 元数据；裸 `/rename` 会参考当前对话自动生成一个短 kebab-case 名字。该标题
  不会进入模型上下文；`/resume` 列表会优先显示用户命名，终端标题也会立即切换为该会话名。对齐
  Claude Code 中 `/rename` 作为会话标题/检索名的核心用途。

## [0.9.47] - 2026-06-23

### 修复
- **counsel 越权执行写/bash 的 bug**：counsel 此前在「方向确认 + 现在开始执行」双闸通过后会就地
  放开写/执行权限，违背只读语义。现改为与 orbit 严格对称——counsel 全程只读，框架层（`query.ts`）
  无条件拦截一切非只读工具（Edit/Write/Bash 等），`fileWriteBehavior('counsel')` 兜底由 `allow`
  改为 `deny`。
- **counsel 唯一执行入口 ExitCounselMode**：新增只读工具 `ExitCounselMode`。模型咨询完用户、方向
  明确后调用它请求授权；用户「allow this session」→ 自动 `setMode('cruise')` 切入 cruise（文件写
  自动通过、shell 仍逐条确认）后方可动手；用户拒绝则留在只读 counsel 继续咨询。删除旧的 `askOne`
  「现在开始执行」自动放行逻辑。

### 移除
- **counsel 关键词正则自动切换**：删除 `detectLongTask` / `detectCounselTask` 整套硬编码中英关键词
  正则及其在 `App.tsx` 的自动切模式逻辑。不再靠扫描用户文本猜测任务大小来强制切 counsel——模式
  回归用户掌控（手动 `/mode` 进入），是否在执行前先咨询交由模型按任务哲学 Principle 1 自行判断。

## [0.9.46] - 2026-06-23

### 新增
- **/export 导出会话为 Markdown 文件**：将当前对话（user + assistant 消息、工具调用摘要和结果）渲染为
  结构化的 `.md` 文件输出到工作目录。`/export` 自动生成 `conversation-<时间戳>.md` 文件名，
  `/export <name>` 使用自定义文件名（自动补齐 `.md` 后缀）。渲染格式包含会话元信息（日期/provider/
  模型/sessionId）、用户消息（过滤 <system-reminder> 噪声）、Astraea 回复正文、工具调用块（名称 +
  参数 JSON）以及工具返回摘要。对标 Claude Code `/export` 并增加 Markdown 结构化输出。

## [0.9.45] - 2026-06-23

### 优化
- **Markdown 代码更像代码区**：普通三反引号代码块现在使用 Astraea 主题的深蓝灰背景板、外置行号沟、整行铺底与空行铺底，保留既有语法高亮和长行截断；行内代码也加入同款蓝灰底与轻量左右 padding，同时保留 cyan 强调。

## [0.9.44] - 2026-06-23

### 修复
- **PowerShellTool 在 forge 模式下仍弹权限确认**：PowerShell 现在和 Bash 共用同一套 shell
  permission 模式语义，`forge` 会自动放行本应询问的普通执行命令，`default` / `cruise` 继续询问，
  无交互后台 fail-closed，`orbit` / `counsel` 仍由调度层按非只读执行工具拦截；写 `.git`、`.astraea`
  等敏感路径的红线命令即便在 `forge` 下也会降级为确认。

## [0.9.43] - 2026-06-23

### 修复
- **/goal 使用多行粘贴时目标条件显示为 `[Pasted text #N ...]`**：提交入口现在会先把输入框里的
  粘贴占位符展开为真实内容，再进入 slash 命令解析；因此 `/goal <多行粘贴>` 存入状态机、
  evaluator 的都是实际目标条件，而不是 UI 占位符。进度面板遇到超长目标时只显示一句摘要，
  避免大段粘贴把常驻区撑满；完整条件仍保留给 evaluator 使用。普通历史展示仍保留用户提交时
  看到的简短文本，避免大段粘贴把终端刷满。

## [0.9.42] - 2026-06-23

### 修复
- **长思考后 Astraea「自己退出」、零输出回到提示符**：开启 `/reason`（extended thinking / reasoner CoT）
  后，模型在综合作答前先思考数十秒至数分钟。根因有两环叠加：
  1. **思考增量被丢弃**：Anthropic 适配器只处理 `text_delta`/`input_json_delta`，把 `thinking_delta`
     （及 DeepSeek/Kimi/OpenAI 的 `reasoning_content`）直接吞掉，内层流在整个思考阶段一个事件都不发。
     空闲看门狗（默认 90s）据「两次事件间隔」判活，于是把"模型正在思考"误判成半开连接而 abort。
  2. **兜底被自己掐死**：看门狗超时后本应走非流式 fallback 救场，但 fallback 与被 abort 的流式请求
     **共用同一个 AbortSignal**，`opts.abort()` 一调，fallback 拿到的就是已 aborted 的 signal，
     `messages.create` 一发出即抛 `APIUserAbortError`。该错误又被 `isAbortError` 误判成"用户按 ESC"，
     令本轮静默 `done`、零输出收尾。表现正是"跑满约 2 分钟后自己退出"。
  修复：① `thinking_delta`/`reasoning_content` 增量改为 yield 轻量 `thinking` 心跳事件，看门狗据此重置
  计时，长思考不再误触发；② `linkAbort` 拆出只跟随【外部 ESC】的 `fallbackSignal`，看门狗的 abort
  不再波及兜底——真·半开连接时 fallback 能真正发出请求救场。五个 provider（Anthropic/OpenAI/DeepSeek/
  Kimi/Ollama）一并修复。补 6 条看门狗回归测试。

## [0.9.41] - 2026-06-23

### 新增
- **权限确认触发系统级提醒**：当 Astraea 需要用户 Allow/Deny 权限时，会立即复用终端通知通道提醒用户回来处理。
  macOS 后台终端会通过 Dock 弹跳/红色角标提示；Windows Terminal 后台会闪任务栏。提醒不受任务完成通知的
  `minDurationMs` 限制，避免权限框挂起时用户没有感知。

### 修复
- **中止请求被误判为报错**（ESC 中止 / `/goal` 长跑被打断时弹出红色「■ Error. Request was aborted.」）：
  根因是 Anthropic / OpenAI SDK 在流式 abort 时抛的是 `APIUserAbortError`，其 `.name` 退化为默认的
  `'Error'`（基类未设 `this.name`）、`.message` 固定为 `'Request was aborted.'`，而旧代码只用
  `err.name === 'AbortError'` 判定中止，导致 SDK 的中止错误全部漏网、被当作真错误冒泡。新增统一的
  `utils/abortError.ts#isAbortError(err, signal?)`（同时识别原生 `AbortError`、SDK 的中止错误、以及
  「signal 已 abort」旁证），替换 `query.ts`、`ui/App.tsx`、`services/compact/compact.ts` 的全部 5 处
  脆弱判定。现在按 ESC 中止任意请求都会干净收尾，不再弹红色报错，`/goal` 状态也保留以便继续或清除。

## [0.9.40] - 2026-06-23

### 新增
- **/goal 完成前补充 evidence critique**：主 evaluator 判定目标达成后，会再调用一个只读 transcript
  的 critique 层，专门检查三类风险：外部证据是否充分、测试/检查是否覆盖关键风险、是否通过跳过测试/
  放松断言/弱化命令等方式偷换验证标准。critique 只负责拒绝薄弱证据并要求继续补证，不替代 `bun test`、
  build、实际运行、渲染检查或数据交叉验证。

### 修复
- **粘贴多行文本错行/叠字乱码**：从终端回滚区或部分来源复制的多行文本以裸 `\r`（或 `\r\n`）
  当行分隔符时，输入框只认 `\n`，既骗过「多行→折叠为占位符」判断、又把裸回车符送进单行
  缓冲区——终端光标被打回行首覆盖前文，渲染成 `pending`+`dated` 那种叠字串行的乱码。修复：
  `TextInput.handlePaste` 入口统一把 `\r\n`/`\r` 归一成 `\n` 再走折叠，useInput 兜底粘贴
  检测也认 `\r`。现在 `\n`/`\r\n`/裸 `\r` 分隔的多行粘贴一律折叠成 `[Pasted text #N +N lines]`，
  提交时展开回原文。

## [0.9.39] - 2026-06-23

### 修复
- **TodoWrite 同轮证据引用误报 unknown**：工具结果证据现在会在单个工具执行完成后立即登记，
  不再等整批工具全部结束才写入证据表。模型可以在同一轮里先读取/验证，再用 `TodoWrite`
  将任务标记为 completed 并引用刚产生的 `toolu_*` 结果 id；失败结果和 TodoWrite 自身仍不会成为证据。
- **/login 切换模型后重启仍显示旧 DeepSeek 模型**：登录向导现在会继续保存全局
  `~/.astraea/.env`，同时在项目存在 `.env` 覆盖时同步合并本次选择的 provider/model/API key。
  这样从 `deepseek-reasoner` 切到 `deepseek-v4-pro` 后，下一次启动的 welcome 面板不会再被项目级
  `DEEPSEEK_MODEL` 打回旧模型。

## [0.9.38] - 2026-06-23

### 修复
- **AskUserQuestion 多题面板方向键错轴**：修复 ↑↓ 被优先分支拿去切换题目、导致选项无法移动的问题。
  现在与面板提示一致：←→ 切换问题，↑↓ 移动当前问题的答案光标，Space/Enter 行为保持不变。

## [0.9.37] - 2026-06-23

### 修复
- **REPL 流式回复直接按 Markdown 渲染**：live 预览不再先显示 `**bold**`、``` 等原生 Markdown
  标记、等回复落盘后才转换格式。参考 Claude Code 的 streaming markdown 思路，Astraea 现在在
  流式阶段先走同一套 `renderMarkdown`，再用 ANSI 感知的安全裁剪保住终端宽度，避免回到之前的
  重影/折行问题。

## [0.9.36] - 2026-06-23

### 新增
- **TodoWrite 升级为可验收执行清单**：Todo 不再只是 `content/status`。每项现在必须携带
  `acceptanceCriteria` 与 `verificationCommand`，让计划从创建时就带上明确完成条件和验证路径。
- **Todo 完成证据闸门**：`completed` 不能直接从新建状态写入，必须先经过 `in_progress`；完成时还必须
  提供 `evidenceRefs`，并且引用系统登记过的成功工具结果。失败工具结果、伪造 id、无证据完成都会被拒绝。
- **工具结果证据登记表**：调度层会把每次成功工具调用记录为可引用证据，TodoWrite 自身和失败结果不会成为证据，
  防止模型用自然语言或假 id 证明任务完成。

### 文档
- 更新 `task/Astraea任务准确性与动态编排增强.md`，用通俗语言解释 TodoWrite 与 Task Graph 两层结构，
  以及“计划动态调整、每步验收、结论带证据”三项能力如何落到实现上。

## [0.9.35] - 2026-06-23

### 修复
- **空的 ✸ Astraea 头在内容到来前提前蹦出**：live 流式帧的渲染兜底把 `showHeader` 算了进去，
  而 turn 起点（上一条是 user）`showHeader` 恒为 true → 正文/工具都还没来时就先画一个空的
  `✸ Astraea` 头，然后干等思考、内容才姗姗冒出；用户视角是「✸ Astraea 先蹦一个、很久后又
  蹦一个真的」（空头在 live、真头在 Static，超宽行还会重影成 `✸ Astraea ✸ Astraea`）。把渲染
  判定抽成纯函数 `hasLiveBody`（`src/ui/liveFrame.ts`），只看「真有正文/工具」，空窗期交给下方
  StreamStatus 思考行表示「在干活」，补单测覆盖四种输入组合。

## [0.9.34] - 2026-06-23

### 修复
- **Astraea 输出时 `/language` 被吞掉**：流式执行中只放行 `/stop` 和 `/mode`，其余斜杠命令一律
  在「其它斜杠命令忽略」处 `return` 掉，导致用户在 Astraea 正在回复时敲 `/language` + Enter
  毫无反应。把 `/language` 加进流式白名单（与 `/mode` 同理——切 locale / 弹向导都是纯本地 UI
  操作，不碰在飞的查询）。同时把流式与非流式两处重复的 `/language` 解析逻辑抽成纯函数
  `resolveLanguageCommand`（`src/i18n/index.ts`），避免两处逻辑漂移，并补单测覆盖
  `/language` / `/language <code>`（大小写不敏感）/ 未知码退回向导 / 非命令返回 null。

## [0.9.33] - 2026-06-22

### 修复
- **LoginWizard DeepSeek 模型列表行宽溢出**：`ListRow` 中 label 的 `padEnd(22)` 使得最长行
  `❯ deepseek-reasoner + legacy R1 alias (retires 2026-07-24)` 达 60 字符，超出 Box 内容区
  58 列限制导致行末文字折行。缩至 `padEnd(18)`，最大行宽降至 56 列，保留余量。

## [0.9.32] - 2026-06-23

### 新增
- **任务完成终端通知（Dock 弹跳 / 任务栏闪 / 通知中心横幅）**：参考 claude-code 的 notifier，
  本轮任务干净收尾或报错时向真终端 `/dev/tty` 写一声响铃 `BEL`(\x07) 外加各家终端的原生富通知
  OSC，提示用户「去看一眼」。机制天然不打扰——macOS 只在终端**不在前台**时才把 Dock 图标点亮成
  红色角标「1」，Windows Terminal 也只在后台闪任务栏；用户正盯着看时几乎无感。
  - `auto` 通道按终端自动选：iTerm2/WezTerm→OSC 9、kitty→OSC 99、ghostty→OSC 777、
    Apple Terminal 及其余→纯响铃 `BEL`；Windows 统一走 `BEL`。
  - tmux/screen 下 OSC 富通知用 DCS 包裹透传，但 `BEL` 保持裸写（触发 tmux 的 bell-action）。
  - 可在 `~/.astraea/settings.json` 配 `notify`：`enabled`(默认 true) / `channel`(默认 auto) /
    `minDurationMs`(仅当本轮耗时 ≥ 此值才响，默认 0) / `sound`(富通知是否额外补一声响铃，默认 false)。
  - 新增 `src/utils/terminalNotify.ts`（复用 `terminalTitle.ts` 的 `/dev/tty` 直写基建）与
    单测 `terminalNotify.test.ts`。

## [0.9.31] - 2026-06-23

### 修复
- **粘贴多行/中文导致输入框错行、光标卡死**：未开 bracketed-paste 的终端（部分 macOS 终端）
  会把整段粘贴当作一次 `useInput` 事件、`input` 里直接带换行送来，绕过了 `usePaste` 的折叠通道，
  裸 `\n` + 宽字符落进缓冲区——Ink 按列宽换行、伪光标按码点定位，两套坐标对不上，重绘错行、
  光标看着无法右移。现在 `TextInput` 在按键插入分支识别「像粘贴」的 chunk（含换行或超长），
  改走 `handlePaste` → `transformPaste` 折叠成 `[Pasted text]` 占位符再插到光标处；无
  `transformPaste` 的字段（`/login`、`/internet` 的 Key 框）则把换行折成空格，确保单行输入框
  里永不出现裸 `\n`。

## [0.9.30] - 2026-06-23

### 优化
- **意图行提权（开工前先出声）**：系统提示 `voiceTone` 段把“工具调用前先输出一句意图行”从深埋的
  `Acting out loud` 子条目提为顶层高优先小节 `Open with intent`，并把“用户看不到工具调用、
  沉默=卡死”的因果理由抬到显眼位置。同时消除与“conclusion first / do not emit text”的冲突——
  意图行在每个工具轮强制、永不算“不适用”。修复 Astraea 收到任务后直接 grep/glob 不出声、
  读起来像卡死的问题。仍不输出“收到/明白/我现在开始”类问候：那一句陈述目标，而非确认收到。

## [0.9.29] - 2026-06-22

### 优化
- **Recent updates 缩短**：v0.9.28 更新消息精简，英文从 21 词缩至 15 词，其余五语同步缩短。
- **命令高亮泛化**：WelcomePanel 中所有 `/command` 引用自动染琥珀黄（之前仅 `/login` 有高亮），
  对齐系统提示全部命令高亮的规范。

## [0.9.28] - 2026-06-22

### 新增
- **模糊任务自动进入 Counsel**：在原有长任务检测之上，识别“把 UI 设计得美观一些”、
  “优化一下这个页面”等缺少可验收目标的请求，自动切入先问后做的 Counsel 双闸流程；
  信息查询和目标具体的修复任务不误触发。
- **/goal 动态任务图与逐步验收（Task Graph）**：TaskCreate / TaskUpdate 支持声明依赖、
  验收标准（acceptanceCriteria）和带来源的证据（evidence）。上游失败或证据失效时，
  只沿依赖边传播 `invalidated`，独立任务不受影响。添加 `blocked` / `invalidated` 状态，
  循环依赖就地拒绝、验收标准更改时清空旧证据。
- **证据与目标双轨验收**：每步的证据包含 criterionId、claim、source、confidence、
  assumptions 五项——完成闸门逐条检查，缺失则保持原状态并返回原因。
  `/goal` 负责整体终验，Task Graph 负责逐步验收。

### 安全
- **Shell 只读分类收紧**：`curl` / `wget` / `find` / `awk` / `env` / `command` / `git fetch` /
  `git stash` 及命令替换不再绕过权限确认，阻止本地文件外传和隐式写入。
- **项目与插件 MCP 不再静默自启动**：避免打开不可信仓库时直接执行 `.mcp.json`
  里的 stdio 命令。明确信任时可设置 `ASTRAEA_TRUST_PROJECT_MCP=1`。
- **凭据改为全局私有存储**：`/login` 不再把 Provider Key 写入项目 `.env`，改写
  `~/.astraea/.env`；secrets、MCP 本地配置、权限配置、transcript、审计日志和调度任务
  统一强制 `0600`。
- **网络与外部动作防护**：WebFetch 在初始请求和每次重定向前拒绝回环、私网、
  link-local 与云元数据 IP；WebBrowser `click` / `type` 改为外部副作用，非 Forge 需一次性
  确认，无人值守时 fail-closed。
- **路径与审计防护**：写入红线检查会沿现存父目录解析 symlink，防止通过普通别名修改
  `.git` / `.astraea` / shell 启动文件；审计落盘前脱敏 API Key、Bearer 与 token 参数。

### 测试
- 新增模糊任务判定、Shell 外传/隐式写入、MCP 启动信任、secrets 文件权限、
  SSRF 私网拦截、浏览器副作用、symlink 红线和审计脱敏回归覆盖。

## [0.9.27] - 2026-06-22

### 新增
- **REPL Welcome 新增 Recent updates**：每次进入 REPL 时，在 Welcome 卡片内部展示开发者精选的
  本地更新通知。记录包含所属版本、数字优先级和 `persistent` 生命周期；当前版本消息与跨版本重要
  消息合并后按优先级降序展示，优先级字段不暴露给用户。首条持续通知提醒 DeepSeek 模型已迁移到
  V4 Flash / Pro，并引导用户运行 `/login` 重新登录。
- **更新通知支持全部六种界面语言**：English、Deutsch、Français、Español、中文、한국어 均提供
  标题与正文；没有有效通知时整块隐藏。

### 测试
- 新增更新数据契约与 Welcome UI 验收：覆盖六语言完整性、跨版本持续展示、优先级排序、开发者维护
  的最多三条约束，以及 40 / 58 / 100 列终端下的边框闭合与自然换行。

## [0.9.26] - 2026-06-22

### 新增
- **DeepSeek V4 适配（原生 thinking 旋钮）**：DeepSeek V4 取消了独立的 `reasoner` 模型 id，改为
  同一 model 通过 `thinking.type`（`enabled`/`disabled`）开关思考、`reasoning_effort`（`high`/`max`）
  调推理深度，CoT 仍走独立 `reasoning_content`（不占 `max_tokens` 预算）。`reasoningEffort.ts` 新增
  三个纯函数 + 共用解析：
  - `deepseekIsV4(model)` — 是否 `deepseek-v4-*`，决定走 thinking 参数还是旧的换模型逻辑。
  - `deepseekResolveModel(effort, configured)` — 本次请求实际 model id，UI 显示与 API 调用共用同一解析。
    V4 下 `high`/`max` 自动升 `deepseek-v4-pro`，其余保持 configured；旧别名沿用 `medium+ → deepseek-reasoner`。
  - `deepseekThinkingParam(effort)` — V4 思考控制参数（`auto`/`low` 关思考；`medium`/`high` 开+`high`；`max` 开+`max`）。
- **默认模型切到 `deepseek-v4-flash`**：便宜快（$0.14/$0.28 per MTok）、1M 上下文。`/reason` 的 `medium`
  在当前模型开思考，`high`/`max` 自动升 `deepseek-v4-pro`（$0.435/$0.87、深度推理）。
- **定价登记 V4**：`deepseek-v4-flash` / `deepseek-v4-pro` 加入 `pricing.ts`，cache-hit 倍率极低、无写入费。
- **LoginWizard 模型选单**新增 V4 flash/pro 两项，旧别名 `deepseek-chat`/`deepseek-reasoner` 标注「2026-07-24 下线」。

### 变更
- **品牌色集中到 `theme.ts`**：此前 `INDIGO`/`SILVER`/`AMBER`/`DEEP` 散落在 14+ 组件各自 `const … = …`，
  已出现色偏（`QuestionPanel` 误用 `#7C6FF0`、两处 amber 取值不一）。统一为 `theme.ts` 唯一真相源，
  各组件改为 `import { … } from './theme'`，改一处即可全局换肤。
- DeepSeek 默认上下文窗口 128K → 1M（`DEEPSEEK_CONTEXT_WINDOW` 仍可覆盖）。
- `ReasonSelector` 的 DeepSeek 提示语改为 V4 行为：`medium → enables V4 thinking`，`high`/`max` 追加「upgrades to deepseek-v4-pro」。
- 旧别名 `deepseek-chat`/`deepseek-reasoner` 在 2026-07-24 前经 `DEEPSEEK_MODEL` 仍可用，走向后兼容路径（保留 `deepseekEffectiveModel` / `deepseekReasoningDirective`）。

## [0.9.25] - 2026-06-22

### 新增
- **流式空闲看门狗（Stream Idle Watchdog）+ 非流式 fallback**：SDK 的请求超时只覆盖初始
  `fetch()`，不覆盖流式 body——一旦中转代理把连接悄悄掐断（半开连接），裸 `for await` 会无限
  挂起，headless / `-p` 模式下无人按 ESC 即永久卡死。新增 `src/api/idleWatchdog.ts`：在每个
  chunk 之间起 `setTimeout`，超过 `ASTRAEA_STREAM_IDLE_TIMEOUT_MS`（默认 90s）没收到新事件即
  主动 abort 流式请求，并用同参数非流式重试一次（`messages.create` / `chat.completions.create`
  `stream:false`），把整条响应映射成等价 `StreamEvent`。覆盖全部 5 个 provider（anthropic /
  openai / deepseek / kimi / ollama）。
  - 关键语义：外部 ESC 与看门狗超时都能 abort SDK 流，但**只有看门狗超时路径触发 fallback**；
    外部 abort 仍走 `query.ts` 既有 `AbortError` 分支，不进 fallback。
  - 各适配器统一拆成 `streamRaw*`（内层真实流式）+ `fallback*`（非流式兜底），共用同一份请求参数。
  - `src/config.ts` 新增 `streamIdleTimeoutMs`（`ASTRAEA_STREAM_IDLE_TIMEOUT_MS` 覆盖，默认 90000）。

## [0.9.24] - 2026-06-22

### 修复 / 改进
- **修复 Vigil 一次性/周期任务确认点 Yes 仍被取消**：`VigilOnceTool` / `VigilScheduleTool`
  此前对 `askOne()` 回传值整串做 `startsWith('y')` 判定。但确认面板经 `formatAnswers()`
  返回的是 `"[header] <question>\n→ <选项 label>"` 整段多行文本，以 `[` 开头，永远不以
  `y` 开头——导致无论点 Yes 还是 No 都落进取消分支（模型转述为「已取消调度」），任务从未真正
  调度。改为只取 `→` 之后的实选项再判定（与 `ExitOrbitModeTool` 既有做法一致）。

## [0.9.23] - 2026-06-22

### 修复 / 改进
- **清理 `/language` 残留的 Language 系统提示段**：`getSystemPrompt()` 此前接受 `language`
  参数并往动态段里注入一条 "Always respond in {language}" 指令。实测模型已能准确匹配用户输入
  语言回复，无需额外指令干预；撤掉后系统提示减少 ~20 行变易段，缓存前缀稍收缩。
- **移除 App.tsx 无用的 `replyLanguageName()` 调用**：该函数仍在 `titleSummary.ts` 使用，
  App 这边调用它的结果却从未用过（`language` 参数不再传），删除残余调用。
- **voiceTone 措辞微调**：`Pick the language` → `Always respond in the language`，直指行为。
- **`.gitignore` 排除 Cursor 框架文件**：`.agents/`、`.codex/`、`AGENTS.md` 含 API key 等
  敏感配置，防止误提交。

## [0.9.22] - 2026-06-22

### 修复 / 改进
- **`/audit` 改为带框彩色表格 + mode 列 + 分页（解决"显示不全"）**：原 `/audit` 输出走
  markdown 渲染，`mode` / `reason.detail` 从不展示、target 被**硬截 60 字符**、`⟦ok⟧/⟦err⟧`
  标记因不在段首而**不上色**。现新增 `LocalCommandResult` 的 `'preformatted'` 类型（逐行原样
  透传、绕开 markdown，由 App.tsx 的 `preformatted` 历史角色逐行渲染、ANSI 保真），`/audit`
  改输出**盒线表格**：列含 Time / Result(绿/红上色) / Tool / Reason / **Mode** / Target，整表
  宽度自适应终端、target 按余量省略号截断（不再硬截）。新增分页：默认只铺最近 30 条，
  `--all` 铺全部、`--limit N` 自定义，超出时标题提示 "showing last N, use /audit --all"。
- **流式输出时 REPL 不再"跳到最顶"——live frame 高度封顶在视口内**：Astraea 边出 token
  边重绘的「进行中」帧，一旦比终端还高，Ink 的逐行擦除会越界、把 `<Static>` 已落地内容
  顶飞、视口猛跳到缓冲区最顶（用户往回滚时尤其明显）。现给页脚预留 `FOOTER_RESERVE` 行后，
  把「流式预览 + 在途工具批」总高压在剩余预算内：工具批只渲染最近若干次调用（更早的本轮
  结束统一落进 `<Static>`，用一行 `⋯ N earlier tool calls above` 占位，不丢信息），预览在有
  工具批时相应收窄。帧高不超过视口 → 不再越界擦除 → 回滚时可自由滑动。

## [0.9.21] - 2026-06-22

### 修复 / 改进
- **文件写「本会话全允许」接通 cruise 模式（对齐 Claude Code 的 acceptEdits）**：此前
  FileWrite/FileEdit 的确认框沿用 Bash 的四选项（Yes / No / Always allow / Always deny），
  但 `fileWriteGate` 只读 `confirm.proceed`、**完全无视 `confirm.remember`**，导致 "Always
  allow / deny" 是**死选项**——选了不持久化、也不改任何行为。根因比"漏读字段"更深：Claude
  Code 对文件写**根本不提供跨 session 持久化**，它的 "Yes, allow all edits this session" 本质
  是 `setMode('acceptEdits')`（纯会话内存），而 cruise 正是 Astraea 对 acceptEdits 的命名。
  - **确认框按来源分流**：`ConfirmRequest` 新增 `kind`（`'bash' | 'file'`）。文件写改用专属
    三选项 **Yes / Yes, all edits (cruise) / No**，去掉无落盘机制对应的 Always allow/deny；
    Bash/PowerShell 仍是原四选项。
  - **选「本会话全允许」→ 切 cruise**：`ConfirmResult.remember` 新增 `'session-cruise'`；
    `fileWriteGate` 命中后 `setMode('cruise')`（会话内存，不落盘 per-file 规则）。即便当前是
    红线敏感路径也可安全切——cruise 下普通写自动放行，但敏感写仍被红线降级为 ask 再次询问，
    切 cruise 不会绕过红线。
  - **可见反馈**：切换后 App 落一条 `cruise` 模式横幅 + 同步状态行，明确告知用户模式已切换；
    `setMode` 由 gate 统一负责（兼顾无 UI 的 readline 回退路径），UI 仅做展示，避免抢在审计
    判定前改写 `getMode()`。
  - **审计打通**：`AuditRecord.remember` 新增 `'session-cruise'`，该决策记为
    `user / switch to cruise`，与 DecisionReason 体系一致。
  - 新增 `fileWriteGate.cruise.test.ts`（切模式 / kind=file / 普通 Yes 不切模式 三例）。

## [0.9.20] - 2026-06-22

### 修复
- **Orbit 模式计划展示与审批的四个缺陷**：用户在一次纯只读调查里误触 Orbit 模式，暴露出
  计划呈现/审批流程的四个真实问题。根因都指向同一处设计——`ExitOrbitMode` 复用通用的
  AskUserQuestion 通道（`askOne`），把 25 行的计划**纯文本**预览塞进 `Question.question`
  字段。
  - **① 计划不以 Markdown 渲染**：计划预览经 `QuestionPanel` 用纯 `<Text>{q.question}>` 输出，
    没有走 markdown。**修复**：`Question` 新增可选 `planBody`；`ExitOrbitMode` 改用 `ask` 携带
    完整计划，App 的 `onQuestion` 订阅在收到带 `planBody` 的问题时，先把计划正文作为一条
    持久化的 assistant 历史条目落进 `<Static>`——assistant 条目本就走 `renderMarkdown`，于是
    计划以格式化 markdown 呈现。
  - **② 按 ESC 计划整个消失**：ESC 关闭待答问题时只 `setPendingQuestion(null)+answer('')`，而
    审批面板是计划在屏幕上的**唯一**副本，于是计划凭空消失（文件其实已存盘）。**修复**：因为
    计划已先落进永久的 `<Static>` 历史，无论面板被 Enter 提交还是 ESC 关掉，计划都留在屏幕上；
    ESC 路径无需改动，`answer('')` 仍正确地让会话留在 Orbit 以便修订。
  - **③ 计划没讲清要执行什么**：工具描述与 orbit 系统提示段都未要求「要执行的步骤」。**修复**：
    `ExitOrbitMode` 描述与 `builder.ts` 的 `orbitModeSection` 均要求计划按
    Context → Steps to execute → Files to change → Verification 结构化，明确告知用户批准后会发生什么。
  - **④ 误入 Orbit 模式**：`EnterOrbitMode` 描述只说「探索并设计方案」，未排除只读场景，导致
    模型连「检查一下 X」这类纯问答也进 Orbit。**修复**：描述加上明确的「只读问题/调查/解释类
    请求直接作答、不要进 Orbit」约束。
  - **顺带修掉一个潜伏 bug**：审批判定 `answer.includes('approve')` 会因问题正文本身含
    "Approve" 而对两个选项都判为通过；改为只解析 `→` 之后真正选中的选项 label。
  - 涉及文件：`src/tools/AskUserQuestionTool/bridge.ts`、`src/tools/ExitOrbitModeTool/index.ts`、
    `src/tools/EnterOrbitModeTool/index.ts`、`src/ui/App.tsx`、`src/ui/QuestionPanel.tsx`、
    `src/context/systemPrompt/builder.ts`。

## [0.9.19] - 2026-06-22

### 新增
- **结构化权限审计追踪（DecisionReason）**：此前每个权限决定只是 `'allow'|'ask'|'deny'`
  一个字符串，出安全问题只能翻日志猜「是模式拒的、规则拒的、还是红线降级的」，没有证据链。
  新增 `src/audit/`，给每条 allow/deny 决定打上**结构化原因**，事后可逐条追查。
  - **7 种 DecisionReason type**（1:1 映射代码里的真实决策出口）：`hard-block`（injection-check
    命令层硬拦）、`rule`（config/DEFAULT_RULES 命中，detail 记命中的 pattern）、`redline`
    （敏感路径把 allow 降级为 ask 所致）、`mode`（forge/cruise 放行、orbit deny 兜底）、
    `user`（交互式 y/n/a/d 选择）、`fail-closed`（无人在场 ask→deny）、`memory-exempt`
    （记忆子树写豁免）。
  - **落盘**：独立 `~/.astraea/projects/<cwd>/<sessionId>.audit.jsonl`，与 transcript 并列、
    复用 projectDir、沿用 30 天清理。一行一条 JSON：`ts/sessionId/tool/target/behavior/
    reason{type,detail}/mode/interactive/remember`（target 原文不脱敏，与既有隐私模型一致）。
  - **fire-and-forget**：写审计失败只 stderr 警告，绝不阻塞工具执行。
  - **接入**：`BashTool`（resolveShellPermission + 两处 hard-block 出口）与 `fileWriteGate`
    各自在决策出口构造 reason 汇入单一 `recordDecision()` sink；read-only 短路不入账（避免洪水）。
  - **查询**：新增 `/audit` 命令——默认列本会话决定，`--project` 扩到本项目所有会话，
    `--allow|--deny` 与 `--reason <type>` 过滤；`⟦ok⟧/⟦err⟧` 标记区分放行/拒绝。
  - SOP 见《权限和安全/权限决策审计追踪-DecisionReason与查询SOP.md》；新增 25 条单测。
- **PowerShell / Windows 安全线**：此前 `PowerShellTool` 只有 5 条内联 `BLOCKED_PATTERNS`，
  缺少与 Bash 对等的注入/危险 cmdlet 防线。新增 `PowerShellTool/security/injection-check.ts`，
  **设计参照 Claude Code 的 `powershellSecurity.ts` + `dangerousCmdlets.ts`**（其 24 个
  AST validator）。Claude Code 走 pwsh AST，本模块为与 Astraea 既有正则版 Bash 检查同构、
  且不引入 pwsh-parse 硬依赖，改用「正则 + 别名表 + 缩写展开 + 连字符归一」逼近覆盖面（AST 化为后续工作）。
  - **三档语义**（沿用 Claude Code，关键差异：危险命令默认 `ask` 而非静默放行）：
    - `block` —— 无合法用途的破坏性操作，永远拒绝：控制字符、Unicode 空白伪装、关闭
      Defender 实时防护、Defender 排除项、磁盘销毁、递归强删盘符根目录。
    - `ask` —— 任意代码执行 / 下载执行 / 持久化 / 提权等 **强制用户确认，且不可被 allow
      规则静默放行**：下载即执行链、`Invoke-Expression`、`-EncodedCommand` 混淆、嵌套 pwsh、
      远程下载器（含 certutil/bitsadmin LOLBAS）、`Add-Type`、`New-Object`、`Invoke-Item`、
      计划任务 / 服务 / 注册表持久化、`ForEach-Object -MemberName`、`Start-Process -Verb RunAs`、
      `-ExecutionPolicy Bypass`、隐藏窗口、进程/服务终止、别名/变量劫持、WMI/CIM 进程派生、
      模块加载、环境变量篡改、子表达式 `$()`/调用运算符、停止解析符 `--%`、高危 .NET 反射类型。
    - `pass` —— 放行，交由权限规则裁决。
  - **逼近 AST 的鲁棒性**：别名表（`iex`/`iwr`/`irm`/`ii`/`%`/`saps`…）、参数缩写展开
    （`-e`=`-EncodedCommand`、`-v`=`-Verb`、`-w`=`-WindowStyle`、`-m`=`-MemberName`…）、
    替代连字符归一（en/em-dash、horizontal-bar）。
  - checkId 段位从 100 起，与 Bash 段位错开，便于日志区分来源。
- 接入 `PowerShellTool/index.ts`（替换原 `checkPsSecurity`）：`block` 直接报错并带 `check #NNN`；
  `ask` 即使命中 allow 规则也强制 `confirmWithUser`（危险 cmdlet 永不被静默自动放行，对齐 Claude Code）。
- 同步更新 `redlines.ts` 分层安全注释；新增 56 条单测覆盖三档语义、别名/缩写/连字符及正常命令放行。

## [0.9.17] - 2026-06-21

### 修复
- **任务追踪纪律（长任务防漏做）**：此前整条链路没有任何机制推动模型建/维护 TodoWrite——
  系统提示从不提它、Query 循环无周期提醒，唯一的收尾 nudge 又只在「清单已有未完成项」时触发，
  而清单恒为空 → 永不触发（死结）。结果在 30+ 工具调用的长任务里，模型会丢子任务、偏离最初的
  多部分请求、无计划漂移。两处修复：
  - **系统提示新增 Principle 5 — Plan and track multi-step work**（`taskPhilosophy.ts`）：
    3+ 可分步骤 / 跨多文件 / 长跑任务先用 TodoWrite 列计划，单点小修不做仪式；同时只一个
    in_progress，验证完成即翻 completed，不批量收尾。
  - **Query 循环新增周期提醒**（`query.ts`）：抽出纯函数 `shouldRemindTodo`，连续 10 轮没用过
    TodoWrite（且距上次提醒也已 10 轮）即注入一条 `<system-reminder>` 轻推；解开旧死结，从
    「有未完成项才提醒」改为「该用却没用就提醒」。10 轮阈值本身就是过滤器——简单任务到不了 10
    轮，不会被打扰。对照 Claude Code `TODO_REMINDER_CONFIG`。

## [0.9.18] - 2026-06-21

### 修复
- **/goal 无参回车无反应**：`/goal` 的 slash `enterAction` 原为 `complete`，回车只把输入补成
  `/goal ` 后 return，吞掉了状态展示。改为 `execute`（对齐 `/reason`）——`/goal` 回车即显示当前
  目标状态 + 使用场景提示。
- **/goal 实时使用提示（GoalHint）**：输入 `/goal` 或敲下空格 `/goal ` 起，提示框即时浮在输入框
  上方（不必等回车）；新增 `isComposingGoal` 判定 + `GoalHint` 组件，与 SlashHint 并列。
- **/goal 设定后短暂空白像卡死**：set 时质量门 `assessGoalVerifiability` 是 1~2s 网络调用，原先
  `await` 在「清空输入→开跑」之间，期间无任何输出。改为先即时显示 set 确认并立即开跑（StreamStatus
  的耗时·token·短语状态行随即出现），质量门退为后台并发，模糊时异步补提醒。
- **去掉模式切换 banner**：切换模式不再在 scrollback 里刷 `── switched to X ──` 横幅（渲染处
  `return null`）；当前模式仍由输入框 `ModeInputFrame` 边框标签持续可见。

### 变更
- **/goal 无参状态文本去掉「预设快捷」行**：不再展示 `/goal test · lint · typecheck · build`
  那行（预设功能本身保留可用）。

## [0.9.16] - 2026-06-21

### 修复
- **Bash 输出对模型截断（防上下文爆炸）**：`BashTool.formatResult` 此前把 stdout 原样塞回
  给模型，模型可见侧没有任何字符上限——执行器的 64MB 字节闸只防进程 OOM，那个 `MAX=40` 行
  截断又只作用于终端 UI（`renderResult`）。结果一次 `cat 大文件` / 安装日志 / `find /` /
  大 JSON 就能把几十万 token 灌进上下文，触发 reactive compaction 或 413 溢出，把细粒度上下
  文一刀切毁掉，还烧 token、淹没模型。现新增 `truncateForModel`：stdout 限 30000 字符、
  stderr 限 10000 字符，超限保留**头部 + 尾部**（构建/测试日志的失败摘要常在末尾）、中间挖
  掉并标注省略字符数。对照 Claude Code 的 `maxResultSizeChars: 30000`。

## [0.9.15] - 2026-06-21

### 新增
- **/goal 实时进度面板（GoalPanel）**：目标激活期间常驻输入框上方，一眼可知「现在到
  哪了」——目标条件、第 N 轮进行中 · 已评估 M 轮 · 上限 40、已用时间 · token 消耗、上轮
  judgement。逼近 turn/token 上限时边框与对应行转橙提示。随每秒 `goalTick` 刷新。
- **/goal 使用场景提示**：`/goal` 无参或回看已达成记录时，附通俗版「什么样的目标能用」
  说明——好用（能用命令验证、对错一目了然）vs 别用（靠感觉、说不清算不算完成，易被误判
  或诱发走捷径）。
- **/goal 预设模板**：`/goal test|lint|typecheck|build` 一键展开为自带「出示证据」要求的
  规范、可验证条件，省事且天然把用户推向可验证写法。
- **/goal token 天花板**：`GOAL_MAX_TOKEN_SPEND`（50 万输出 token）作为 turn 上限之外的
  第二维硬闸，防少数 turn 内跑飞的循环烧光成本。
- **/goal 停滞检测**：连续 3 轮 evaluator 给出「实质相同」的理由（去数字归一化后相等）即
  判定卡死，提前交还控制权，而非闷头跑满 40 turn。

### 变更
- **/goal 反「改靶子」审查**：evaluator 新增 ANTI-CHEAT 规则——若 agent 通过注释/删除/skip
  测试、放宽断言、关掉 lint/type 规则、mock 掉被测逻辑或弱化验证命令来「过关」，一律判未
  达成并在理由里点名可疑改动；续跑指令同步明令「只修真问题，不得弱化验证」。堵住目标收敛
  型 agent 的 reward-hacking 系统性漏洞。
- **/goal set 时质量门**（非阻断）：设定非预设目标时先用小快模型判可验证性，模糊则提醒并
  给出含验证命令/期望输出的改写建议，但仍按用户原意继续。
- **goal_exhausted 事件**扩展 `cause`（turns/tokens/stall），UI 按原因显示不同停止文案。

## [0.9.10] - 2026-06-21

### 修复
- **换题即清场 Tasks 面板**：ESC / `/stop` 中断后保留 todo（用户仍能看），但用户一旦
  发起「下一个任务」就把上一个任务残留的 Tasks/todo 抹掉，不再赖在新任务里。实现：
  中断时置 `interruptedRef`，下一次 `runConversation` 起跑时清空所有命名空间的 todo
  （模型若仍需规划会在本轮重发 TodoWrite）。

### 变更
- **工具调用头的 marker ⏺ 恢复上色**：`⏺ WebSearch(…)` 的 `⏺` 与工具名一同按状态色
  上色（作状态锚点），仅括号内参数/计数留白。微调 v0.9.8 里「marker 全部留白」的尺度。

## [0.9.8] - 2026-06-21

### 变更
- **克制上色：颜色只点睛「一个词」，不再铺满整行/整句**。统一三处渲染规则——
  状态行（`■ Error.` / `■ cancelled` / `◌ /stop …`）只把「第一个提醒词」按状态色
  上色，marker 与补充文字留白；工具调用头（`⏺ Read(…)` / `Bash` / 折叠组 `Name ×N`）
  只给「工具名」上红/绿/黄，括号内路径与计数留白；verdict 结论行只给「首句或首词」
  （`完成` / `All done.` / `全部 … 已解决。`）上色，后续路径与补充文字留白。
- **错误回执去冒号**：`■ Error: …` 改为 `■ Error. …`。
- 新增 `splitStatusLine`（`src/ui/theme.ts`）与 `splitVerdictHead`（`src/utils/markdown.ts`）
  两个纯函数承载上述拆分逻辑。

## [0.9.6] - 2026-06-21

### 新增
- **拖文件进 REPL 自动还原绝对路径**（macOS / Linux / Windows）：把文件从访达 /
  资源管理器拖进输入框时，终端会把路径当作一段「粘贴」塞进来。新增
  `src/utils/dragPath.ts` 识别这类粘贴并还原成干净的绝对路径后插入（末尾补空格）：
  去掉 Windows 拖入的双引号包裹、还原 macOS/Linux 的 shell 反斜杠转义（`My\ Photos`
  → `My Photos`）、去掉终端补的首尾空格；用「文件确实存在」(`existsSync`) 作为强信号，
  避免把普通文本误判成路径。含空格的路径自动包单引号；支持一次拖入多个文件（空格连接）。
  接入点在 `App.tsx` 的 `ingestPaste`，识别失败则原样回退到普通粘贴逻辑。思路对齐
  Claude Code 的 `imagePaste`（`removeOuterQuotes` + `stripBackslashEscapes`），泛化到任意文件。

## [0.9.4] - 2026-06-21

### 新增
- **`/rewind` 会话回滚**：对话历史与文件双轨回退。`/rewind` 开方向键选择器（琥珀色，
  区别于 `/resume` 的靛蓝）、`/rewind N` 直接回到第 N 回合之前。回滚窗口内取最早的
  改动前态还原 Write/Edit 改过的文件（当时新建的文件会被删除）。检查点单例做对话长度
  记录 + 文件 copy-on-write 快照；transcript 新增 `rewind` 行类型，`loadSessionMessages`
  改为折叠式重放，正确处理 `compact` 与 `rewind` 标记的任意交错。
  - v1 边界：仅捕获 Write/Edit；Bash 的 `rm`/`mv`/重定向不在范围（需 P3 shadow-git）。
- **Kimi（Moonshot AI）provider**：OpenAI 兼容接入，`PROVIDER=kimi`（或 `moonshot`）启用，
  `/login` 可选。默认 `kimi-k2-0905-preview`、`https://api.moonshot.cn/v1`（海外用
  `KIMI_BASE_URL` 切 `api.moonshot.ai/v1`）。usage 缓存拆分、价目、tracing、transcript 全打通。
- **`/reload-plugins` 热重载**：无需重启即可让新加的 skill / 插件生效——重扫 user/project/plugin
  三来源 skill 目录并清命令表缓存，下一条消息即生效。（插件 MCP server 连接仍需重启）

### 修复
- **skill 资源路径解析**：skill 多为全局安装（`~/.astraea/skills/<name>`），与 cwd 无关，
  Windows 上甚至跨盘符。此前注入 SKILL.md 正文时既不展开 `<SKILL_ROOT>` 占位符、也不告知
  skill 绝对目录，导致模型把 `references/x.md` 等相对资源错按 cwd 解析 → 文件找不到。现于
  `getPrompt()` 展开 `<SKILL_ROOT>` 为绝对路径并在顶部声明 skill 目录，要求相对资源按它解析。

## [0.9.0] - 2026-06-19

首个对外标定版本，纠正长期占位的 `0.1.0`（该值从未随功能更新）。v1.0 的 RC 高度：
设计 ~85% 已实现，但项目仍 private、内部接口仍在演进，故停留在 0.x。

### 已具备
- 40+ 内置工具：文件 / Shell / Web / Task / MCP / 子 agent 协调
- 完整 ReAct 查询循环（多轮流式 + /goal 自驱 Stop-hook）
- 多 Provider：Anthropic / OpenAI / DeepSeek / Ollama + 自适应重试
- 四层上下文压缩：snipping / microcompact / eclipse 折叠 / autocompact
- 文件级持久记忆系统：抽取 / 召回 / 注入
- 5 模式 × 行为权限矩阵 + 红线 + AI 命令分类器
- Skills / Plugins(本地市场) / MCP(stdio·http·sse) 三套体系
- Phoenix 可观测性（span 生命周期 + 离线 eval）
- 196 个测试文件
