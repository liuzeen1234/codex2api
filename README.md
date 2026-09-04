# codex2api

把本机已登录的 Codex CLI 包装为 OpenAI 兼容的 HTTP API，支持文生文、文生图、图生图和图生文。

启动后浏览器访问 `http://localhost:3010`，即可通过 Demo 页面体验全部功能。

## 启动

```powershell
npm install
Copy-Item .env.example .env
npm start
```

Node.js 需要 20 或更高版本，且本机需已安装并登录 `codex`。环境变量可直接在启动进程中设置；项目不会自动读取 `.env`。
Windows 下程序会默认从 `%USERPROFILE%\\.codex` 读取 Codex 登录信息，也可通过 `CODEX_HOME` 覆盖。

## 接口

- `GET /health`
- `GET /v1/models`
- `POST /v1/chat/completions`（支持 `stream: true`；Codex CLI 完成回答后以 SSE 增量输出）
- `POST /v1/responses`
- `POST /v1/images/generations`
- `POST /v1/images/edits`（`multipart/form-data`）
- `POST /v1/images/analyze`（图生文，`multipart/form-data`）

### 文生文

```powershell
curl.exe http://localhost:3010/v1/chat/completions -H "Content-Type: application/json" -d '{"model":"codex","messages":[{"role":"user","content":"你好"}]}'
```

### 文生图

```powershell
curl.exe http://localhost:3010/v1/images/generations -H "Content-Type: application/json" -d '{"prompt":"雨夜的上海街头，电影感","size":"1024x1024","response_format":"url"}'
```

### 图生图

```powershell
curl.exe http://localhost:3010/v1/images/edits -F "image=@input.png" -F "prompt=改成水彩插画风格" -F "response_format=b64_json"
```

### 图生文

```powershell
curl.exe http://localhost:3010/v1/images/analyze -F "image=@input.png" -F "prompt=详细描述图片并识别其中的文字"
```

设置 `API_KEY` 后，请求需携带 `Authorization: Bearer <API_KEY>`。生产部署时应设置公网可访问的 `PUBLIC_BASE_URL`；不希望暴露图片文件时使用 `b64_json`。

## 注意

每次请求都会启动一个独立的 `codex exec` 进程，吞吐量和延迟取决于 Codex CLI。请遵守所使用账户与模型的服务条款、配额和并发限制，不建议将个人登录凭据直接暴露为公共服务。
