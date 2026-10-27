import test from 'node:test';
import assert from 'node:assert/strict';
import { toResponses, usesExternalTools, runExternalChat, readSSE } from '../src/external-tools.js';

const tool = { type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'], additionalProperties: false } } };
const request = () => ({ messages: [{ role: 'user', content: 'look up 1' }], tools: [tool] });
const event = e => `data: ${JSON.stringify(e)}\r\n\r\n`;
const completion = { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } } };
function response(events) { return new Response(events.map(event).join(''), { headers: { 'Content-Type': 'text/event-stream' } }); }
const creds = async () => ({});

test('accepts schemas without root type, references and composition without rewriting', () => {
  const schemas = [
    {},
    { properties: { recordIds: { type: 'array', items: { type: 'string' } } }, required: ['recordIds'] },
    { $ref: '#/$defs/Args', $defs: { Args: { type: 'object', properties: {} } } },
    { anyOf: [{ type: 'object', properties: { id: { type: 'string' } } }, { type: 'object', properties: { all: { const: true } } }] },
  ];
  for (const parameters of schemas) {
    const b = { ...request(), tools: [{ type: 'function', function: { name: 'delete_records', parameters } }] };
    assert.deepEqual(toResponses(b).tools[0].parameters, parameters);
  }
  for (const parameters of [[], 'object', 7, true]) {
    assert.throws(() => toResponses({ ...request(), tools: [{ type: 'function', function: { name: 'delete_records', parameters } }] }), /JSON Schema object/);
  }
});

test('declarations preserve JSON Schema, strict and tool choice with no builtins', () => {
  const b = request(); b.tools[0] = { ...tool, function: { ...tool.function, strict: true } };
  b.tool_choice = { type: 'function', function: { name: 'lookup' } };
  const p = toResponses(b);
  assert.deepEqual(p.tools, [{ type: 'function', name: 'lookup', description: '', parameters: tool.function.parameters, strict: true }]);
  assert.deepEqual(p.tool_choice, { type: 'function', name: 'lookup' });
  for (const choice of ['auto', 'none', 'required']) assert.equal(toResponses({ ...b, tool_choice: choice }).tool_choice, choice);
  assert.ok(usesExternalTools({ messages: [{ role: 'tool' }] }));
  assert.throws(() => toResponses({ ...b, tool_choice: 'surprise' }), /Unsupported/);
  assert.throws(() => toResponses({ ...b, tools: [tool, tool] }), /uniquely/);
});

test('converts the installed delete_records DSH authoring schema without executing it', () => {
  const parameters = {
    action: { type: 'string', required: true, description: 'sessions or folder' },
    sessionIds: { type: 'array', items: { type: 'string' } },
    folderPath: { type: 'string' },
  };
  const before = structuredClone(parameters);
  const p = toResponses({ ...request(), tools: [{ type: 'function', function: { name: 'delete_records', parameters } }], tool_choice: 'none' });
  assert.deepEqual(p.tools[0].parameters, {
    type: 'object', properties: {
      action: { type: 'string', description: 'sessions or folder' },
      sessionIds: { type: 'array', items: { type: 'string' } },
      folderPath: { type: 'string' },
    }, required: ['action'],
  });
  assert.deepEqual(parameters, before);
  assert.equal(p.tool_choice, 'none');
});

test('parallel tool history retains IDs, arguments, error results and ordering', () => {
  const calls = ['one', 'two'].map(id => ({ id, type: 'function', function: { name: 'lookup', arguments: '{"id":1}' } }));
  const b = request(); b.messages.push({ role: 'assistant', content: null, tool_calls: calls }, { role: 'tool', tool_call_id: 'two', content: '{"error":"missing"}' }, { role: 'tool', tool_call_id: 'one', content: 'ok' });
  const p = toResponses(b);
  assert.deepEqual(p.input.slice(1), [
    ...calls.map(c => ({ type: 'function_call', call_id: c.id, ...c.function })),
    { type: 'function_call_output', call_id: 'two', output: '{"error":"missing"}' },
    { type: 'function_call_output', call_id: 'one', output: 'ok' },
  ]);
  assert.throws(() => toResponses({ ...b, messages: b.messages.slice(0, -1) }), /Missing/);
  assert.throws(() => toResponses({ ...b, messages: [...b.messages, b.messages[2]] }), /Unknown/);
});

