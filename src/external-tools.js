import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

export class RequestError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export function usesExternalTools(body) {
  return body.tools !== undefined || body.tool_choice !== undefined || body.functions !== undefined || body.function_call !== undefined || (Array.isArray(body.messages) && body.messages.some(m => m?.role === 'tool' || m?.tool_calls));
}

// Stateless replay deliberately avoids app-server: no local executor, pending turn,
// shared conversation cache, or built-in tool can participate in this path.
export function toResponses(body) {
  const { messages, tools = [], tool_choice = 'auto' } = body;
  if (!Array.isArray(messages) || !messages.length) throw new RequestError('messages must be a nonempty array');
  if (!Array.isArray(tools)) throw new RequestError('tools must be an array');
  if (body.functions || body.function_call) throw new RequestError('Legacy functions/function_call are unsupported');
  if (body.n !== undefined && body.n !== 1) throw new RequestError('Only n=1 is supported');
  const names = new Set();
  const declarations = tools.map(t => {
    const f = t?.function;
    if (t?.type !== 'function' || !f || !/^[a-zA-Z0-9_-]{1,64}$/.test(f.name) || names.has(f.name)) throw new RequestError('tools must contain uniquely named function tools');
    names.add(f.name);
    let parameters = f.parameters ?? { type: 'object', properties: {} };
    // JSON Schema objects need not declare a top-level `type`: schemas may
    // use properties, $ref, or composition. Preserve those schemas verbatim.
    if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) throw new RequestError(`Tool ${f.name}: parameters must be a JSON Schema object`);
    parameters = normalizeToolSchema(parameters);
    if (f.strict !== undefined && typeof f.strict !== 'boolean') throw new RequestError('strict must be boolean');
    return { type: 'function', name: f.name, description: f.description || '', parameters, strict: f.strict ?? false };
  });
  let choice = tool_choice;
  if (typeof choice === 'object' && choice?.type === 'function' && names.has(choice.function?.name)) choice = { type: 'function', name: choice.function.name };
  else if (!['auto', 'none', 'required'].includes(choice)) throw new RequestError('Unsupported tool_choice; use auto, none, required, or a declared function');
  if (!tools.length && choice !== 'auto' && choice !== 'none') throw new RequestError('tool_choice requires tools');
  if (body.parallel_tool_calls !== undefined && typeof body.parallel_tool_calls !== 'boolean') throw new RequestError('parallel_tool_calls must be boolean');
  const input = [], pending = new Set(), seen = new Set();
  for (const m of messages) {
    if (!m || !['system', 'developer', 'user', 'assistant', 'tool'].includes(m.role)) throw new RequestError('Unsupported message role');
    if (m.role === 'tool') {
      if (!pending.delete(m.tool_call_id)) throw new RequestError('Unknown or duplicate tool_call_id');
      input.push({ type: 'function_call_output', call_id: m.tool_call_id, output: toolContent(m.content) });
      continue;
    }
    if (pending.size) throw new RequestError('All tool calls must have results before the next message');
    if (m.content !== null && m.content !== undefined) {
      const content = typeof m.content === 'string' ? m.content : mapContent(m.content, m.role);
      if (typeof content !== 'string' || content) input.push({ role: m.role === 'system' ? 'developer' : m.role, content });
    }
    if (m.tool_calls) {
      if (m.role !== 'assistant' || !Array.isArray(m.tool_calls) || !m.tool_calls.length) throw new RequestError('tool_calls require an assistant message');
      for (const c of m.tool_calls) {
        if (c.type !== 'function' || !c.id || seen.has(c.id) || typeof c.function?.name !== 'string' || typeof c.function?.arguments !== 'string') throw new RequestError('Invalid or duplicate tool call');
        try { JSON.parse(c.function.arguments); } catch { throw new RequestError('Tool arguments must be JSON'); }
        seen.add(c.id); pending.add(c.id);
        input.push({ type: 'function_call', call_id: c.id, name: c.function.name, arguments: c.function.arguments });
      }
    }
  }
  if (pending.size) throw new RequestError('Missing tool results');
  const result = { model: body.model && body.model !== 'codex' ? body.model : config.codexModel || 'gpt-6.1-sol', instructions: '', input, tools: declarations, tool_choice: choice, parallel_tool_calls: body.parallel_tool_calls ?? true, store: false, stream: true };
  const effort = body.reasoning_effort || body.reasoning?.effort;
  if (effort) result.reasoning = { effort };
  if (body.response_format) {
    const f = body.response_format;
    if (f.type === 'json_schema') result.text = { format: { type: 'json_schema', ...f.json_schema } };
    else if (f.type === 'json_object' || f.type === 'text') result.text = { format: { type: f.type } };
    else throw new RequestError('Unsupported response_format');
  }
  return result;
}

