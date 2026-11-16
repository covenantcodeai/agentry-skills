#!/usr/bin/env node
// Agentry webhook check: runs the bundled Postman collection against a webhook (via Newman, fetched
// with npx), stands in for Agentry's reply_url with a local receiver, and prints one pass/fail table.
//
//   node scripts/check.mjs --url http://localhost:3000/agentry/webhook --secret local-test-secret
//
// Options:
//   --url <webhook url>      required
//   --secret <secret>        required — the same value the server has in AGENTRY_WEBHOOK_SECRET
//   --health <url>           default: <origin of --url>/health
//   --timeout <seconds>      how long to wait for the agent's reply (default 30)
//   --port <n>               local reply receiver port (default 4599)
//   --no-reply               don't wait for a reply (a remote server can't reach this machine)
//
// Exit code 0 when everything passed, 1 otherwise. Needs Node 18+ and npx (ships with npm).
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const COLLECTION = join(here, '..', 'assets', 'agentry.postman_collection.json');
const ENVIRONMENT = join(here, '..', 'assets', 'agentry.postman_environment.json');
const NEWMAN = 'newman@6';

// ── args ──
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};
const url = opt('url');
const secret = opt('secret');
if (!url || !secret) {
  console.error('Usage: node scripts/check.mjs --url <webhook url> --secret <secret> [--health <url>] [--timeout 30] [--no-reply]');
  process.exit(2);
}
let health;
try {
  health = opt('health', `${new URL(url).origin}/health`);
} catch {
  console.error(`Not a URL: ${url}`);
  process.exit(2);
}
const waitReply = !flag('no-reply');
const timeoutMs = Number(opt('timeout', '30')) * 1000;
const port = Number(opt('port', '4599'));
const runId = 'chk' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const chatId = `chat_${runId}`;
const agentId = 'agt_check';

// ── the reply receiver: validates exactly like Agentry's reply endpoint ──
const REPLY_TYPES = new Set(['message', 'typing_start', 'typing_stop']);
const REPLY_KINDS = new Set(['text', 'list', 'buttons', 'image', 'images', 'image_carousel', 'audio', 'document', 'card', 'carousel', 'form', 'checklist', 'action']);
const events = []; // { at, type, id, in_reply_to, status, error, usageNote }

function validate(env, pathChatId) {
  if (!env || typeof env !== 'object') return 'envelope_missing';
  if (!REPLY_TYPES.has(env.type)) return 'type_invalid';
  if (typeof env.id !== 'string' || !env.id) return 'id_missing';
  if (typeof env.chat_id !== 'string' || !env.chat_id) return 'chat_id_missing';
  if (!env.from || env.from.kind !== 'agent' || typeof env.from.id !== 'string') return 'from_invalid';
  if (typeof env.timestamp !== 'string') return 'timestamp_missing';
  if (env.type === 'message') {
    if (!env.content || typeof env.content !== 'object') return 'content_missing';
    if (!REPLY_KINDS.has(env.content.kind)) return 'content_kind_invalid';
  }
  if (env.chat_id !== pathChatId) return 'chat_id_does_not_match_reply_url';
  return null;
}

function usageNote(usage, type) {
  if (usage === undefined) return null;
  if (type !== 'message') return 'usage sent on a typing event (ignored by Agentry)';
  const int = (v) => Number.isInteger(v) && v >= 0;
  if (!usage || typeof usage !== 'object') return 'usage is not an object (ignored → flat rate)';
  if (typeof usage.model !== 'string' || !usage.model) return 'usage.model missing (ignored → flat rate)';
  if (!int(usage.input_tokens) || !int(usage.output_tokens)) return 'usage tokens must be non-negative integers (ignored → flat rate)';
  const parts = (usage.audio_input_tokens ?? 0) + (usage.cached_input_tokens ?? 0);
  if (parts > usage.input_tokens) return 'audio + cached exceed input_tokens — they are parts of it (ignored → flat rate)';
  return 'ok';
}

