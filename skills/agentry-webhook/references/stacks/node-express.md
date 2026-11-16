# Node.js — Express (also the pattern for Koa/Hono/plain `http`)

Zero new dependencies: `crypto` and global `fetch` (Node 18+). Put this in its own file (e.g.
`src/agentry.js`) and mount it on the existing app. Replace only `runAgent` with a call into the
project's real agent.

**Raw body:** mount the webhook route with `express.raw({ type: '*/*' })` **before** any global
`express.json()` sees it — register it before `app.use(express.json())`, or the body is already
parsed and the HMAC can't be checked.

```js
// agentry.js — Agentry webhook adapter
const crypto = require('crypto');
const express = require('express');

const SECRET = () => process.env.AGENTRY_WEBHOOK_SECRET || '';
const seen = new Map(); // envelope.id -> time, for retry de-dupe
const histories = new Map(); // chat_id -> [{role, content}] — in-memory: resets on restart

function verify(raw, header) {
  if (!header || !SECRET()) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', SECRET()).update(raw).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(header));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function firstTime(id) {
  const now = Date.now();
  if (seen.size > 5000) for (const [k, t] of seen) if (now - t > 3600_000 || seen.size > 4000) seen.delete(k);
  if (seen.has(id)) return false;
  seen.set(id, now);
  return true;
}

const newId = (p) => `${p}_${crypto.randomUUID()}`;

async function send(payload, envelope, usage) {
  const res = await fetch(payload.reply_url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${payload.reply_token}` },
    body: JSON.stringify(usage ? { envelope, usage } : { envelope }),
  });
  if (!res.ok) console.error('[agentry] reply', envelope.type, res.status, await res.text().catch(() => ''));
  return res.ok;
}

const base = (payload, type) => ({
  type,
  id: newId(type === 'message' ? 'msg' : 'evt'),
  chat_id: payload.envelope.chat_id,
  from: { kind: 'agent', id: payload.agent_id },
  timestamp: new Date().toISOString(),
});

const typing = (payload, type) =>
  send(payload, { ...base(payload, type), ...(type === 'typing_start' ? { expires_at: new Date(Date.now() + 10_000).toISOString() } : {}) });

async function runTurn(payload) {
  const env = payload.envelope;
  const chatId = env.chat_id;
  await typing(payload, 'typing_start');
  const keepTyping = setInterval(() => typing(payload, 'typing_start').catch(() => {}), 8000);
  try {
    const history = histories.get(chatId) || [];
    const text = env.content?.kind === 'text' ? env.content.text
      : env.content?.kind === 'action' ? (env.content.action.label || JSON.stringify(env.content.action.values))
      : env.content?.caption || `[${env.content?.kind}]`;

    // ⬇ Call the project's real agent here.
    const result = await runAgent({ text, content: env.content, history, settings: payload.settings || {}, user: payload.user, chatId });
    // runAgent returns { text, usage?: { model, input_tokens, output_tokens } }

    histories.set(chatId, [...history, { role: 'user', content: text }, { role: 'assistant', content: result.text }].slice(-40));
    await send(
      payload,
      { ...base(payload, 'message'), in_reply_to: env.id, content: { kind: 'text', text: result.text } },
      result.usage
    );
  } catch (err) {
    console.error('[agentry] turn failed', err);
    await send(payload, { ...base(payload, 'message'), in_reply_to: env.id, content: { kind: 'text', text: 'Sorry — something went wrong on my side. Please try again.' } }).catch(() => {});
  } finally {
    clearInterval(keepTyping);
    await typing(payload, 'typing_stop').catch(() => {});
  }
}

function handle(payload) {
  switch (payload.envelope?.type) {
    case 'message':
      return runTurn(payload);
    case 'install':
    case 'uninstall':
    case 'typing_start':
    case 'typing_stop':
    case 'ping':
    default:
      return; // acknowledged, nothing to do
  }
}

const router = express.Router();
router.post('/agentry/webhook', express.raw({ type: '*/*', limit: '2mb' }), (req, res) => {
  if (!SECRET()) return res.status(503).json({ error: 'signing_secret_not_configured' });
  const raw = req.body; // Buffer
  if (!Buffer.isBuffer(raw) || !verify(raw, req.get('x-super-signature'))) return res.status(401).json({ error: 'bad_signature' });
  let payload;
  try {
    payload = JSON.parse(raw.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'invalid_json' });
  }
  const id = payload?.envelope?.id;
  if (id && !firstTime(id)) return res.json({ ok: true, duplicate: true });
  res.json({ ok: true }); // ack first …
  setImmediate(() => Promise.resolve(handle(payload)).catch((e) => console.error('[agentry]', e))); // … then work
});

module.exports = { agentryRouter: router };
```

Mount it (top of the server file, before body parsers):

```js
const { agentryRouter } = require('./agentry');
app.get('/health', (_req, res) => res.json({ ok: true }));   // root of the host
app.use(agentryRouter);                                        // before app.use(express.json())
```

ESM projects: same code with `import crypto from 'node:crypto'` / `export`.

**Media in:** `env.content.url` (image/audio/document) and `env.content.images[].url` are 1-hour
links — `await fetch(url)` → `arrayBuffer()` inside `runAgent` and pass the bytes/base64 to the
model.

**Several instances (cluster, multiple pods):** move `seen` and `histories` to Redis/the DB.
