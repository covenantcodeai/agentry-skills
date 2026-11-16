# Symptom → cause → fix

| Symptom (check.mjs, console log, or debug prompt) | Likely cause | Fix |
|---|---|---|
| Check connection fails: `timeout` / `ECONNREFUSED` / `ENOTFOUND` | Server not running, wrong port, tunnel down, URL typo | Start the server; `curl https://<host>/health`; restart ngrok with the same static domain. |
| Check connection: `health endpoint returned 404` | `/health` isn't at the root of the host (mounted under `/api`, or only the webhook path exists) | Add `GET /health` at the root. Agentry drops the webhook path and calls `<origin>/health`. |
| ngrok URL returns an HTML page / `ERR_NGROK_*` | Tunnel offline, wrong domain, or the free-plan browser warning (only for browsers) | Re-run `ngrok http --url=<domain> <port>`; check `ngrok` is pointed at the right port. Server-to-server POSTs don't get the warning page. |
| Signed message → **401** | Signature computed over parsed/re-serialised JSON, wrong secret, or header read wrong | HMAC the **raw bytes**. Confirm the env var is loaded (log its length, never the value). Header is `X-Super-Signature`, value `sha256=<hex>`. |
| Wrong signature → **200** (Verify signature fails) | Signature not checked, or checked but not enforced | Return 401 before doing anything when verification fails. |
| Every POST → **503** `signing_secret_not_configured` | `AGENTRY_WEBHOOK_SECRET` not set in the running process | Set it and restart. On a host, set it in the host's env settings, then redeploy/restart. |
| Signed message → **timeout** (> 8 s) | The turn runs before the response is sent | Return 200 first; move the turn to a background task. |
| 2xx but **no reply** ever arrives | Background work dropped (serverless freeze), exception swallowed, wrong `reply_url`/token | Log every reply attempt + status. Serverless: `waitUntil`/background function. Don't rewrite `reply_url`. |
| Reply → **400 `from_invalid`** | `from` missing, or `from.kind` isn't `"agent"` | `"from": {"kind":"agent","id":"<payload.agent_id>"}`. |
| Reply → **400 `id_missing` / `timestamp_missing` / `chat_id_missing`** | Envelope incomplete | Every reply envelope needs `type`, `id`, `chat_id`, `from`, `timestamp` (+ `content` for messages). |
| Reply → **400 `content_kind_invalid`** | Unsupported `content.kind` or a typo | Use a kind from protocol.md. When unsure, `text`. |
| Reply → **401 `invalid_or_expired_reply_token`** | Token older than 10 min, or token from another chat | Reply within 10 min of the message; for later sends use the proactive endpoint. |
| Reply → **403 `agent_media_image_not_enabled`** (or audio/document) | Output switch off in the console's Chat step | Turn the switch on in the console, or send text. |
| Reply → **410 `chat_expired`** | The user removed the agent | Drop the turn; stop anything scheduled for that chat. |
| The agent forgets earlier messages | No per-chat memory — Agentry sends one message at a time | Store history keyed by `chat_id` (protocol §5). |
| Same message answered twice | No de-dupe on `envelope.id`; retries after a slow ack | Keep a seen-ids set; answer 200 to a repeat without re-running. |
| Typing dots never go away | `typing_stop` not sent on the error path | Send `typing_stop` in a `finally`. |
| Works locally, fails deployed | Secret/env not set on the host, port binding, or proxy strips the body | Bind `0.0.0.0` and the host's `$PORT`; set env on the host; make sure no middleware reads the body before the webhook route. |
| Image/voice/PDF arrives but the agent can't open it | URL expired (1 h), or not downloaded | Download inside the turn, don't store URLs. |