const server = createServer((req, res) => {
  const m = req.method === 'POST' && req.url.match(/^\/chats\/([^/?]+)\/reply/);
  if (!m) {
    res.writeHead(404).end();
    return;
  }
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const answer = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    };
    const pathChat = decodeURIComponent(m[1]);
    const auth = req.headers.authorization || '';
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      events.push({ at: Date.now(), type: '?', status: 400, error: 'body is not JSON' });
      return answer(400, { error: 'invalid_json' });
    }
    const env = body?.envelope;
    const rec = { at: Date.now(), type: env?.type, id: env?.id, in_reply_to: env?.in_reply_to, fromId: env?.from?.id };
    if (!auth.startsWith('Bearer ')) Object.assign(rec, { status: 401, error: 'missing_reply_token' });
    else if (auth.slice(7).trim() !== `rtok_${runId}`) Object.assign(rec, { status: 401, error: 'invalid_or_expired_reply_token (send the reply_token from the payload)' });
    else {
      const err = validate(env, pathChat);
      if (err) Object.assign(rec, { status: 400, error: err });
      else Object.assign(rec, { status: 200, usageNote: usageNote(body.usage, env.type) });
    }
    events.push(rec);
    answer(rec.status, rec.status === 200 ? { ok: true } : { error: rec.error });
  });
});