test('SSE parser handles split UTF8, CRLF, comments and multiline data', async () => {
  const bytes = new TextEncoder().encode(': ping\r\n\r\ndata: {"text":\r\ndata: "中文"}\r\n\r\ndata: [DONE]\r\n\r\n');
  const stream = new ReadableStream({ start(c) { for (const b of bytes) c.enqueue(Uint8Array.of(b)); c.close(); } });
  const got = []; for await (const e of readSSE(stream)) got.push(e);
  assert.deepEqual(got, [{ text: '中文' }]);
});

test('multiple interleaved calls produce indexed deltas and a nonstream result', async () => {
  const deltas = [];
  const events = [
    { type: 'response.output_item.added', output_index: 2, item: { type: 'function_call', call_id: 'a', name: 'lookup', arguments: '' } },
    { type: 'response.output_item.added', output_index: 4, item: { type: 'function_call', call_id: 'b', name: 'lookup', arguments: '' } },
    { type: 'response.function_call_arguments.delta', output_index: 4, delta: '{"id":2}' },
    { type: 'response.function_call_arguments.delta', output_index: 2, delta: '{"id":' },
    { type: 'response.function_call_arguments.delta', output_index: 2, delta: '1}' }, completion,
  ];
  const r = await runExternalChat({ payload: toResponses(request()), onToolDelta: d => deltas.push(structuredClone(d)) }, { credentials: creds, fetch: async (_url, opts) => {
    assert.equal(JSON.parse(opts.body).tools.length, 1); return response(events);
  } });
  assert.deepEqual(r.toolCalls.map(c => [c.id, c.function.arguments]), [['a', '{"id":1}'], ['b', '{"id":2}']]);
  assert.deepEqual(deltas.map(d => d.index), [0, 1, 1, 0, 0]);
  assert.equal(r.usage.total_tokens, 5);
});

test('concurrent requests do not share calls or input', async () => {
  const results = await Promise.all(['a', 'b'].map(id => runExternalChat({ payload: toResponses({ ...request(), messages: [{ role: 'user', content: id }] }) }, {
    credentials: creds, fetch: async (_url, opts) => {
      const own = JSON.parse(opts.body).input[0].content;
      await new Promise(r => setTimeout(r, own === 'a' ? 10 : 1));
      return response([{ type: 'response.output_text.delta', delta: own }, completion]);
    },
  })));
  assert.deepEqual(results.map(r => r.text), ['a', 'b']);
});

test('coalesced parallel arguments arrive in done events without duplicated deltas', async () => {
  const events = [
    ...['a', 'b'].map((id, i) => ({ type: 'response.output_item.added', output_index: i, item: { type: 'function_call', call_id: id, name: 'lookup', arguments: '' } })),
    { type: 'response.function_call_arguments.done', output_index: 0, arguments: '{"id":1}' },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', arguments: '{"id":1}' } },
    { type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', arguments: '{"id":2}' } }, completion,
  ];
  const deltas = [];
  const r = await runExternalChat({ payload: toResponses(request()), onToolDelta: d => deltas.push(structuredClone(d)) }, { credentials: creds, fetch: async () => response(events) });
  assert.deepEqual(r.toolCalls.map(c => c.function.arguments), ['{"id":1}', '{"id":2}']);
  assert.equal(deltas.filter(d => !d.id).length, 2);
});

test('cancel and timeout abort upstream and release pending operations', async () => {
  for (const cancel of [true, false]) {
    const controller = new AbortController(); let aborted = false;
    const p = runExternalChat({ payload: toResponses(request()), signal: controller.signal }, {
      credentials: creds, timeoutMs: cancel ? 1000 : 10,
      fetch: async (_url, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true });
      }),
    });
    if (cancel) setTimeout(() => controller.abort(), 5);
    await assert.rejects(p, e => e.status === (cancel ? 499 : 504));
    assert.ok(aborted);
  }
});

test('disconnect midstream cancels reader; upstream errors never leak response bodies', async () => {
  let cancelled = false;
  const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(event({ type: 'error', secret: 'TOKEN' }))); }, cancel() { cancelled = true; } });
  await assert.rejects(runExternalChat({ payload: toResponses(request()) }, { credentials: creds, fetch: async () => new Response(stream) }), e => !e.message.includes('TOKEN') && e.status === 502);
  assert.ok(cancelled);
  await assert.rejects(runExternalChat({ payload: toResponses(request()) }, { credentials: creds, fetch: async () => response([]) }), /before completion/);
});
