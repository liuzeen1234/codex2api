# codex2api

把本机已登录的 Codex 包装为 OpenAI 兼容的 HTTP API，支持文生文、文生图、图生图和图生文。

`/v1/chat/completions` 使用常驻的 `codex app-server`：支持真正的文本增量、模型目录、系统/开发者指令、图片输入、推理强度、JSON Schema、token usage、取消，以及 Codex 已配置的内置工具、skills 和 MCP。图片生成类接口仍使用独立 `codex exec` 任务，以便收集生成文件。

启动后浏览器访问 `http://localhost:3010`，即可通过 Demo 页面体验全部功能。

## 启动

```powershell
npm install
Copy-Item .env.example .env
npm start
```

Node.js 需要 20 或更高版本，且本机需已安装并登录 `codex`。当前 Codex CLI 必须包含 `app-server` 子命令。环境变量可直接在启动进程中设置；项目不会自动读取 `.env`。
Windows 下程序会默认从 `%USERPROFILE%\\.codex` 读取 Codex 登录信息，也可通过 `CODEX_HOME` 覆盖。

### App Server 配置

- `CODEX_APP_SERVER=true`：启用 app-server Chat Completions 后端。
- `CODEX_APP_SERVER_EXPERIMENTAL=true`：启用 app-server 实验协议字段。
- `CODEX_APPROVAL_POLICY=never`：HTTP 服务不代替用户处理交互式审批。
- `CODEX_SANDBOX=workspace-write`：每个请求只能写入自己的 `data/jobs/<id>` 工作目录。
- `CODEX_TIMEOUT_MS=600000`：请求与 turn 超时。

为了避免外部 HTTP 调用借服务访问内网，Chat Completions 的图片输入仅接受内联 `data:image/...;base64,...`。需要上传文件时使用 `/v1/images/analyze`。

## 接口

- `GET /health`
- `GET /v1/models`
- `POST /v1/chat/completions`（app-server 原生增量；支持 `stream: true`）
- `POST /v1/responses`
- `POST /v1/images/generations`
- `POST /v1/images/edits`（`multipart/form-data`）
- `POST /v1/images/analyze`（图生文，`multipart/form-data`）

### 文生文

```powershell
curl.exe http://localhost:3010/v1/chat/completions -H "Content-Type: application/json" -d '{"model":"codex","messages":[{"role":"user","content":"你好"}]}'
```

兼容字段包括 `model`、`messages`、`stream`、`stream_options.include_usage`、`reasoning_effort`、`response_format` 和 `metadata`。`response_format.type=json_schema` 会映射为 Codex turn 的 `outputSchema`。

流式响应直接转发 `item/agentMessage/delta`，以 `data: [DONE]` 结束。非流式响应额外提供 `codex.thread_id`、`codex.turn_id` 和可用的 `codex.reasoning_summary`。

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

不带工具的 Chat Completions 共用常驻 app-server，每次请求使用独立临时 thread。图像接口保持原有执行路径。

### 外部工具（DSH / OpenAI Chat Completions）

带 `tools`、`tool_choice` 或工具历史的请求走独立的 Responses 转接路径，只向模型提交调用方声明的 function tools；不会创建 Codex thread、临时工作目录，也不会运行 Codex 的文件、Shell、MCP、skills 或其他内置工具。工具由 DSH/客户端执行，服务只返回标准 `message.tool_calls`，并在下一次请求把 assistant 调用及 `role=tool` 转成 `function_call` / `function_call_output`，原样保留 `call_id`、名称、JSON 参数和结果（包括错误文本）。