// ── newman ──
function runNewman() {
  const dir = mkdtempSync(join(tmpdir(), 'agentry-check-'));
  const envFile = join(dir, 'env.json');
  const reportFile = join(dir, 'report.json');
  const env = JSON.parse(readFileSync(ENVIRONMENT, 'utf8'));
  const set = {
    webhook_url: url,
    health_url: health,
    webhook_secret: secret,
    reply_base: `http://127.0.0.1:${port}`,
    agent_id: agentId,
    run_id: runId,
    keep_run_id: '1',
  };
  for (const [key, value] of Object.entries(set)) {
    const row = env.values.find((v) => v.key === key);
    if (row) row.value = value;
    else env.values.push({ key, value, enabled: true });
  }
  writeFileSync(envFile, JSON.stringify(env));
  const args = ['-y', NEWMAN, 'run', COLLECTION, '-e', envFile, '--reporters', 'json', '--reporter-json-export', reportFile, '--timeout-request', '15000', '--suppress-exit-code'];
  // Every argument is a temp/skill path or a fixed token (the secret and URL travel in the env
  // file), so quoting paths is all the Windows shell needs.
  const win = process.platform === 'win32';
  const cmd = win ? 'npx.cmd' : 'npx';
  return new Promise((resolve) => {
    const child = win
      ? spawn([cmd, ...args].map((a) => (/[\s&()^%!"]/.test(a) ? `"${a}"` : a)).join(' '), { stdio: ['ignore', 'ignore', 'pipe'], shell: true })
      : spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => resolve({ error: `could not start npx: ${e.message}` }));
    child.on('close', () => {
      try {
        const report = JSON.parse(readFileSync(reportFile, 'utf8'));
        resolve({ report });
      } catch {
        resolve({ error: `newman did not produce a report.\n${stderr.trim().slice(-1500)}` });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
}

// ── run ──
const rows = []; // [ok: true|false|null(skip/warn), check, detail]
const row = (ok, check, detail = '') => rows.push([ok, check, detail]);

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, '127.0.0.1', resolve);
}).catch((e) => {
  console.error(`Can't start the reply receiver on 127.0.0.1:${port} (${e.code || e.message}). Pick another with --port.`);
  process.exit(2);
});

console.log(`Checking ${url}\n  health: ${health}\n  run: ${runId}\n`);

// Nothing listening at all is the most common first failure — say so plainly instead of ten red rows.
try {
  await fetch(health, { signal: AbortSignal.timeout(8000) });
} catch (e) {
  const code = e.cause?.code || e.name;
  console.log(`FAIL  Can't reach ${health} (${code}).`);
  console.log(code === 'ENOTFOUND' ? "      The host name doesn't resolve — check the URL." : '      Is the server running on that port? If you use a tunnel, is it up?');
  server.close();
  process.exit(1);
}
console.log('(the first run downloads Newman via npx — a few seconds)\n');
const { report, error } = await runNewman();
if (error) {
  console.error(error);
  server.close();
  process.exit(1);
}

for (const ex of report.run.executions) {
  const name = ex.item.name;
  const code = ex.response?.code;
  const ms = ex.response?.responseTime;
  if (ex.requestError) {
    row(false, name, `request failed: ${ex.requestError.message || ex.requestError.code}`);
    continue;
  }
  for (const a of ex.assertions || []) {
    row(!a.error, a.assertion, `${code ?? '—'}${ms != null ? ` in ${ms} ms` : ''}${a.error ? ` — ${a.error.message}` : ''}`);
  }
}

if (waitReply) {
  const messageId = `msg_${runId}`;
  const deadline = Date.now() + timeoutMs;
  const done = () => events.some((e) => e.type === 'typing_stop' && e.status === 200 && events.some((m) => m.type === 'message' && m.status === 200 && m.at <= e.at));
  while (Date.now() < deadline && !done()) await new Promise((r) => setTimeout(r, 250));
  await new Promise((r) => setTimeout(r, 2000)); // catch a late duplicate answer

  const ok = events.filter((e) => e.status === 200);
  const msgs = ok.filter((e) => e.type === 'message');
  const firstMsg = msgs[0];
  const starts = ok.filter((e) => e.type === 'typing_start');
  const stops = ok.filter((e) => e.type === 'typing_stop');
  // One row per distinct rejection, not per event — a broken envelope fails every reply the same way.
  const rejected = new Map();
  for (const e of events.filter((x) => x.status !== 200)) {
    const key = `${e.status} ${e.error}`;
    const g = rejected.get(key) || { n: 0, types: new Set() };
    g.n += 1;
    g.types.add(e.type || '?');
    rejected.set(key, g);
  }
  for (const [key, g] of rejected) row(false, 'replies accepted by reply_url', `${key} — ${g.n}× (${[...g.types].join(', ')})`);
  const t0 = starts[0]?.at;
  row(!!firstMsg, 'reply message arrived at reply_url', firstMsg ? (t0 ? `${((firstMsg.at - t0) / 1000).toFixed(1)} s after typing_start` : '') : `nothing within ${timeoutMs / 1000} s — check the server log`);
  if (firstMsg) {
    row(firstMsg.fromId === agentId, 'reply from.id is the payload agent_id', firstMsg.fromId === agentId ? '' : `got ${JSON.stringify(firstMsg.fromId)}`);
    row(!firstMsg.in_reply_to || firstMsg.in_reply_to === messageId, 'in_reply_to names the user message', firstMsg.in_reply_to ? '' : 'not set (optional)');
    row(starts.length > 0 && starts[0].at <= firstMsg.at, 'typing_start sent before the answer', starts.length ? '' : 'none sent');
    row(stops.some((s) => s.at >= firstMsg.at), 'typing_stop sent after the answer', stops.length ? '' : 'none sent');
    const answers = msgs.filter((e) => !e.in_reply_to || e.in_reply_to === messageId);
    row(answers.length === 1, 'retried message answered once (de-dupe on envelope.id)', answers.length === 1 ? '' : `${answers.length} answers`);
    const u = firstMsg.usageNote;
    row(u === null ? null : u === 'ok', 'usage block', u === null ? 'not sent (optional — flat per-message rate applies)' : u === 'ok' ? 'valid' : u);
  }
} else {
  row(null, 'reply round trip', 'skipped (--no-reply) — proven in the console\'s First contact step');
}

server.close();

// ── table ──
const mark = (ok) => (ok === true ? 'PASS' : ok === false ? 'FAIL' : 'NOTE');
const w = Math.max(...rows.map((r) => r[1].length));
console.log(`${'RESULT'.padEnd(6)}  ${'CHECK'.padEnd(w)}  DETAIL`);
for (const [ok, check, detail] of rows) console.log(`${mark(ok).padEnd(6)}  ${check.padEnd(w)}  ${detail}`);
const failed = rows.filter((r) => r[0] === false).length;
console.log(`\n${failed ? `${failed} failed` : 'All checks passed'} (${rows.filter((r) => r[0] === true).length} passed${rows.some((r) => r[0] === null) ? `, ${rows.filter((r) => r[0] === null).length} notes` : ''}).`);
if (failed) console.log('See references/troubleshooting.md for what each failure usually means.');
process.exit(failed ? 1 : 0);
