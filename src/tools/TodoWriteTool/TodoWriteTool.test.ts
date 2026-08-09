import { afterEach, expect, test } from 'bun:test'
import { TodoWriteTool } from './index'
import { clearTodos, getTodos } from '../../services/todo-state'
import { clearToolEvidence, recordToolEvidence } from '../../services/evidence-registry'
import type { ToolContext } from '../Tool'

const NS = 'todo-gate-test'
const ctx: ToolContext = { mode: 'default', agentId: NS, isInteractive: false }

const baseTodo = {
  id: '1',
  content: 'Implement login provider reuse',
  status: 'in_progress',
  acceptanceCriteria: ['Login shows reuse API key option when provider key exists'],
  verificationCommand: 'bun test src/ui/LoginWizard.test.tsx',
}

afterEach(() => {
  clearTodos(NS)
  clearToolEvidence(NS)
})

test('rejects todos without acceptance criteria and verification command', async () => {
  const result = await TodoWriteTool.call({
    todos: [{
      id: '1',
      content: 'Implement login provider reuse',
      status: 'in_progress',
    }],
  }, ctx)

  expect(result.isError).toBe(true)
  expect(result.output).toContain('acceptanceCriteria')
  expect(result.output).toContain('verificationCommand')
  expect(getTodos(NS)).toEqual([])
})

test('rejects creating a todo directly as completed', async () => {
  recordToolEvidence(NS, {
    id: 'tool-1',
    tool: 'Bash',
    output: 'bun test passed, exit 0',
    isError: false,
  })

  const result = await TodoWriteTool.call({
    todos: [{
      ...baseTodo,
      status: 'completed',
      evidenceRefs: ['tool-1'],
    }],
  }, ctx)

  expect(result.isError).toBe(true)
  expect(result.output).toContain('in_progress')
  expect(getTodos(NS)).toEqual([])
})

test('rejects completed todos without evidence refs', async () => {
  await TodoWriteTool.call({ todos: [baseTodo] }, ctx)

  const result = await TodoWriteTool.call({
    todos: [{
      ...baseTodo,
      status: 'completed',
    }],
  }, ctx)

  expect(result.isError).toBe(true)
  expect(result.output).toContain('evidenceRefs')
})

test('rejects completed todos that reference unknown evidence', async () => {
  await TodoWriteTool.call({ todos: [baseTodo] }, ctx)

  const result = await TodoWriteTool.call({
    todos: [{
      ...baseTodo,
      status: 'completed',
      evidenceRefs: ['fake-tool-id'],
    }],
  }, ctx)

  expect(result.isError).toBe(true)
  expect(result.output).toContain('Unknown evidenceRefs')
})

test('accepts completed todos only when they cite successful tool evidence', async () => {
  await TodoWriteTool.call({ todos: [baseTodo] }, ctx)
  recordToolEvidence(NS, {
    id: 'tool-1',
    tool: 'Bash',
    output: 'bun test passed, exit 0',
    isError: false,
  })

  const result = await TodoWriteTool.call({
    todos: [{
      ...baseTodo,
      status: 'completed',
      evidenceRefs: ['tool-1'],
    }],
  }, ctx)

  expect(result.isError).toBeUndefined()
  const [stored] = getTodos(NS)
  expect(stored?.acceptanceCriteria).toEqual(baseTodo.acceptanceCriteria)
  expect(stored?.verificationCommand).toBe(baseTodo.verificationCommand)
  expect(stored?.evidenceRefs).toEqual(['tool-1'])
  expect(stored?.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
})

test('does not allow failed tool results to become completion evidence', async () => {
  await TodoWriteTool.call({ todos: [baseTodo] }, ctx)
  recordToolEvidence(NS, {
    id: 'tool-1',
    tool: 'Bash',
    output: 'bun test failed, exit 1',
    isError: true,
  })

  const result = await TodoWriteTool.call({
    todos: [{
      ...baseTodo,
      status: 'completed',
      evidenceRefs: ['tool-1'],
    }],
  }, ctx)

  expect(result.isError).toBe(true)
  expect(result.output).toContain('Unknown evidenceRefs')
})

// 证据门禁本身不放宽，但报错必须给出自救路径。否则模型想不起 tool_use id 就把 todo
// 永远卡在 in_progress，stop-hook 每轮拽它回来重做旧任务（v0.10.27 复读 bug 的第三环）。
test('evidence failure lists citable ids and legal ways out', async () => {
  recordToolEvidence(NS, { id: 'toolu_read_1', tool: 'Read', output: 'ok' })
  recordToolEvidence(NS, { id: 'toolu_bash_2', tool: 'Bash', output: 'ok' })
  await TodoWriteTool.call({ todos: [baseTodo] }, ctx)

  const result = await TodoWriteTool.call({
    todos: [{ ...baseTodo, status: 'completed' }],
  }, ctx)

  expect(result.isError).toBe(true)
  expect(result.output).toContain('completed tasks require evidenceRefs')
  expect(result.output).toContain('toolu_read_1')
  expect(result.output).toContain('toolu_bash_2')
  expect(result.output).toContain('(Read)')
  expect(result.output).toContain('todos: []')
})

test('evidence failure with no registered evidence says so instead of dangling', async () => {
  await TodoWriteTool.call({ todos: [baseTodo] }, ctx)

  const result = await TodoWriteTool.call({
    todos: [{ ...baseTodo, status: 'completed' }],
  }, ctx)

  expect(result.isError).toBe(true)
  expect(result.output).toContain('No successful tool results are registered yet')
})

test('clearing a superseded list is always allowed', async () => {
  await TodoWriteTool.call({ todos: [baseTodo] }, ctx)
  expect(getTodos(NS)).toHaveLength(1)

  const result = await TodoWriteTool.call({ todos: [] }, ctx)

  expect(result.isError).toBeUndefined()
  expect(getTodos(NS)).toEqual([])
})
