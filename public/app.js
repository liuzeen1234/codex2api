const $ = (id) => document.getElementById(id);
const headers = (json = true) => ({ ...(json ? { 'Content-Type': 'application/json' } : {}), ...($('apiKey').value ? { Authorization: `Bearer ${$('apiKey').value}` } : {}) });
const setBusy = (button, busy, text) => { button.disabled = busy; button.dataset.label ||= button.innerHTML; button.innerHTML = busy ? text : button.dataset.label; };
const toast = (text) => { $('toast').textContent = text; $('toast').classList.add('show'); setTimeout(() => $('toast').classList.remove('show'), 2800); };

const curlPanels = {};
for (const id of ['chat', 'generate', 'edit', 'analyze']) {
  const details = document.createElement('details');
  details.className = 'curl-example';
  const summary = document.createElement('summary');
  summary.textContent = '查看 curl 测试命令';
  const note = document.createElement('p');
  note.className = 'muted';
  note.textContent = '适用于 Bash / Git Bash / WSL。Windows PowerShell 可用 curl.exe，并按当前终端规则调整引号。';
  const pre = document.createElement('pre');
  const code = document.createElement('code');
  pre.append(code);
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'secondary';
  copy.textContent = '复制命令';
  copy.onclick = async () => {
    try { await navigator.clipboard.writeText(code.textContent); toast('curl 命令已复制'); }
    catch { toast('复制失败，请选中命令手动复制'); }
  };
  details.append(summary, note, pre, copy);
  $(id).querySelector('.workspace').append(details);
  curlPanels[id] = code;
}
function shellQuote(value) { return "'" + String(value).replaceAll("'", "'\\''") + "'"; }
function updateCurlExamples() {
  const base = location.origin;
  const model = $('model').value || 'codex';
  const auth = $('apiKey').value ? ' \\\n  -H "Authorization: Bearer $CODEX2API_API_KEY"' : '';
  const prefix = $('apiKey').value ? '# 先在终端设置 CODEX2API_API_KEY 环境变量（此处不包含你的密钥）\n' : '';
  const jsonCommand = (endpoint, body) => prefix + `curl ${shellQuote(base + endpoint)}${auth} \\\n  -H 'Content-Type: application/json' \\\n  --data-raw ${shellQuote(JSON.stringify(body))}`;
  const chatBody = { model, messages: [{ role: 'user', content: $('chatPrompt').value || '你好，请介绍一下自己。' }], stream: $('stream').checked };
  if ($('reasoningEffort').value) chatBody.reasoning_effort = $('reasoningEffort').value;
  curlPanels.chat.textContent = jsonCommand('/v1/chat/completions', chatBody).replace('curl ', chatBody.stream ? 'curl -N ' : 'curl ');
  curlPanels.generate.textContent = jsonCommand('/v1/images/generations', { model, prompt: $('imagePrompt').value, size: $('imageSize').value, response_format: $('imageFormat').value });
  for (const [id, endpoint, inputId, promptId] of [
    ['edit', '/v1/images/edits', 'sourceImage', 'editPrompt'],
    ['analyze', '/v1/images/analyze', 'analyzeImage', 'analyzePrompt'],
  ]) {
    const file = $(inputId).files[0]?.name || 'input.png';
    curlPanels[id].textContent = '# 将图片文件名替换为终端中可访问的实际路径\n' + prefix + `curl ${shellQuote(base + endpoint)}${auth} \\\n  -F ${shellQuote('image=@' + file)} \\\n  --form-string ${shellQuote('model=' + model)} \\\n  --form-string ${shellQuote('prompt=' + $(promptId).value)}` + (id === 'edit' ? " \\\n  --form-string 'response_format=url'" : '');
  }
}
document.addEventListener('input', updateCurlExamples);
document.addEventListener('change', updateCurlExamples);

document.querySelectorAll('.tab').forEach((tab) => tab.onclick = () => {
  document.querySelectorAll('.tab,.panel').forEach((el) => el.classList.remove('active'));
  tab.classList.add('active'); $(tab.dataset.tab).classList.add('active');
});

async function checkHealth() {
  try { const r = await fetch('/health'); if (!r.ok) throw 0; $('statusDot').className = 'dot ok'; $('statusText').textContent = '服务在线'; }
  catch { $('statusDot').className = 'dot bad'; $('statusText').textContent = '连接失败'; }
}
let modelCatalog = [];
const effortLabels = { none: '无', minimal: '极轻量', low: '轻量', medium: '中等', high: '高', xhigh: '超高', max: '最高', ultra: '极高' };
function updateEfforts() {
  const previous = $('reasoningEffort').value;
  const model = modelCatalog.find(item => item.id === $('model').value);
  const efforts = model?.reasoning_efforts || [];
  $('reasoningEffort').replaceChildren(new Option('模型默认', ''));
  for (const item of efforts) {
    const value = typeof item === 'string' ? item : item.reasoningEffort;
    if (!value) continue;
    const option = new Option(`${effortLabels[value] || value} (${value})`, value);
    option.title = item.description || '';
    $('reasoningEffort').add(option);
  }
  $('reasoningEffort').value = efforts.some(item => (item.reasoningEffort || item) === previous) ? previous : '';
  $('reasoningEffort').disabled = !efforts.length;
  $('modelResult').textContent = model?.description || '使用服务端默认模型；选择具体模型后可查看其支持的推理强度。';
  updateCurlExamples();
}
async function loadModels() {
  setBusy($('loadModels'), true, '加载中…');
  try {
    const previous = $('model').value;
    const data = await parse(await fetch('/v1/models', { headers: headers(false) }));
    modelCatalog = data.data || [];
    $('model').replaceChildren(new Option('服务默认模型', 'codex'));
    for (const item of modelCatalog) {
      if (item.id !== 'codex') $('model').add(new Option(item.name ? `${item.name} · ${item.id}` : item.id, item.id));
    }
    const fallback = modelCatalog.find(item => item.id !== 'codex')?.id || 'codex';
    $('model').value = previous !== 'codex' && [...$('model').options].some(option => option.value === previous) ? previous : fallback;
    updateEfforts();
  } catch (e) { $('modelResult').textContent = `模型加载失败：${e.message}。填写 API Key 后可点击刷新。`; }
  finally { setBusy($('loadModels'), false); }
}
$('model').onchange = updateEfforts;
$('loadModels').onclick = loadModels;
$('apiKey').onchange = loadModels;

