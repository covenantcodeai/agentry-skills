# Agentry webhook protocol — what the server must do

This is the contract between Agentry and the publisher's server. Everything in the "Required"
section must be true before the URL goes into the Agentry console. Source of truth on the platform
side: `docs/CHAT_PROTOCOL.md` in the Agentry backend — if this file and that one ever disagree,
that one wins and this one is out of date.

## The whole loop in one picture

```
user's phone ──WS──▶ Agentry ──POST (signed)──▶ your webhook URL
                                   ◀── 200 within 8 s ──┘   (ack only — no answer in this response)
                                                            │ later, in the background
your server ──POST {reply_url}, Bearer {reply_token}──▶ Agentry ──▶ user's phone
             (typing_start … message … typing_stop)
```

Two endpoints on the publisher's server, nothing else:

| Endpoint | Purpose |
|---|---|
| `POST <webhook path>` (e.g. `/agentry/webhook`) | Receives every event. Verifies the signature, answers 200 fast, does the work later. |
| `GET /health` **at the origin** (not under the webhook path) | Liveness. Any 2xx. Agentry calls `https://<host>/health?agent_id=<id>` every 10 s while the agent is live, and the console's **Check connection** button calls it once. |

`/health` must be at the root of the host because Agentry throws away the webhook URL's path
and keeps only the origin. If the app is mounted under a prefix (`/api`), add `/health` at the
root anyway, or the check fails.

---

## Required

### 1. Verify the signature on the raw body

Every POST from Agentry carries:

```
X-Super-Signature: sha256=<lowercase hex HMAC-SHA256 of the raw request body, keyed with the signing secret>
Content-Type: application/json
```

- Compute the HMAC over the **exact bytes received**, before any JSON parsing. Re-serialising a
  parsed object changes whitespace/key order and the signature will never match. This is the
  single most common failure — every framework note in `stacks/` shows how to get the raw body.
- Compare in constant time (`crypto.timingSafeEqual`, `hmac.compare_digest`, `hmac.Equal`).
- Header names are case-insensitive; most frameworks lowercase them (`x-super-signature`).
- **Missing or wrong signature → `401`**, and do nothing else. Agentry's console proves this by
  sending one deliberately wrong signature during setup and expecting a 401.
- **Secret not configured yet → `503`** for every POST (`{"error":"signing_secret_not_configured"}`).
  Never accept unsigned traffic "until the secret arrives". `/health` keeps answering 200 so the
  console's Check connection still passes before the secret exists.
- Read the secret from the env var **`AGENTRY_WEBHOOK_SECRET`** (use the project's existing env
  convention if it has a prefix scheme, but keep the name recognisable). Never hard-code it,
  never commit it, never log it.

### 2. Answer `200` within 8 seconds — then do the work

Agentry waits **8 seconds** for a 2xx, then retries (up to 3 attempts on 5xx/timeouts). So:

- Return `200` (body `{"ok":true}` is fine) **as soon as the signature checks out and the body
  parses**. Do not call the model, a database-heavy tool or anything slow before returning.
- Run the actual agent turn in the background (task queue, `setImmediate`, `BackgroundTasks`,
  goroutine, a job runner — whatever the stack uses).
- The answer never goes in the HTTP response. It goes to `reply_url` (§4).
- **Serverless platforms freeze the function the moment the response is sent.** On Vercel use
  `waitUntil` from `@vercel/functions`; on Cloudflare Workers `ctx.waitUntil`; on Netlify a
  background function; on AWS Lambda hand the work to an async invoke/SQS. A plain
  fire-and-forget promise there silently never sends the reply. See `deploy.md`.

### 3. Handle every event type

The body of every POST:

