---
name: codex2api
description: Integrate applications and user interfaces with a Codex-backed HTTP service for text generation, text streaming, image generation, image editing, and image understanding. Use when building, debugging, or validating a client for a deployed codex2api instance.
---

# Codex2API Integration

Use codex2api as an HTTP service. Do not invoke the Codex CLI directly from the client application and do not depend on a particular user's filesystem, account name, or Codex configuration directory.

## Discover the service

Obtain the base URL from the user, deployment configuration, or the application's environment. Use `http://localhost:3010` only as the development default; keep it configurable in client code.

Before implementing an integration:

1. Fetch `<base-url>/openapi.yaml` when the service is running.
2. Otherwise, read [public/openapi.yaml](public/openapi.yaml) from this repository.
3. Treat that OpenAPI 3.1 document and the deployed service as the contract. Inspect [src/server.js](src/server.js) only when diagnosing implementation-specific behavior.
4. Call `GET /health` and stop with a clear connection error if the service is unavailable.

Do not assume authentication is disabled. Accept an optional API key and, when present, send `Authorization: Bearer <api-key>`. Never log, persist, or display the key unless the host application explicitly provides a secure credential store.

## Select the capability

- Text chat: `POST /v1/chat/completions`.
- Responses-style text generation: `POST /v1/responses`.
- Text-to-image: `POST /v1/images/generations`.
- Image-to-image editing: `POST /v1/images/edits`.
- Image-to-text analysis, OCR, or visual understanding: `POST /v1/images/analyze`.
- Model discovery: `GET /v1/models`.

Use `codex` as the model value to select the server's default model. Pass a concrete model only when the user or deployment requires one.

## Implement text generation

For ordinary chat, send JSON with `model`, `messages`, and `stream`.

When `stream` is false, read the answer from `choices[0].message.content`.

When `stream` is true:

- Request and parse `text/event-stream` incrementally.
- Process each `data:` record independently; network chunks do not necessarily align with SSE records.
- Append `choices[0].delta.content` when present.
- Finish only after `data: [DONE]` or connection closure.
- If a data record contains `error`, surface its `message` and stop the request.
- Support cancellation through the client framework's abort mechanism.

The current server invokes `codex exec`, which emits the completed assistant answer rather than upstream token deltas. The server then sends that answer as multiple SSE deltas. Therefore, a pause before the first delta is expected and client-side timeout limits must allow for model execution.

## Implement image operations

For text-to-image, send JSON. Handle both response formats:

- `url`: display or download `data[].url`. Treat returned URLs as deployment-dependent and potentially temporary.
- `b64_json`: decode `data[].b64_json` using the image MIME type expected by the client; the current service produces PNG results.

For image editing and image analysis, send `multipart/form-data` and let the HTTP library generate the multipart boundary. Use `image` as the upload field name. The service accepts up to 10 image files with a per-file limit of 25 MiB. Image editing may also include a `mask` file.

Read image-analysis text from the top-level `text` field. The same value is also available as `data[0].text` for clients that prefer a data-array shape.

## Handle failures and long-running requests

Parse non-success JSON as an OpenAI-style error object and show `error.message`. Distinguish authentication errors, invalid uploads, service unavailability, client cancellation, and model execution failures when the host UI benefits from distinct recovery actions.

Image operations and first text output may take substantially longer than ordinary REST calls. Use a configurable timeout appropriate for model execution rather than a short networking default. While waiting, prevent accidental duplicate submissions and expose cancellation when possible.

Do not automatically retry generation requests: a failed or disconnected request may still have consumed model quota or produced server-side artifacts. Retry only after explicit user action or when the surrounding application already defines a safe idempotent policy.

## Build user-facing clients

When the task includes UI work, preserve the host application's framework and design system. Provide:

- Configurable base URL and optional API key.
- Service status and model discovery where useful.
- Separate text, text-to-image, image-editing, and image-analysis flows when all capabilities are in scope.
- Image previews before upload and result preview/download afterward.
- Loading, cancellation, empty, success, and actionable error states.
- Responsive behavior and accessible labels.

Do not copy the repository demo into an unrelated product unless the user explicitly asks for it; integrate with the product's existing architecture.

## Validate the integration

Validate only the capabilities included in the task:

1. Confirm `GET /health` returns `{"status":"ok"}`.
2. Confirm unauthenticated and authenticated behavior matches the deployment configuration.
3. Test non-streaming text and, when used, verify streaming produces multiple deltas and terminates with `[DONE]`.
4. Test each requested image flow with a small supported image and verify either URL or Base64 rendering.
5. Confirm server errors are rendered as useful messages and secrets are absent from logs.

Report which live calls were performed. Do not claim an image or streaming path was verified when it was only checked statically.