$('chatForm').onsubmit = async (event) => {
  event.preventDefault(); const button = event.submitter; const prompt = $('chatPrompt').value.trim(); if (!prompt) return;
  $('conversation').querySelector('.empty')?.remove(); addMessage('user', prompt); const answer = addMessage('assistant', '正在思考…'); setBusy(button, true, '请求中…');
  try {
    const body = { model: $('model').value || 'codex', stream: $('stream').checked, messages: [{ role: 'user', content: prompt }] };
    if ($('reasoningEffort').value) body.reasoning_effort = $('reasoningEffort').value;
    const r = await fetch('/v1/chat/completions', { method: 'POST', headers: headers(), body: JSON.stringify(body) });
    if (!r.ok) throw new Error((await r.json()).error?.message || `HTTP ${r.status}`);
    if (!body.stream) answer.textContent = (await r.json()).choices[0].message.content;
    else await readStream(r, answer);
    $('chatPrompt').value = '';
  } catch (e) { answer.textContent = `请求失败：${e.message}`; answer.classList.add('error'); }
  finally { setBusy(button, false); }
};

$('generateForm').onsubmit = async (event) => {
  event.preventDefault(); const button = event.submitter; setBusy(button, true, 'Codex 正在绘制…'); loading($('generateResult'));
  try {
    const body = { model: $('model').value || 'codex', prompt: $('imagePrompt').value, size: $('imageSize').value, response_format: $('imageFormat').value };
    const r = await fetch('/v1/images/generations', { method: 'POST', headers: headers(), body: JSON.stringify(body) }); renderImage($('generateResult'), await parse(r), body.response_format);
  } catch (e) { showError($('generateResult'), e); } finally { setBusy(button, false); }
};

$('sourceImage').onchange = () => {
  const file = $('sourceImage').files[0]; if (!file) return; $('preview').src = URL.createObjectURL(file); $('preview').hidden = false; $('uploadText').textContent = file.name;
};
$('editForm').onsubmit = async (event) => {
  event.preventDefault(); const button = event.submitter; setBusy(button, true, 'Codex 正在转换…'); loading($('editResult'));
  try {
    const form = new FormData(); form.append('image', $('sourceImage').files[0]); form.append('prompt', $('editPrompt').value); form.append('model', $('model').value || 'codex'); form.append('response_format', 'url');
    const r = await fetch('/v1/images/edits', { method: 'POST', headers: headers(false), body: form }); renderImage($('editResult'), await parse(r), 'url');
  } catch (e) { showError($('editResult'), e); } finally { setBusy(button, false); }
};

$('analyzeImage').onchange = () => previewFile('analyzeImage', 'analyzePreview', 'analyzeUploadText');
$('analyzeForm').onsubmit = async (event) => {
  event.preventDefault(); const button = event.submitter; const target = $('analyzeResult'); setBusy(button, true, 'Codex 正在观察…'); loading(target);
  try {
    const form = new FormData(); form.append('image', $('analyzeImage').files[0]); form.append('prompt', $('analyzePrompt').value); form.append('model', $('model').value || 'codex');
    const data = await parse(await fetch('/v1/images/analyze', { method: 'POST', headers: headers(false), body: form }));
    target.textContent = data.text;
  } catch (e) { showError(target, e); } finally { setBusy(button, false); }
};

function addMessage(role, text) { const el = document.createElement('div'); el.className = `message ${role}`; el.textContent = text; $('conversation').append(el); $('conversation').scrollTop = $('conversation').scrollHeight; return el; }
async function readStream(response, element) {
  element.textContent = ''; const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
  while (true) { const { done, value } = await reader.read(); if (done) break; buffer += decoder.decode(value, { stream: true }); const events = buffer.split('\n\n'); buffer = events.pop(); for (const event of events) { const line = event.split('\n').find(x => x.startsWith('data: ')); if (!line || line === 'data: [DONE]') continue; const data = JSON.parse(line.slice(6)); if (data.error) throw new Error(data.error.message); element.textContent += data.choices?.[0]?.delta?.content || ''; } }
}
async function parse(response) { const data = await response.json(); if (!response.ok) throw new Error(data.error?.message || `HTTP ${response.status}`); return data; }
function loading(target) { target.innerHTML = '<div class="empty">正在调用 Codex，请稍候…</div>'; }
function showError(target, error) { target.innerHTML = ''; const el = document.createElement('div'); el.className = 'empty'; el.textContent = `请求失败：${error.message}`; target.append(el); }
function renderImage(target, payload, format) { target.innerHTML = ''; payload.data.forEach(item => { const img = document.createElement('img'); img.alt = item.revised_prompt || '生成结果'; img.src = format === 'b64_json' ? `data:image/png;base64,${item.b64_json}` : item.url; target.append(img); }); }
function previewFile(inputId, previewId, textId) { const file = $(inputId).files[0]; if (!file) return; $(previewId).src = URL.createObjectURL(file); $(previewId).hidden = false; $(textId).textContent = file.name; }
checkHealth();
loadModels();
updateCurlExamples();
