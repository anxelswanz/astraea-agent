// ExitOrbitModeTool — 提交规划、请求用户审批、恢复执行权限
// 执行流程：
//   1. 计划文本写入 ~/.astraea/plans/<slug>.md
//   2. 通过 AskUserQuestion bridge 向用户弹出审批
//   3. 用户批准 → restorePreMode()，返回完整计划文本给模型
//   4. 用户拒绝 → 保持 orbit 模式，返回拒绝消息
import { buildTool } from '../Tool.js'
import type { Tool, ToolCallResult, ToolContext } from '../Tool.js'
import { restorePreMode, getMode } from '../../state/sessionMode.js'
import { getPlanFilePath, getPlanSlug } from '../../utils/planSlug.js'
import { ask } from '../AskUserQuestionTool/bridge.js'
import { interpretConfirmAnswer } from '../confirmAnswer.js'
import { writeFileSync } from 'node:fs'

export const ExitOrbitModeTool = buildTool({
  name: 'ExitOrbitMode',
  description: `Exit orbit mode by presenting your complete plan for user approval.

Call this tool when you have finished exploring and are ready to present your plan.

The plan will be:
1. Written to ~/.astraea/plans/<slug>.md for audit trail
2. Presented to the user for approval (rendered as markdown)
3. If approved: file write permissions are restored and you can begin implementation
4. If rejected: you remain in orbit mode to revise the plan

The plan parameter must be a complete, structured implementation plan in markdown.
It MUST tell the user exactly what you will do, using these sections:
- Context — why this change is needed (1–3 sentences)
- Steps to execute — an explicit, ordered list of the concrete actions you will take
- Files to change — the files you will create or modify
- Verification — how the change will be checked (tests / manual run)

Be concrete: the user should be able to read "Steps to execute" and know precisely
what happens if they approve.`,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  inputSchema: {
    type: 'object',
    properties: {
      plan: {
        type: 'string',
        description: 'Your complete implementation plan in markdown format',
      },
    },
    required: ['plan'],
  },

  async call(input, _ctx: ToolContext): Promise<ToolCallResult> {
    if (getMode() !== 'orbit') {
      return {
        output: 'ExitOrbitMode can only be called when in orbit mode.',
        isError: true,
      }
    }

    const plan = input['plan'] as string
    if (!plan?.trim()) {
      return { output: 'plan is required and must not be empty.', isError: true }
    }

    // ── 1. 写计划文件 ─────────────────────────────────────────────────────
    const planPath = getPlanFilePath()
    const slug = getPlanSlug()
    try {
      writeFileSync(planPath, plan, 'utf-8')
    } catch (err) {
      return { output: `Failed to write plan file: ${err}`, isError: true }
    }

    // ── 2. 向用户展示完整计划 + 审批 ──────────────────────────────────────
    // 计划正文通过 planBody 传递：UI 会把它作为一条持久化的 markdown 历史条目落盘
    // （即使审批面板被 ESC 关掉也不会消失），审批面板本身只保留精简的是/否提示。
    const labels = { approve: 'yes — approve and execute', decline: 'no — revise the plan' }
    const answer = await ask([{
      header: 'Plan',
      question: `Plan ready (saved to ~/.astraea/plans/${slug}.md). Approve and begin implementation?`,
      options: [{ label: labels.approve }, { label: labels.decline }],
      planBody: plan,
    }])

    // 四态判定（见 confirmAnswer.ts）：只认 startsWith('yes') 会把 ESC 关面板和自填
    // 「可以 / 开始吧 / ok」全判成拒绝，模型于是回去反复改计划、迟迟不动手。
    const { verdict, picked } = interpretConfirmAnswer(answer, labels)
    const approved = verdict === 'approved'

    // ── 3. 审批结果处理 ───────────────────────────────────────────────────
    if (approved) {
      restorePreMode()
      return {
        output: [
          'Plan approved. Orbit mode deactivated — file writes restored.',
          '',
          `Plan file: ~/.astraea/plans/${slug}.md`,
          '',
          '--- APPROVED PLAN ---',
          plan,
          '--- END PLAN ---',
          '',
          'Proceed with implementation as planned.',
        ].join('\n'),
      }
    }

    // 用户没表态（ESC / 面板被排空）：不是拒绝，别自作主张重开一轮规划。
    if (verdict === 'cancelled') {
      return {
        output: [
          'The approval panel was dismissed without an answer — the user did not respond.',
          'Still in orbit mode. Do NOT revise the plan on your own and do NOT call ExitOrbitMode',
          'again unprompted. Say in one sentence that the plan is waiting for approval, then stop.',
        ].join('\n'),
        isError: false,
      }
    }

    // 自填了别的内容：多半是对计划的修改意见，按它改，而不是原样重问。
    if (verdict === 'unclear') {
      return {
        output: [
          'The user replied with their own text instead of yes/no:',
          '',
          picked,
          '',
          'Still in orbit mode. Treat this as feedback on the plan: revise accordingly and call',
          'ExitOrbitMode again with the updated plan.',
        ].join('\n'),
        isError: false,
      }
    }

    return {
      output: [
        'Plan rejected. Still in orbit mode.',
        '',
        'Revise your plan and call ExitOrbitMode again when ready.',
      ].join('\n'),
      isError: false,
    }
  },
})
