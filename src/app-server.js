import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import readline from 'node:readline';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

export class CodexAppServer extends EventEmitter {
  constructor() {
    super();
    this.child = null;
    this.ready = null;
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = '';
  }

  async start() {
    if (this.ready) return this.ready;
    this.ready = this.#spawnAndInitialize().catch((error) => {
      this.ready = null;
      throw error;
    });
    return this.ready;
  }

  async #spawnAndInitialize() {
    const env = { ...process.env };
    if (!env.HOME && env.USERPROFILE) env.HOME = env.USERPROFILE;
    if (!env.CODEX_HOME && config.codexHome) env.CODEX_HOME = config.codexHome;
    const args = ['app-server', '--listen', 'stdio://'];
    this.child = spawn(config.codexBin, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env });
    this.stderr = '';
    const lines = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    lines.on('line', (line) => this.#receive(line));
    this.child.stderr.on('data', (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-32_000);
    });
    this.child.on('error', (error) => this.#fail(error));
    this.child.on('close', (code) => this.#fail(new Error(`codex app-server exited with code ${code}: ${this.stderr}`)));

    await this.request('initialize', {
      clientInfo: { name: 'codex2api', title: 'Codex2API', version: '0.2.0' },
      capabilities: config.appServerExperimental ? { experimentalApi: true } : undefined,
    });
    this.notify('initialized', {});
    return this;
  }

  request(method, params, timeoutMs = config.timeoutMs) {
    if (!this.child?.stdin?.writable) return Promise.reject(new Error('codex app-server is not running'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`codex app-server request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.#send({ method, id, params });
    });
  }

  notify(method, params) {
    this.#send({ method, params });
  }

  async listModels() {
    await this.start();
    const result = await this.request('model/list', { includeHidden: false });
    return result.data || [];
  }

  async runChat({ messages, model, reasoningEffort, responseFormat, metadata, onDelta, onEvent, signal }) {
    await this.start();
    const jobId = crypto.randomUUID();
    const jobDir = path.join(config.dataDir, 'jobs', jobId);
    await fs.mkdir(jobDir, { recursive: true });
    const { developerInstructions, input } = await toCodexInput(messages, jobDir);
    const selectedModel = model && model !== 'codex' ? model : (config.codexModel || undefined);
    const threadResult = await this.request('thread/start', compact({
      model: selectedModel,
      cwd: jobDir,
      approvalPolicy: config.appServerApprovalPolicy,
      sandbox: config.appServerSandbox,
      developerInstructions: developerInstructions || undefined,
      ephemeral: true,
      serviceName: 'codex2api',
    }));
    const threadId = threadResult.thread.id;
    let turnId = null;
    let text = '';
    let reasoning = '';
    let usage = null;
    let completed;

    const completion = new Promise((resolve, reject) => {
      completed = { resolve, reject };
    });
    const handleEvent = (event) => {
      const params = event.params || {};
      if (params.threadId !== threadId) return;
      onEvent?.(event);
      if (event.method === 'turn/started') turnId = params.turn?.id || params.turnId || turnId;
      if (event.method === 'item/agentMessage/delta') {
        text += params.delta || '';
        onDelta?.(params.delta || '');
      }
      if (event.method === 'item/reasoning/summaryTextDelta') reasoning += params.delta || '';
      if (event.method === 'thread/tokenUsage/updated') usage = params.tokenUsage?.last || usage;
      if (event.method === 'item/completed' && params.item?.type === 'agentMessage' && !text) {
        text = params.item.text || '';
        if (text) onDelta?.(text);
      }
      if (event.method === 'turn/completed') {
        const turn = params.turn || {};
        if (turn.status === 'completed') completed.resolve(turn);
        else completed.reject(new Error(turn.error?.message || `Codex turn ${turn.status || 'failed'}`));
      }
    };
    this.on('notification', handleEvent);

    const abort = async () => {
      if (!turnId) return;
      try { await this.request('turn/interrupt', { threadId, turnId }, 10_000); } catch { /* request is already ending */ }
    };
    if (signal?.aborted) await abort();
    signal?.addEventListener('abort', abort, { once: true });

    try {
      const turnResult = await this.request('turn/start', compact({
        threadId,
        input,
        model: selectedModel,
        effort: reasoningEffort || undefined,
        outputSchema: responseFormatToSchema(responseFormat),
        responsesapiClientMetadata: stringifyMetadata(metadata),
      }));
      turnId = turnResult.turn?.id || turnId;
      const timer = setTimeout(() => completed.reject(new Error('Codex turn timed out')), config.timeoutMs);
      try { await completion; } finally { clearTimeout(timer); }
      return { text, reasoning, usage: toOpenAIUsage(usage), threadId, turnId, jobDir };
    } finally {
      signal?.removeEventListener('abort', abort);
      this.off('notification', handleEvent);
      this.request('thread/unsubscribe', { threadId }, 5_000).catch(() => {});
    }
  }

  async close() {
    const child = this.child;
    this.child = null;
    this.ready = null;
    if (child && !child.killed) child.kill();
  }

  #send(message) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #receive(line) {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (Object.hasOwn(message, 'id') && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else pending.resolve(message.result);
      return;
    }
    if (Object.hasOwn(message, 'id') && message.method) {
      this.#handleServerRequest(message);
      return;
    }
    if (message.method) this.emit('notification', message);
  }

  #handleServerRequest(message) {
    const method = message.method;
    let result;
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval' || method === 'execCommandApproval' || method === 'applyPatchApproval') result = { decision: 'decline' };
    else if (method === 'item/tool/requestUserInput') result = { answers: {} };
    else if (method === 'item/tool/call') result = { contentItems: [{ type: 'inputText', text: 'Dynamic tools are not exposed by this OpenAI-compatible endpoint.' }], success: false };
    else if (method === 'currentTime/read') result = { iso8601: new Date().toISOString() };
    else result = null;
    this.#send({ id: message.id, result });
  }

  #fail(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.emit('failure', error);
    this.ready = null;
  }
}

export async function toCodexInput(messages = [], jobDir) {
  const instructions = [];
  const input = [];
  for (const message of messages) {
    const role = String(message.role || 'user').toLowerCase();
    if (role === 'system' || role === 'developer') {
      instructions.push(contentToText(message.content));
      continue;
    }
    const parts = Array.isArray(message.content) ? message.content : [{ type: 'text', text: String(message.content ?? '') }];
    const textParts = [];
    for (const part of parts) {
      const type = part?.type;
      if (type === 'image_url' || type === 'input_image') {
        const url = part.image_url?.url || part.image_url || part.url;
        const detail = part.image_url?.detail || part.detail;
        if (url?.startsWith('data:')) input.push({ type: 'localImage', path: await saveDataImage(url, jobDir), ...(detail ? { detail } : {}) });
        else if (url) throw new Error('Remote image URLs are not supported; send an inline data URL or use /v1/images/analyze');
      } else {
        const value = part?.text ?? part?.content;
        if (value) textParts.push(String(value));
      }
    }
    if (textParts.length) input.push({ type: 'text', text: `${role.toUpperCase()}: ${textParts.join('\n')}`, text_elements: [] });
  }
  if (!input.length) input.push({ type: 'text', text: 'USER:', text_elements: [] });
  return { developerInstructions: instructions.filter(Boolean).join('\n\n'), input };
}

async function saveDataImage(dataUrl, jobDir) {
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([a-zA-Z0-9+/=\r\n]+)$/.exec(dataUrl);
  if (!match) throw new Error('Invalid or unsupported image data URL');
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > 25 * 1024 * 1024) throw new Error('Image data URL must be between 1 byte and 25 MiB');
  const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }[match[1]];
  const file = path.join(jobDir, `input-${crypto.randomUUID()}.${extension}`);
  await fs.writeFile(file, bytes);
  return file;
}

function contentToText(content) {
  if (typeof content === 'string') return content;
  return (content || []).map((part) => part?.text || part?.content || '').filter(Boolean).join('\n');
}

export function responseFormatToSchema(format) {
  if (format?.type === 'json_schema') return format.json_schema?.schema || format.json_schema;
  if (format?.type === 'json_object') return { type: 'object', additionalProperties: true };
  return undefined;
}

function stringifyMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') return undefined;
  return Object.fromEntries(Object.entries(metadata).map(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value)]));
}

export function toOpenAIUsage(value) {
  if (!value) return null;
  return {
    prompt_tokens: value.inputTokens || 0,
    completion_tokens: value.outputTokens || 0,
    total_tokens: value.totalTokens || 0,
    prompt_tokens_details: { cached_tokens: value.cachedInputTokens || 0 },
    completion_tokens_details: { reasoning_tokens: value.reasoningOutputTokens || 0 },
  };
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

export const appServer = new CodexAppServer();