// Older DSH plugins sometimes register their authoring property map directly
// instead of calling defineTool(). Only recognize unambiguous property maps;
// standard JSON Schema keywords (including $ref/composition) remain untouched.
const schemaKeywords = new Set(['$schema', '$id', '$ref', '$defs', 'definitions', '$anchor', '$dynamicRef', '$dynamicAnchor', '$vocabulary', '$comment', 'type', 'properties', 'required', 'additionalProperties', 'patternProperties', 'propertyNames', 'dependentRequired', 'dependentSchemas', 'unevaluatedProperties', 'minProperties', 'maxProperties', 'allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else', 'enum', 'const', 'items', 'prefixItems', 'contains', 'unevaluatedItems', 'minItems', 'maxItems', 'uniqueItems', 'minContains', 'maxContains', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'pattern', 'format', 'title', 'description', 'default', 'examples', 'deprecated', 'readOnly', 'writeOnly', 'contentEncoding', 'contentMediaType', 'contentSchema']);
function normalizeToolSchema(schema) {
  const entries = Object.entries(schema);
  if (!entries.length || entries.some(([key]) => schemaKeywords.has(key))) return schema;
  if (!entries.every(([, value]) => value && typeof value === 'object' && !Array.isArray(value) && (typeof value.type === 'string' || Array.isArray(value.oneOf)))) return schema;
  const convertMap = map => {
    const properties = {}, required = [];
    for (const [key, value] of Object.entries(map)) {
      if (value.required === true) required.push(key);
      Object.defineProperty(properties, key, { value: convertNode(value), enumerable: true, writable: true, configurable: true });
    }
    return { type: 'object', properties, ...(required.length ? { required } : {}) };
  };
  const convertNode = node => {
    const result = { ...node };
    if (typeof result.required === 'boolean') delete result.required;
    if (result.type === 'json') delete result.type;
    if (node.type === 'object' && node.properties) Object.assign(result, convertMap(node.properties));
    if (node.items && typeof node.items === 'object') result.items = convertNode(node.items);
    if (Array.isArray(node.oneOf)) result.oneOf = node.oneOf.map(convertNode);
    return result;
  };
  return convertMap(schema);
}

function mapContent(content, role) {
  if (!Array.isArray(content)) throw new RequestError('Invalid message content');
  return content.map(p => {
    if (p.type === 'text' && typeof p.text === 'string') return { type: role === 'assistant' ? 'output_text' : 'input_text', text: p.text };
    if (p.type === 'image_url' && role === 'user') {
      const url = p.image_url?.url;
      if (!/^data:image\/(png|jpeg|webp|gif);base64,/.test(url || '')) throw new RequestError('Only inline data image URLs are supported');
      return { type: 'input_image', image_url: url, detail: p.image_url.detail || 'auto' };
    }
    throw new RequestError('Unsupported message content part');
  });
}
function toolContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content) && content.every(p => p.type === 'text' && typeof p.text === 'string')) return content.map(p => p.text).join('\n');
  throw new RequestError('Tool results must be text (including JSON/error text)');
}

async function credentials() {
  // Credentials stay in memory and are never included in errors or log records.
  let auth;
  try { auth = JSON.parse(await fs.readFile(path.join(config.codexHome, 'auth.json'), 'utf8')); }
  catch { throw new RequestError('Codex credentials unavailable; sign in with Codex', 503); }
  if (auth.auth_mode !== 'chatgpt' || !auth.tokens?.access_token) throw new RequestError('External tools currently require Codex ChatGPT login', 503);
  return { Authorization: `Bearer ${auth.tokens.access_token}`, ...(auth.tokens.account_id ? { 'ChatGPT-Account-Id': auth.tokens.account_id } : {}) };
}

