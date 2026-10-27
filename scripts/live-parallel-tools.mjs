// Manual parallel-call and out-of-order result replay check.
import assert from 'node:assert/strict';
import { readSSE } from '../src/external-tools.js';
const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:3010';
const headers = { 'Content-Type': 'application/json', ...(process.env.API_KEY ? { Authorization: `Bearer ${process.env.API_KEY}` } : {}) };
const messages = [{ role: 'user', content: 'In this single response call client_echo twice in parallel: once with value=1 and once with value=2. Both are independent. After both results say COMPLETE.' }];
const tools = [{ type: 'function', function: { name: 'client_echo', parameters: { type: 'object', properties: { value: { type: 'integer' } }, required: ['value'], additionalProperties: false } } }];
const post = body => fetch(`${base}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ model: 'gpt-6.1-sol', messages, tools, reasoning_effort: 'low', ...body }) });
const r = await post({ stream: true, tool_choice: 'required', parallel_tool_calls: true });
assert.equal(r.status, 200);
const calls = []; let finish;
for await (const e of readSSE(r.body)) {
  assert.ok(!e.error, JSON.stringify(e.error));
  for (const c of e.choices || []) {
    if (c.finish_reason) finish = c.finish_reason;
    for (const d of c.delta.tool_calls || []) {
      const call = calls[d.index] ||= { id: d.id, type: d.type, function: { name: '', arguments: '' } };
      call.function.name += d.function?.name || '';
      call.function.arguments += d.function?.arguments || '';
    }
  }
}
assert.equal(finish, 'tool_calls'); assert.equal(calls.length, 2);
assert.deepEqual(calls.map(c => JSON.parse(c.function.arguments).value).sort(), [1, 2]);
messages.push({ role: 'assistant', content: null, tool_calls: calls });
for (const c of [...calls].reverse()) messages.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify({ value: JSON.parse(c.function.arguments).value }) });
const end = await (await post({ tool_choice: 'none' })).json();
assert.equal(end.choices[0].finish_reason, 'stop');
console.log(JSON.stringify({ parallelCalls: calls.map(c => ({ name: c.function.name, args: c.function.arguments })), final: end.choices[0].message.content }));
