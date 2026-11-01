/** Phase 10.3 test fakes: tool definitions and a scripted llama.cpp tool step. */
import type { CallToolDefinition } from '@ashy/shared'
import type { FakeSocket } from './phase10-1-fakes'

export const TOOLS: CallToolDefinition[] = [
  {
    type: 'function',
    name: 'get_active_window_title',
    description: 'Returns the title of the window the user is currently using.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    type: 'function',
    name: 'read_workspace_file',
    description: 'Reads a text file from the user-authorized workspace.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
]

/** Scripted llama.cpp tool step: function_call items (as the 2026-11-01 spike saw them), then response.done. */
export function streamToolStep(
  socket: FakeSocket,
  script: { calls?: Array<{ name: string; args?: string; callId?: string }>; text?: string[] },
  id = `srv_tool_${Math.random().toString(36).slice(2, 8)}`,
): string {
  socket.deliver({ type: 'response.created', response: { id, status: 'in_progress' } })
  for (const t of script.text ?? []) socket.deliver({ type: 'response.output_text.delta', response_id: id, delta: t })
  ;(script.calls ?? []).forEach((c, i) => {
    const callId = c.callId ?? `call_${i + 1}`
    socket.deliver({
      type: 'response.output_item.added',
      response_id: id,
      item: { type: 'function_call', id: `item_${i}`, name: c.name, call_id: callId, arguments: '' },
    })
    socket.deliver({ type: 'response.function_call_arguments.done', response_id: id, call_id: callId, arguments: c.args ?? '{}' })
  })
  socket.deliver({ type: 'response.done', response: { id, status: 'completed' } })
  return id
}
