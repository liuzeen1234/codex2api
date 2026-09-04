import express from 'express';
import multer from 'multer';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { runCodex } from './codex.js';

await fs.mkdir(path.join(config.dataDir, 'uploads'), { recursive: true });
await fs.mkdir(path.join(config.dataDir, 'jobs'), { recursive: true });
const upload = multer({ dest: path.join(config.dataDir, 'uploads'), limits: { fileSize: 25 * 1024 * 1024, files: 10 } });
const app = express();
app.use(express.json({ limit: '30mb' }));
app.use(express.static(path.resolve('public')));
app.use('/files', express.static(path.join(config.dataDir, 'jobs')));
app.use((req, res, next) => {
  if (!config.apiKey) return next();
  if (req.headers.authorization === `Bearer ${config.apiKey}`) return next();
  res.status(401).json(openAIError('Invalid API key', 'authentication_error'));
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.get('/v1/models', (_req, res) => res.json({ object: 'list', data: [{ id: config.codexModel || 'codex', object: 'model', created: 0, owned_by: 'codex' }] }));

app.post('/v1/chat/completions', async (req, res, next) => {
  try {
    const { messages = [], model, stream = false } = req.body;
    const prompt = messagesToPrompt(messages);
    const id = `chatcmpl-${crypto.randomUUID()}`;
    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.flushHeaders();
      try {
        const result = await runCodex({ prompt, model });
        const chunk = { id, object: 'chat.completion.chunk', created: unix(), model: model || 'codex', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        for (const content of splitText(result.text)) {
          if (res.destroyed) break;
          res.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`);
          await delay(18);
        }
        res.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
        res.end('data: [DONE]\n\n');
      } catch (error) {
        console.error(error);
        res.write(`data: ${JSON.stringify({ error: { message: error.message, type: 'server_error' } })}\n\n`);
        res.end('data: [DONE]\n\n');
      }
      return;
    }
    const result = await runCodex({ prompt, model });
    res.json({ id, object: 'chat.completion', created: unix(), model: model || 'codex', choices: [{ index: 0, message: { role: 'assistant', content: result.text }, finish_reason: 'stop' }], usage: null });
  } catch (error) { next(error); }
});

app.post('/v1/responses', async (req, res, next) => {
  try {
    const input = typeof req.body.input === 'string' ? req.body.input : messagesToPrompt(req.body.input || []);
    const result = await runCodex({ prompt: input, model: req.body.model });
    const id = `resp_${crypto.randomUUID()}`;
    res.json({ id, object: 'response', created_at: unix(), status: 'completed', model: req.body.model || 'codex', output: [{ id: `msg_${crypto.randomUUID()}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: result.text, annotations: [] }] }], output_text: result.text, usage: null });
  } catch (error) { next(error); }
});

app.post('/v1/images/generations', async (req, res, next) => {
  try { res.json(await createImages({ ...req.body, images: [] })); } catch (error) { next(error); }
});

app.post('/v1/images/edits', upload.fields([{ name: 'image', maxCount: 10 }, { name: 'mask', maxCount: 1 }]), async (req, res, next) => {
  try {
    const images = [...(req.files?.image || []), ...(req.files?.mask || [])].map((f) => path.resolve(f.path));
    res.json(await createImages({ ...req.body, images }));
  } catch (error) { next(error); }
});

app.post('/v1/images/analyze', upload.array('image', 10), async (req, res, next) => {
  try {
    const images = (req.files || []).map((file) => path.resolve(file.path));
    if (!images.length) return res.status(400).json(openAIError('At least one image is required', 'invalid_request_error'));
    const result = await runCodex({ prompt: req.body.prompt || '请详细描述图片中的内容。', model: req.body.model, images });
    res.json({ id: `vision_${crypto.randomUUID()}`, object: 'image.analysis', created: unix(), model: req.body.model || 'codex', text: result.text, data: [{ text: result.text }] });
  } catch (error) { next(error); }
});

async function createImages({ prompt, model, n = 1, size = '1024x1024', response_format = 'url', images }) {
  const instruction = `Use the image generation/editing capability to create ${n} image(s). Request: ${prompt}\nTarget size: ${size}. Save every final image directly in the current working directory as result-1.png, result-2.png, etc. Do not only describe the image.`;
  const result = await runCodex({ prompt: instruction, model, images });
  if (!result.files.length) throw new Error(`Codex did not produce an image. Last response: ${result.text}`);
  const data = await Promise.all(result.files.slice(0, Number(n)).map(async (file) => response_format === 'b64_json'
    ? { b64_json: await fs.readFile(file, 'base64'), revised_prompt: result.text }
    : { url: `${config.publicBaseUrl}/files/${path.basename(result.jobDir)}/${encodeURIComponent(path.basename(file))}`, revised_prompt: result.text }));
  return { created: unix(), data };
}

function messagesToPrompt(messages) {
  return messages.map((message) => {
    const content = typeof message.content === 'string' ? message.content : (message.content || []).map((part) => part.text || (part.type === 'image_url' ? `[image: ${part.image_url?.url || part.image_url}]` : '')).join('\n');
    return `${String(message.role || 'user').toUpperCase()}: ${content}`;
  }).join('\n\n');
}
function unix() { return Math.floor(Date.now() / 1000); }
function splitText(value, size = 3) {
  const characters = Array.from(value || '');
  return Array.from({ length: Math.ceil(characters.length / size) }, (_, index) => characters.slice(index * size, index * size + size).join(''));
}
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function openAIError(message, type = 'server_error') { return { error: { message, type, param: null, code: null } }; }
app.use((error, _req, res, _next) => {
  console.error(error);
  if (res.headersSent) return res.end();
  res.status(error instanceof multer.MulterError ? 400 : 500).json(openAIError(error.message));
});
app.listen(config.port, () => console.log(`codex2api listening on http://localhost:${config.port}`));