```jsonc
{
  "agent_id": "…",                       // this agent's id on Agentry
  "user": {
    "id": "…",                           // stable per user
    "display_name": "Alex",              // may be null
    "timezone": "Asia/Kolkata",          // IANA zone or null (unknown → use UTC)
    "utc_offset": "+05:30",              // or null
    "utc_offset_minutes": 330            // or null
  },
  "reply_url": "https://…/chats/<chat_id>/reply",   // absent on install/uninstall/ping
  "reply_token": "rtok_…",                          // absent on install/uninstall/ping
  "settings": { "Model": "Fast", "Language": "English" },  // {} when the agent has no dropdowns
  "envelope": { "type": "message", "id": "msg_…", "chat_id": "…", "from": { "kind": "user", "id": "…" },
                "timestamp": "2026-11-15T10:00:00Z", "content": { "kind": "text", "text": "Hello" } }
}
```

| `envelope.type` | What to do |
|---|---|
| `message` | Run a turn (§5) and reply via `reply_url`. |
| `typing_start` / `typing_stop` | The *user* is typing. Answer 200 and ignore (or use as a hint). No reply. |
| `install` | A user added the agent. 200. Optional: send a welcome via the proactive endpoint (§7). No `reply_url`. |
| `uninstall` | A user removed it. 200. Stop anything scheduled for that `chat_id`. Best-effort — also treat a `404` from §7 as "chat gone". |
| `ping` | Setup check from the console. 200, nothing else. |
| anything else | **200 and ignore.** New types get added; an unknown type must never 4xx/5xx. |

**De-duplicate on `envelope.id`.** Retries resend the same id. Keep a short-lived set (an
in-memory LRU of the last few thousand ids is enough for one process; use Redis/the DB if the
app runs several instances) and answer 200 without re-running the turn on a repeat.

### 4. Reply through `reply_url`

```
POST {reply_url}
Authorization: Bearer {reply_token}
Content-Type: application/json

{ "envelope": { … }, "usage": { … optional, §6 … } }
```

Reply envelope — every field below is required:

```jsonc
{
  "type": "message",                       // or "typing_start" / "typing_stop"
  "id": "msg_<unique>",                    // generate one per event (uuid/ulid); used for dedupe + billing
  "chat_id": "<the incoming envelope.chat_id>",
  "from": { "kind": "agent", "id": "<payload.agent_id>" },
  "in_reply_to": "<incoming envelope.id>", // optional, messages only
  "timestamp": "2026-11-15T10:00:03Z",     // RFC 3339 UTC
  "content": { "kind": "text", "text": "Hi!" }   // messages only
}
```

The order for every user message:

1. `typing_start` (add `"expires_at"`: now + 10 s — the indicator auto-clears if you crash).
   Long turns: re-send `typing_start` every ~8 s so the indicator stays up.
