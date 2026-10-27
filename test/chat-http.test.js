import test from 'node:test';
import assert from 'node:assert/strict';
import { app } from '../src/server.js';
import { config } from '../src/config.js';
import { runExternalChat, readSSE } from '../src/external-tools.js';

test('HTTP nonstream/stream tool roundtrip, validation and disconnected client', async () => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { 'Content-Type': 'application/json', ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}) };
  const tools = [{ type: 'function', function: { name: 'echo', parameters: { type: 'object', properties: {} } } }];
  const initial = { messages: [{ role: 'user', content: 'echo' }], tools };
  const saved = app.locals.runExternalChat;
  let cancelled;
  try {
    app.locals.runExternalChat = opts => runExternalChat(opts, { credentials: async () => ({}), fetch: async (_url, init) => {
      const payload = JSON.parse(init.body);
      const events = payload.input.some(i => i.type === 'function_call_output')
        ? [{ type: 'response.output_text.delta', delta: 'client executed' }]
        : [{ type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', call_id: 'c1', name: 'echo' } }, { type: 'response.function_call_arguments.delta', output_index: 1, delta: '{}' }];
      events.push({ type: 'response.completed', response: { status: 'completed' } });
      return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''));
    } });
    const post = body => fetch(`${base}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body) });
    const nonstream = await (await post(initial)).json();
    assert.equal(nonstream.choices[0].finish_reason, 'tool_calls');
    assert.equal(nonstream.choices[0].message.content, null);
    const stream = await post({ ...initial, stream: true, stream_options: { include_usage: true } });
    const events = []; for await (const e of readSSE(stream.body)) events.push(e);
    const deltas = events.flatMap(e => e.choices || []);
    assert.deepEqual(deltas.filter(c => c.delta.tool_calls).map(c => c.delta.tool_calls[0]), [
      { index: 0, id: 'c1', type: 'function', function: { name: 'echo', arguments: '' } },
      { index: 0, function: { arguments: '{}' } },
    ]);
    assert.equal(deltas.at(-1).finish_reason, 'tool_calls');
    const continued = await (await post({ tools, messages: [...initial.messages, nonstream.choices[0].message, { role: 'tool', tool_call_id: 'c1', content: 'done' }] })).json();
    assert.equal(continued.choices[0].message.content, 'client executed');
    const invalid = await post({ ...initial, stream: true, tool_choice: 'invalid' });
    assert.equal(invalid.status, 400);
    assert.match(invalid.headers.get('content-type'), /application\/json/);
    for (const stream of [false, true]) {
      let resolveCancel; cancelled = new Promise(r => { resolveCancel = r; });
      let resolveStart; const started = new Promise(r => { resolveStart = r; });
      app.locals.runExternalChat = ({ signal }) => new Promise((_resolve, reject) => {
        resolveStart(); signal.addEventListener('abort', () => { resolveCancel(); reject(new Error('test cancellation')); }, { once: true });
      });
      const controller = new AbortController();
      const pending = fetch(`${base}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ ...initial, stream }), signal: controller.signal }).catch(() => {});
      await started; controller.abort(); await pending;
      await Promise.race([cancelled, new Promise((_r, reject) => setTimeout(() => reject(new Error('client disconnect not propagated')), 1000).unref())]);
    }
  } finally { app.locals.runExternalChat = saved; server.closeAllConnections(); await new Promise(r => server.close(r)); }
});
