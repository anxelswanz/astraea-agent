// ExitCounselModeTool — 退出 counsel（只读咨询）模式，请求用户授权后切入 cruise 执行
// 执行流程：
//   1. 校验当前确为 counsel 模式
//   2. 通过 AskUserQuestion bridge 把「已确认的方案摘要」展示给用户并请求授权
//   3. 用户批准（allow this session）→ setMode('cruise')，文件写自动通过、shell 仍确认
//   4. 用户拒绝 → 保持 counsel 只读，模型继续咨询
//
// 设计取向：counsel 与 orbit 一样在框架层硬拦截一切写/执行工具（query.ts）。counsel 唯一
// 的逃生口就是本工具——模型「意识到该动手了」时显式请求切模式，由用户授权后才放开执行权。
import { buildTool } from '../Tool.js'
import type { ToolCallResult, ToolContext } from '../Tool.js'
import { setMode, getMode } from '../../state/sessionMode.js'
import { ask } from '../AskUserQuestionTool/bridge.js'
import { interpretConfirmAnswer } from '../confirmAnswer.js'

export const ExitCounselModeTool = buildTool({
  name: 'ExitCounselMode',
  description: `Exit counsel mode by asking the user for permission to start executing.

Counsel mode is strictly READ-ONLY (like orbit): every write/execute tool (Edit, Write,
Bash, etc.) is blocked at the framework layer. Reading, searching and AskUserQuestion are
allowed. This is the ONLY way to gain execution permission.

Call this tool ONLY after you have interviewed the user (AskUserQuestion) and the direction
is unambiguous. It will:
1. Show the user a short summary of the agreed approach
2. Ask the user to allow execution for this session
3. If allowed: Astraea switches to CRUISE mode (file writes auto-approved, shell still
   confirmed) and you may begin implementation
4. If declined: you stay in counsel mode (read-only). Ask at most ONE more focused
   question about what changed, then call this again — do not restart the interview.

The summary parameter must be a brief markdown recap of what you will do if allowed —
2–4 bullets covering scope, the concrete steps, and how you will verify.`,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  inputSchema: {
    type: 'object',
    properties: {
      summary: {
        type: 'string',
        description: 'A brief markdown recap (2–4 bullets) of the agreed approach you will execute',
      },
    },
    required: ['summary'],
  },

  async call(input, _ctx: ToolContext): Promise<ToolCallResult> {
    if (getMode() !== 'counsel') {
      return {
        output: 'ExitCounselMode can only be called when in counsel mode.',
        isError: true,
      }
    }

    const summary = input['summary'] as string
    if (!summary?.trim()) {
      return { output: 'summary is required and must not be empty.', isError: true }
    }

    // 向用户展示方案摘要 + 授权请求。summary 通过 planBody 落成持久化 markdown 历史条目，
    // 即便面板被 ESC 关掉也不丢；面板本身只留精简的是/否提示。
    const labels = {
      approve: 'yes — allow this session & switch to cruise',
      decline: 'no — keep consulting',
    }
    const answer = await ask([{
      header: 'Execute',
      question: 'Approach confirmed. Allow Astraea to start executing in this session? This switches to cruise mode (file writes auto-approved, shell commands still confirmed).',
      options: [{ label: labels.approve }, { label: labels.decline }],
      planBody: summary,
    }])

    // 四态判定（见 confirmAnswer.ts）。旧实现只认 startsWith('yes')，用户 ESC 或自填
    // 「可以 / 开始吧 / ok」全被读成拒绝，工具再回一句「继续提问」——这正是「一直问、
    // 不动手」的放大器。现在只有明确拒绝才回到咨询循环。
    const { verdict, picked } = interpretConfirmAnswer(answer, labels)

    if (verdict === 'approved') {
      setMode('cruise')
      return {
        output: [
          'Execution allowed. Counsel mode exited — switched to CRUISE mode.',
          'File writes are now auto-approved; shell commands are still confirmed per command.',
          '',
          'The Counsel Mode section still present in your system prompt is now STALE — you are no',
          'longer read-only. Do NOT open another AskUserQuestion and do NOT call ExitCounselMode',
          'again. Start implementing as agreed, using tools.',
        ].join('\n'),
      }
    }

    // 用户没表态（ESC / 面板被排空）：这不等于拒绝，更不该触发新一轮问卷。
    if (verdict === 'cancelled') {
      return {
        output: [
          'The approval panel was dismissed without an answer — the user did not respond.',
          'Still in counsel mode (read-only). Do NOT open another AskUserQuestion and do NOT',
          'call ExitCounselMode again on your own. State in one sentence that you are waiting',
          'for a go-ahead, then stop and hand control back to the user.',
        ].join('\n'),
        isError: false,
      }
    }

    // 用户自填了别的内容（多半是补充约束，如「先只做第一步」）：直接回应它，别再开问卷。
    if (verdict === 'unclear') {
      return {
        output: [
          'The user replied with their own text instead of yes/no:',
          '',
          picked,
          '',
          'Still in counsel mode (read-only). Address what they actually said — do NOT open',
          'another AskUserQuestion. If their reply narrows the scope, fold it into the plan and',
          'call ExitCounselMode again with the revised summary; otherwise answer them and stop.',
        ].join('\n'),
        isError: false,
      }
    }

    return {
      output: [
        'Execution declined. Still in counsel mode (read-only).',
        'Ask at most ONE more focused question about what changed their mind, then call',
        'ExitCounselMode again with a revised summary. Do not restart the interview.',
      ].join('\n'),
      isError: false,
    }
  },
})