2. Run the turn.
3. `message` with the answer (one or more messages are fine).
4. `typing_stop`.
5. On failure: still send `typing_stop`, and send a short, human `message` ("Sorry — something
   went wrong on my side. Please try again.") rather than going silent. Log the real error.

- The token is valid for **10 minutes** and for **every** event in that chat in that window
  (typing + message + more messages). It is not single-use. After 10 minutes use the
  proactive endpoint (§7).
- Responses: `200 {"ok":true}`. `400 <reason>` = the envelope is malformed (the reason names the
  field: `id_missing`, `from_invalid`, `content_kind_invalid` …). `401` = token missing/expired.
  `403 agent_media_*_not_enabled` = an image/audio/document reply while that output switch is
  off in the console. `410 chat_expired` = the user removed the agent. Log non-2xx bodies — they
  say exactly what's wrong.
- Retry a reply only on network errors/5xx, with the **same** envelope id (billing is idempotent
  on it).

### 5. Conversation memory is the server's job

**Agentry sends one message at a time and never the history.** Chat history lives only on the
user's phone. If the agent needs earlier turns (almost every LLM agent does), keep them yourself,
keyed by `envelope.chat_id`:

- Local/dev: an in-memory map is acceptable — say so to the user, it resets on restart.
- Deployed: the project's database, Redis, or a file store. Cap it (e.g. last 20–40 turns).
- `chat_id` is stable per (user, agent install). `user.id` is stable per user across chats.

### 6. Report model usage (recommended)

Add a top-level `usage` object next to `envelope` on the reply that carries the answer:

```json
{ "envelope": { … }, "usage": { "model": "gemini-2.5-flash", "input_tokens": 1234, "output_tokens": 567 } }
```

- `model` is the provider's model id, verbatim. An id Agentry doesn't price falls back to the
  flat per-message rate — never an error.
- `input_tokens` = total input. Optional subsets: `cached_input_tokens`, `audio_input_tokens`
  (parts of the total, not additions). **Reasoning/thinking tokens count as output.**
- Never put `usage` on typing events, never inside the envelope. Malformed usage is ignored.
- If the project can't get token counts, omit `usage` entirely.

---

## Content kinds

### What the agent receives (`envelope.content.kind`)

| kind | Shape | Notes |
|---|---|---|
| `text` | `{ text }` | What the user typed. Plain text, never markdown-parsed. |
| `image` | `{ url, mime_type, caption? }` | Only if **Photos** is on in the console. |
| `images` | `{ images: [{url, mime_type}], caption? }` | 2–10 photos sent together. |
| `audio` | `{ url, mime_type, duration_seconds }` | Voice note, `audio/mp4` (AAC). Only if **Voice notes** is on. |
| `document` | `{ url, mime_type, filename, size_bytes, caption? }` | PDF. Only if **PDFs** is on. |
| `action` | `{ action: { type: "button", id, label } }` or `{ action: { type: "form", values } }` | The user tapped a button / submitted a form the agent sent. `in_reply_to` names that message. |

Media `url`s are presigned and **expire after 1 hour** — download inside the turn, never store
the URL.

### What the agent can send

| kind | Shape |
|---|---|
| `text` | `{ text }` — rendered as Markdown (headings, bold, lists, tables, code, links). A single newline is a line break. |
| `buttons` | `{ text, buttons: [{ id, label, style?, url? }] }` — `style`: primary/secondary/destructive. A `url` button opens the browser and sends nothing back. |
| `list` | `{ title?, items: [{ id, label, sublabel? }] }` |
| `card` | `{ title, subtitle?, image?, body?, actions?: [same as buttons] }` |
| `carousel` | `{ text?, cards: [card …] }` — 1–10 cards, ≤2 buttons each. Needs a 2026-10+ app. |
| `form` | `{ submit_label, fields: [{ id, label, type, required?, options?, default? }] }` — types: text, textarea, number, select, multiselect, date, daterange, toggle. |
| `image` / `images` / `image_carousel` | Needs the **Images** output switch. |
| `audio` | Needs the **Audio** output switch. |
| `document` | Needs the **Documents** output switch. |

Only `http`, `https`, `mailto`, `tel` links open. Plain `text` is always safe — use the rich
kinds only where the agent's UX clearly benefits.

---

## Optional

### 7. Proactive messages (agent speaks first)

For reminders, digests, follow-ups after the 10-minute reply window, or a welcome on `install`:

```
POST https://agentry-api.covenantcode.tech/agents/<agent_id>/messages
X-Super-Signature: sha256=<HMAC of this request's raw body with the same signing secret>
Content-Type: application/json

{ "target_chat_id": "<chat_id>", "idempotency_key": "<unique per logical send>",
  "envelope": { "type": "message", "id": "msg_…", "chat_id": "<chat_id>",
                "from": { "kind": "agent", "id": "<agent_id>" }, "timestamp": "…",
                "content": { "kind": "text", "text": "Your daily summary is ready." } },
  "usage": { … optional … } }
```

- Limit: 20 per (agent, user) per day → `429`. `402` = the user is out of credits.
- `200 {"suppressed": true}` = the user turned proactive messages off for this agent. Treat as
  success; do not retry.
- **`404` = the chat is gone. Stop scheduling against that `chat_id`.**

### 8. Settings dropdowns

Publishers can add up to 3 dropdowns in the console (e.g. *Model*, *Language*). Each message
carries `settings: { "<title>": "<selected option label>" }`, labels verbatim. Map labels to
real values in code (`{"Fast": "gemini-2.5-flash", …}`) and fall back to a default when a key is
missing.

### 9. Timezone

Use `user.timezone` for anything time-related ("remind me at 9"). `null` → UTC, and say so if it
matters to the answer.
