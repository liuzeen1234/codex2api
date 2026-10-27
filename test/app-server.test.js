import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { responseFormatToSchema, toCodexInput, toOpenAIUsage } from '../src/app-server.js';

test('maps roles, text, and system instructions to Codex input', async () => {
  const result = await toCodexInput([
    { role: 'system', content: 'Be concise.' },
    { role: 'developer', content: 'Return plain text.' },
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: 'Hi' },
  ], os.tmpdir());
  assert.equal(result.developerInstructions, 'Be concise.\n\nReturn plain text.');
  assert.deepEqual(result.input, [
    { type: 'text', text: 'USER: Hello', text_elements: [] },
    { type: 'text', text: 'ASSISTANT: Hi', text_elements: [] },
  ]);
});

test('materializes an inline image inside the isolated job directory', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex2api-test-'));
  try {
    const result = await toCodexInput([{ role: 'user', content: [
      { type: 'text', text: 'Describe it' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=', detail: 'low' } },
    ] }], root);
    const image = result.input.find((item) => item.type === 'localImage');
    assert.ok(image.path.startsWith(root));
    assert.equal(image.detail, 'low');
    assert.equal((await fs.stat(image.path)).size, 8);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('rejects remote image URLs to avoid SSRF', async () => {
  await assert.rejects(
    toCodexInput([{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'http://127.0.0.1/private.png' } }] }], os.tmpdir()),
    /Remote image URLs are not supported/,
  );
});

test('maps JSON response formats and usage', () => {
  const schema = { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } } };
  assert.equal(responseFormatToSchema({ type: 'json_schema', json_schema: { schema } }), schema);
  assert.deepEqual(responseFormatToSchema({ type: 'json_object' }), { type: 'object', additionalProperties: true });
  assert.deepEqual(toOpenAIUsage({ totalTokens: 12, inputTokens: 10, cachedInputTokens: 3, outputTokens: 2, reasoningOutputTokens: 1 }), {
    prompt_tokens: 10,
    completion_tokens: 2,
    total_tokens: 12,
    prompt_tokens_details: { cached_tokens: 3 },
    completion_tokens_details: { reasoning_tokens: 1 },
  });
});
