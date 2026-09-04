const $ = (id) => document.getElementById(id);
const headers = (json = true) => ({ ...(json ? { 'Content-Type': 'application/json' } : {}), ...($('apiKey').value ? { Authorization: `Bearer ${$('apiKey').value}` } : {}) });
const setBusy = (button, busy, text) => { button.disabled = busy; button.dataset.label ||= button.innerHTML; button.innerHTML = busy ? text : button.dataset.label; };
const toast = (text) => { $('toast').textContent = text; $('toast').classList.add('show'); setTimeout(() => $('toast').classList.remove('show'), 2800); };

document.querySelectorAll('.tab').forEach((tab) => tab.onclick = () => {
  document.querySelectorAll('.tab,.panel').forEach((el) => el.classList.remove('active'));
  tab.classList.add('active'); $(tab.dataset.tab).classList.add('active');
});

async function checkHealth() {
  try { const r = await fetch('/health'); if (!r.ok) throw 0; $('statusDot').className = 'dot ok'; $('statusText').textContent = '服务在线'; }
  catch { $('statusDot').className = 'dot bad'; $('statusText').textContent = '连接失败'; }
}
$('loadModels').onclick = async () => {
  try { const r = await fetch('/v1/models', { headers: headers(false) }); const data = await parse(r); $('modelResult').textContent = data.data.map(x => x.id).join('、'); }
  catch (e) { toast(e.message); }
};

$('chatForm').onsubmit = async (event) => {
  event.preventDefault(); const button = event.submitter; const prompt = $('chatPrompt').value.trim(); if (!prompt) return;
  $('conversation').querySelector('.empty')?.remove(); addMessage('user', prompt); const answer = addMessage('assistant', '正在思考…'); setBusy(button, true, '请求中…');
  try {
    const body = { model: $('model').value || 'codex', stream: $('stream').checked, messages: [{ role: 'user', content: prompt }] };
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
