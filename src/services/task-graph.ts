import type {
  AcceptanceCriterion,
  AnyTask,
  TaskEvidence,
  TaskRecordState,
  TaskRecordStatus,
} from './agent-state'

type TaskMap = Record<string, AnyTask>

export function normalizeCriteria(descriptions: string[]): AcceptanceCriterion[] {
  return descriptions
    .map(description => description.trim())
    .filter(Boolean)
    .map((description, index) => ({ id: `criterion-${index + 1}`, description }))
}

export function validateDependencies(
  tasks: TaskMap,
  taskId: string,
  dependencies: string[],
): string | null {
  if (new Set(dependencies).size !== dependencies.length) return 'Dependencies must be unique.'
  if (dependencies.includes(taskId)) return 'A task cannot depend on itself.'

  for (const dependencyId of dependencies) {
    const dependency = tasks[dependencyId]
    if (!dependency || dependency.kind !== 'task') {
      return `Task dependency "${dependencyId}" was not found.`
    }
  }

  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true
    if (visited.has(id)) return false
    visiting.add(id)
    const task = tasks[id]
    const next = id === taskId
      ? dependencies
      : task?.kind === 'task' ? task.dependencies : []
    for (const dependencyId of next) {
      if (visit(dependencyId)) return true
    }
    visiting.delete(id)
    visited.add(id)
    return false
  }

  return visit(taskId) ? 'Task dependency cycle detected.' : null
}

export function incompleteDependencies(tasks: TaskMap, task: TaskRecordState): string[] {
  return task.dependencies.filter(id => {
    const dependency = tasks[id]
    return !dependency || dependency.kind !== 'task' || dependency.status !== 'completed'
  })
}

export function mergeEvidence(
  current: TaskEvidence[],
  incoming: TaskEvidence[],
): TaskEvidence[] {
  const byCriterion = new Map(current.map(item => [item.criterionId, item]))
  for (const item of incoming) byCriterion.set(item.criterionId, item)
  return [...byCriterion.values()]
}

export function missingEvidence(
  criteria: AcceptanceCriterion[],
  evidence: TaskEvidence[],
): string[] {
  const proven = new Set(evidence.map(item => item.criterionId))
  return criteria.filter(criterion => !proven.has(criterion.id)).map(criterion => criterion.id)
}

// ── TaskGraph 停止钩子────────────────────────────────────────────────────────
// 在模型准备结束时收集所有未解决节点：普通未完成节点继续推进，reconcile 标出的
// failed / invalidated 节点则分别复盘或重验证。返回 null 表示任务图已全部完成。
export function buildReplanDirective(records: TaskRecordState[]): string | null {
  const unfinished = records.filter(t =>
    t.status === 'pending' || t.status === 'blocked' || t.status === 'in_progress',
  )
  const failed = records.filter(t => t.status === 'failed')
  const invalidated = records.filter(t => t.status === 'invalidated')
  if (unfinished.length === 0 && failed.length === 0 && invalidated.length === 0) return null

  const map: TaskMap = {}
  for (const t of records) map[t.id] = t

  const lines: string[] = []
  lines.push('<system-reminder>')
  lines.push(
    'You are ending your turn, but your task graph still has unresolved nodes. ' +
      'Resolve each one before stopping; never silently abandon unfinished or broken work.',
  )

  if (unfinished.length > 0) {
    lines.push('')
    lines.push(`UNFINISHED (${unfinished.length}) — continue the work or report the exact external blocker:`)
    for (const t of unfinished) {
      lines.push(`  - [${t.id}] [${t.status}] ${t.subject}`)
    }
  }

  if (failed.length > 0) {
    lines.push('')
    lines.push(`FAILED (${failed.length}) — diagnose, then retry, change approach, or decompose into smaller subtasks:`)
    for (const t of failed) {
      const note = t.notes.length > 0 ? ` — last note: ${t.notes[t.notes.length - 1]}` : ''
      lines.push(`  - [${t.id}] ${t.subject}${note}`)
    }
  }

  if (invalidated.length > 0) {
    lines.push('')
    lines.push(
      `INVALIDATED (${invalidated.length}) — a dependency changed after this task was completed, so its ` +
        'evidence is stale. Re-run the verification (or redo the work) and re-submit evidence via TaskUpdate:',
    )
    for (const t of invalidated) {
      const stale = incompleteDependencies(map, t)
      const because = stale.length > 0 ? ` — upstream changed: ${stale.join(', ')}` : ''
      lines.push(`  - [${t.id}] ${t.subject}${because}`)
    }
  }

  lines.push('')
  lines.push('If a node truly cannot be resolved, tell the user explicitly what is blocked and why.')
  lines.push('')
  // 陈旧任务守卫：stop-hook 看不到「用户已经换了话题」，缺这句会把上一段对话的残留节点
  // 当成当前指令，抢在用户的新请求前面重做旧任务。
  lines.push(
    'IMPORTANT — check relevance first: if the user has since moved on to a different request, ' +
      'these nodes are stale. Do NOT resume or restart them, and do not let them displace what the ' +
      "user just asked for. Finish the user's current request, then say in one line which nodes " +
      'remain open (or close them out with TaskUpdate) instead of acting on them.',
  )
  lines.push('</system-reminder>')
  return lines.join('\n')
}

export function reconcileTaskGraph(tasks: TaskMap): TaskMap {
  let next = { ...tasks }
  let changed = true

  // INTENT: Reconcile to a fixed point so invalidation travels only through dependency edges.
  while (changed) {
    changed = false
    for (const [id, item] of Object.entries(next)) {
      if (item.kind !== 'task' || item.status === 'failed' || item.status === 'invalidated') continue
      const incomplete = incompleteDependencies(next, item)
      let status: TaskRecordStatus = item.status

      if (incomplete.length > 0) {
        status = item.status === 'completed' ? 'invalidated' : 'blocked'
      } else if (item.status === 'blocked') {
        status = 'pending'
      }

      if (status !== item.status) {
        next = {
          ...next,
          [id]: { ...item, status, updatedAt: new Date() },
        }
        changed = true
      }
    }
  }

  return next
}