为什么不用 dynamic tools：本机 `codex-cli 0.164.0-alpha.11.1` 的 `codex app-server generate-ts --experimental` 确认存在 `thread/start.dynamicTools`、`item/tool/call` 和 `{contentItems, success}` 结果响应，但 `thread/start` / `turn/start` 没有 `tool_choice` 或可确认的全局内置工具禁用字段。为确保只允许 DSH 工具，采用直接的 [Responses function-calling 协议](https://developers.openai.com/api/docs/guides/function-calling)，不伪装成已实现 app-server dynamic-tools 桥接。

- 支持非流式及 SSE；工具增量包含 `index`、`id`、`type`、函数名及参数片段，结束原因是 `tool_calls`。普通回答为 `stop`。
- 支持 `tool_choice=auto|none|required` 及指定已声明函数，支持 `parallel_tool_calls`。不支持的选择、重复工具名、非对象形式的 Schema 声明、孤立/重复/缺失的结果 ID、旧式 `functions/function_call` 和 `n!=1` 返回 400。标准 JSON Schema 原样交给上游验证，允许省略根 `type`、使用 `$ref` 或组合 Schema。旧 DSH 插件直接注册的参数字段简写（例如 `delete_records` 的 `action: {type: string, required: true}`）会转换为标准 `type: object`、`properties` 和 `required` 数组，字段描述及约束保留。2026-10-27 此兼容修复通过 15 项自动测试；3010 携带真实字段形状的声明测试返回 `SCHEMA_OK`，使用 `tool_choice=none`，未执行删除。
- 每次提交完整 `messages`，一个 assistant 的所有调用都必须回传结果后才能续接。可更换后续请求的工具列表。无服务端待处理调用、会话缓存或跨请求锁；并发请求完全独立，重启后仍可用完整历史续接。取消、断线和超时会中止当前上游请求并释放 reader/定时器。
- 当前此路径使用 `CODEX_HOME/auth.json` 中已有的 ChatGPT Codex 登录，只在内存读取凭据、只发往固定 HTTPS Codex 后端，不把凭据发送给 DSH。过期登录需通过 Codex 刷新；HTTP 401 返回明确提示。该 ChatGPT 后端是实验性兼容依赖，未来协议变化可能需要适配；API-key 登录模式暂不支持外部工具。
- `response_format`、`reasoning_effort`、内联图片可用于工具请求；`metadata`、采样参数和输出 token 上限当前不转发。工具结果目前接受文本/JSON/错误文本及 text 数组，不接受多媒体工具结果。`/v1/responses` 仍为原有文本接口，此次外部工具支持范围为 `/v1/chat/completions`。

验证：`npm test` 包含 HTTP/SSE、结构化工具历史、并发与取消清理测试（测试环境需允许 localhost 网络）。运行独立验证服务：`$env:PORT='3011'; $env:CODEX_APP_SERVER='false'; node src/server.js`；再运行 `node scripts/live-external-tools.mjs`，验证客户端真实执行两轮加法。`scripts/dsh-tools-smoke.py` 用本机 DSH SDK profile、独立 home 和 workspace 验证真实工具；需要安装 pydantic 的 Python。DSH 自己要求审批的工具仍由 DSH 决定，转接层不批准。

2026-10-27 本机验收：13 项自动测试通过；3010 真实客户端两轮调用分别得到 42、50（覆盖非流式、流式及 `role=tool` 续接），原 app-server 文本请求返回 `TEXT_OK`。实际 DSH SDK profile 成功执行 `skill`、`read`、`cordis_inspect_list`、`cordis_inspect_query`；`plugin_manager` 请求送达 DSH 后被其审批层拒绝，模型收到错误结果并解释原因。DSH 持久化事件（包含 `tool/call`、`tool/result`、执行路径、调用 ID 和审批结果）在 `data/dsh-tools-smoke/result.json`，此目录已被 Git 忽略。可设置 `TEST_BASE_URL=http://127.0.0.1:3010` 在正式本机端口重跑两个验收脚本。

额外并行实测脚本：`node scripts/live-parallel-tools.mjs`，验证两个同轮调用及倒序结果回传；最终 3010 实测通过，两个 `client_echo` 调用参数分别为 1、2，倒序回传后模型回答 `COMPLETE`。Codex 后端的并行参数可能只出现在 `response.function_call_arguments.done` / `response.output_item.done`，转接层会补发尚未输出的参数后缀；自动测试覆盖该行为。验收期间也观察到独立直连请求出现 `ECONNRESET`，此类传输故障会返回 502/SSE error，绝不会伪造工具成功或结束原因。

更新后停止原来 `node src/server.js` 的进程，再在本目录以原有环境运行 `npm start`。项目不会自动加载 `.env`；如需加载，可在支持的 Node 版本使用 `node --env-file=.env src/server.js`。现有本机启动助手为 `C:\Users\liu\.codex\skills\codex2api\scripts\ensure-codex2api.ps1`，它只启动未运行的服务，更新时应先停止旧进程。

吞吐量和延迟取决于 Codex CLI、模型和账户配额。请遵守所使用账户与模型的服务条款，不建议将个人登录凭据直接暴露为公共服务。