export async function* readSSE(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let match;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const block = buffer.slice(0, match.index); buffer = buffer.slice(match.index + match[0].length);
        const data = block.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
        if (data && data !== '[DONE]') yield JSON.parse(data);
      }
      if (buffer.length > 8 * 1024 * 1024) throw new Error('Upstream SSE event too large');
      if (done) break;
    }
    if (buffer.trim()) throw new Error('Truncated upstream SSE event');
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export async function runExternalChat({ payload, signal, onDelta, onToolDelta }, deps = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, deps.timeoutMs ?? config.timeoutMs);
  let response;
  try {
    const headers = await (deps.credentials || credentials)();
    response = await (deps.fetch || fetch)('https://chatgpt.com/backend-api/codex/responses', {
      method: 'POST', redirect: 'error', headers: { ...headers, 'Content-Type': 'application/json', Accept: 'text/event-stream', originator: 'codex2api' }, body: JSON.stringify(payload), signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new RequestError(`Codex Responses upstream returned HTTP ${response.status}${response.status === 401 ? '; refresh login using Codex' : ''}`, 502);
    }
    let text = '', completed = false, usage = null;
    const calls = [], byOutput = new Map();
    const reconcileArguments = (index, args) => {
      if (index === undefined || typeof args !== 'string') throw new RequestError('Invalid completed upstream tool call', 502);
      const previous = calls[index].function.arguments;
      if (!args.startsWith(previous)) throw new RequestError('Inconsistent upstream tool arguments', 502);
      const suffix = args.slice(previous.length);
      if (suffix) {
        calls[index].function.arguments = args;
        onToolDelta?.({ index, function: { arguments: suffix } });
      }
    };
    for await (const e of readSSE(response.body)) {
      if (e.type === 'response.output_text.delta') { text += e.delta; onDelta?.(e.delta); }
      if (e.type === 'response.output_item.added' && e.item?.type === 'function_call') {
        if (!payload.tools.some(t => t.name === e.item.name) || payload.tool_choice === 'none' || (typeof payload.tool_choice === 'object' && payload.tool_choice.name !== e.item.name)) throw new RequestError('Upstream requested a tool outside tool_choice', 502);
        const call = { id: e.item.call_id, type: 'function', function: { name: e.item.name, arguments: e.item.arguments || '' } };
        const index = calls.length; calls.push(call); byOutput.set(e.output_index, index);
        onToolDelta?.({ index, ...call });
      }
      if (e.type === 'response.function_call_arguments.delta') {
        const index = byOutput.get(e.output_index);
        if (index === undefined) throw new Error('Arguments for unknown tool call');
        calls[index].function.arguments += e.delta;
        onToolDelta?.({ index, function: { arguments: e.delta } });
      }
      // Some Codex responses coalesce parallel arguments into done events.
      if (e.type === 'response.function_call_arguments.done') reconcileArguments(byOutput.get(e.output_index), e.arguments);
      if (e.type === 'response.output_item.done' && e.item?.type === 'function_call') reconcileArguments(byOutput.get(e.output_index), e.item.arguments);
      if (e.type === 'response.failed' || e.type === 'error') throw new RequestError('Codex Responses upstream failed', 502);
      if (e.type === 'response.incomplete') throw new RequestError('Codex Responses upstream incomplete', 502);
      if (e.type === 'response.completed') {
        if (e.response?.status && e.response.status !== 'completed') throw new RequestError('Codex Responses upstream did not complete', 502);
        for (const item of e.response?.output || []) {
          if (item.type === 'function_call') {
            const index = calls.findIndex(c => c.id === item.call_id);
            reconcileArguments(index < 0 ? undefined : index, item.arguments);
          }
        }
        const u = e.response?.usage;
        if (u) usage = { prompt_tokens: u.input_tokens || 0, completion_tokens: u.output_tokens || 0, total_tokens: u.total_tokens || 0, prompt_tokens_details: { cached_tokens: u.input_tokens_details?.cached_tokens || 0 }, completion_tokens_details: { reasoning_tokens: u.output_tokens_details?.reasoning_tokens || 0 } };
        completed = true;
      }
    }
    if (!completed) throw new RequestError('Codex Responses stream ended before completion', 502);
    if (payload.tool_choice === 'required' || typeof payload.tool_choice === 'object') if (!calls.length) throw new RequestError('Upstream did not honor required tool_choice', 502);
    if (!payload.parallel_tool_calls && calls.length > 1) throw new RequestError('Upstream violated parallel_tool_calls=false', 502);
    for (const c of calls) {
      if (!c.id || calls.filter(x => x.id === c.id).length !== 1) throw new RequestError('Invalid upstream tool call ID', 502);
      try { JSON.parse(c.function.arguments); } catch { throw new RequestError('Invalid upstream tool arguments JSON', 502); }
    }
    return { text, toolCalls: calls, usage };
  } catch (e) {
    if (controller.signal.aborted) throw new RequestError(signal?.aborted ? 'Request cancelled' : 'External tool request timed out', signal?.aborted ? 499 : 504);
    // Do not forward raw transport errors: custom fetches may include headers.
    if (e instanceof RequestError) throw e;
    throw new RequestError('External tool upstream protocol or transport failure', 502);
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', abort);
    controller.abort();
  }
}
