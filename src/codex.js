import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

export async function runCodex({ prompt, images = [], model, onText }) {
  const jobId = crypto.randomUUID();
  const jobDir = path.join(config.dataDir, 'jobs', jobId);
  await fs.mkdir(jobDir, { recursive: true });
  const args = ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'workspace-write', '-C', jobDir];
  const selectedModel = model || config.codexModel;
  if (selectedModel && selectedModel !== 'codex') args.push('--model', selectedModel);
  for (const image of images) args.push('--image', image);
  args.push('-');

  return await new Promise((resolve, reject) => {
    const env = { ...process.env };
    if (!env.HOME && env.USERPROFILE) env.HOME = env.USERPROFILE;
    if (!env.CODEX_HOME && config.codexHome) env.CODEX_HOME = config.codexHome;
    const child = spawn(config.codexBin, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env });
    let stdout = '';
    let stderr = '';
    let finalText = '';
    let lineBuffer = '';
    const timer = setTimeout(() => child.kill(), config.timeoutMs);

    const consumeLine = (line) => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line);
        const text = extractText(event);
        if (text) {
          finalText = text;
          onText?.(text);
        }
      } catch { /* stderr-like non JSON output is retained in stdout */ }
    };
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      lineBuffer += text;
      const lines = lineBuffer.split(/\r?\n/);
      lineBuffer = lines.pop() || '';
      lines.forEach(consumeLine);
    });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', async (code) => {
      clearTimeout(timer);
      consumeLine(lineBuffer);
      if (code !== 0) return reject(new Error(`codex exited with code ${code}: ${stderr || stdout}`));
      resolve({ text: finalText, jobDir, files: await findImages(jobDir), raw: stdout });
    });
    child.stdin.end(prompt);
  });
}

function extractText(event) {
  if (event?.type === 'item.completed' && event.item?.type === 'agent_message') return event.item.text || '';
  if (event?.type === 'message' && event.role === 'assistant') return event.content || '';
  return '';
}

async function findImages(root) {
  const found = [];
  async function walk(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) found.push(file);
    }
  }
  await walk(root);
  return found;
}
