// confirmAnswer — 解读「是/否」授权面板的回答（ExitCounselMode / ExitOrbitMode 共用）。
//
// 为什么需要它：两个模式闸原来都用 `picked.startsWith('yes')` 判断放行。用户从选项里选中
// 第一项时没问题，但真实使用里还有两条路——
//   · ESC 关掉面板 → bridge 按空答案 resolve；
//   · ✎ 自填输入「可以 / 开始吧 / 同意 / ok / go」。
// 这些一律落进 else 分支被判成「拒绝」，工具于是回一句 "keep consulting the user with
// AskUserQuestion"，模型接着开下一轮提问 —— 用户明明已经点头，体感却是「一直问、不动手」。
//
// 这里把回答分成四类，让调用方能分别处理：
//   approved  —— 选中了放行项，或自填了肯定词
//   declined  —— 选中了拒绝项，或自填了否定词
//   cancelled —— 空答案（ESC / 面板被 /stop 排空）：用户没表态，不等于拒绝，更不该触发追问
//   unclear   —— 自填了别的内容（多半是补充指令，如「先只做第一步」）：把原文交回给模型，
//                让它直接回应，而不是再开一轮问卷
//
// 判定顺序上否定优先：中文「不可以」含「可以」，先查否定才不会被误读成同意。

export type ConfirmVerdict = 'approved' | 'declined' | 'cancelled' | 'unclear'

export interface ConfirmAnswer {
  verdict: ConfirmVerdict
  /** 「→」之后的实际选项/自填文本，原样保留（unclear 时要回显给模型） */
  picked: string
}

// 拉丁词要求词边界，避免 "y" 命中 "yellow"、"no" 命中 "nothing"。
const LATIN_YES = /^(y|yes|yeah|yep|ya|ok|okay|sure|go|go ahead|start|begin|proceed|do it|approve[d]?|allow|accept|confirm)\b/
const LATIN_NO = /^(n|no|nope|not|stop|wait|cancel|hold|abort|reject|decline|don't|dont|later)\b/
// 中文没有词边界，用前缀匹配；否定串放在前面先查。
const CJK_NO = /^(不|别|先别|甭|等|再想|再等|取消|拒绝|否|暂停|先不|先别急|算了)/
const CJK_YES = /^(可以|好|行|是|对|同意|批准|允许|通过|确认|开始|执行|动手|上吧|干吧|没问题|继续|走起|来吧|批了)/

/** 去掉首尾空白与常见收尾标点，让「可以。」「ok!」也能命中。 */
function normalize(s: string): string {
  return s.trim().replace(/[\s。！!、，,．.…~～]+$/u, '').toLowerCase()
}

/**
 * @param raw    bridge 返回的原始答案。formatAnswers 的格式是 "[Header] question\n→ 选项"，
 *               所以只取最后一个「→」之后的部分；没有箭头时按整串处理。
 * @param labels 面板上两个选项的 label，用来做锚定匹配——比任何关键词表都准。
 */
export function interpretConfirmAnswer(
  raw: string,
  labels: { approve: string; decline: string },
): ConfirmAnswer {
  if (!raw.trim()) return { verdict: 'cancelled', picked: '' }

  const picked = (raw.split('→').pop() ?? raw).trim()
  const norm = normalize(picked)
  if (!norm) return { verdict: 'cancelled', picked: '' }

  // ① 锚定匹配：用户从选项列表里选的，一定与 label 全等。
  if (norm === normalize(labels.approve)) return { verdict: 'approved', picked }
  if (norm === normalize(labels.decline)) return { verdict: 'declined', picked }

  // ② 自填文本：否定优先（「不可以」不能被读成「可以」）。
  if (CJK_NO.test(norm) || LATIN_NO.test(norm)) return { verdict: 'declined', picked }
  if (CJK_YES.test(norm) || LATIN_YES.test(norm)) return { verdict: 'approved', picked }

  // ③ 既不像同意也不像拒绝 —— 多半是补充指令，交给模型直接回应。
  return { verdict: 'unclear', picked }
}
