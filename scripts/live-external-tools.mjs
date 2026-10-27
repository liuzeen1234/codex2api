// Manual integration check. Run against a running codex2api; no credentials logged.
import assert from 'node:assert/strict';
import { readSSE } from '../src/external-tools.js';
const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:3011';
const headers = { 'Content-Type': 'application/json', ...(process.env.API_KEY ? { Authorization: `Bearer ${process.env.API_KEY}` } : {}) };
const tools = [{ type: 'function', function: { name: 'client_add', description: 'Add two integers on the client.', parameters: { type: 'object', properties: { a: { type: 'integer' }, b: { type: 'integer' } }, required: ['a', 'b'], additionalProperties: false } } }];
const messages = [{ role: 'user', content: 'Call client_add with a=17 and b=25. After its result call client_add again with a set to the first result and b=8. After both results give the final number.' }];
for (let turn = 0; turn < 3; turn++) {
  const stream = turn === 1;
  const body = { model: 'gpt-6.1-sol', messages, tools, tool_choice: turn < 2 ? 'required' : 'none', parallel_tool_calls: false, stream, reasoning_effort: 'low' };
  const r = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body) });
  assert.equal(r.status, 200);
  let m, finish;
  if (stream) {
    m = { role: 'assistant', content: '', tool_calls: [] };
    for await (const e of readSSE(r.body)) {
      assert.ok(!e.error, JSON.stringify(e.error));
      const c = e.choices?.[0]; if (!c) continue;
      if (c.finish_reason) finish = c.finish_reason;
      if (c.delta.content) m.content += c.delta.content;
      for (const d of c.delta.tool_calls || []) {
        const call = m.tool_calls[d.index] ||= { id: d.id, type: d.type, function: { name: '', arguments: '' } };
        call.function.name += d.function?.name || '';
        call.function.arguments += d.function?.arguments || '';
      }
    }
  } else { const b = await r.json(); m = b.choices[0].message; finish = b.choices[0].finish_reason; }
  messages.push(m);
  if (turn < 2) {
    assert.equal(finish, 'tool_calls'); assert.equal(m.tool_calls.length, 1);
    const c = m.tool_calls[0]; assert.equal(c.function.name, 'client_add');
    const args = JSON.parse(c.function.arguments); const sum = args.a + args.b;
    assert.equal(sum, turn === 0 ? 42 : 50);
    console.log(JSON.stringify({ turn, stream, executedBy: 'client', tool: c.function.name, args, result: sum }));
    messages.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify({ sum }) });
  } else { assert.equal(finish, 'stop'); assert.match(m.content, /50/); console.log(JSON.stringify({ final: m.content })); }
}
