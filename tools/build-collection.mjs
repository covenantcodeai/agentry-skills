// Regenerates skills/agentry-webhook/assets/agentry.postman_collection.json and the environment.
// The collection is generated rather than hand-edited so every signed request carries the same
// signing script. Run: node tools/build-collection.mjs
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const assets = join(here, '..', 'skills', 'agentry-webhook', 'assets');

// Signs the exact bytes that will be sent: resolve {{variables}} first, freeze the body, then
// HMAC it with the secret — the same thing Agentry does.
const SIGN = [
  'const body = pm.variables.replaceIn(pm.request.body.raw);',
  "pm.request.body.update({ mode: 'raw', raw: body, options: { raw: { language: 'json' } } });",
  "const secret = pm.variables.get('webhook_secret') || '';",
  'const sig = CryptoJS.HmacSHA256(body, secret).toString(CryptoJS.enc.Hex);',
  "pm.request.headers.upsert({ key: 'X-Super-Signature', value: 'sha256=' + sig });",
];

const WRONG_SIGN = [
  'const body = pm.variables.replaceIn(pm.request.body.raw);',
  "pm.request.body.update({ mode: 'raw', raw: body, options: { raw: { language: 'json' } } });",
  "pm.request.headers.upsert({ key: 'X-Super-Signature', value: 'sha256=' + '0'.repeat(64) });",
];

const NO_SIGN = [
  'const body = pm.variables.replaceIn(pm.request.body.raw);',
  "pm.request.body.update({ mode: 'raw', raw: body, options: { raw: { language: 'json' } } });",
  "pm.request.headers.remove('X-Super-Signature');",
];

const user = '"user":{"id":"{{user_id}}","display_name":"Agentry Test","timezone":"Asia/Kolkata","utc_offset":"+05:30","utc_offset_minutes":330}';
const head = (type) => `"agent_id":"{{agent_id}}",${user}`;
const from = '"from":{"kind":"user","id":"{{user_id}}"}';
const replyBits = '"reply_url":"{{reply_base}}/chats/chat_{{run_id}}/reply","reply_token":"rtok_{{run_id}}","settings":{}';

const bodies = {
  message: `{${head()},${replyBits},"envelope":{"type":"message","id":"msg_{{run_id}}","chat_id":"chat_{{run_id}}",${from},"timestamp":"{{now_iso}}","content":{"kind":"text","text":"{{test_message}}"}}}`,
  typing: `{${head()},${replyBits},"envelope":{"type":"typing_start","id":"evt_typing_{{run_id}}","chat_id":"chat_{{run_id}}",${from},"timestamp":"{{now_iso}}","expires_at":"{{now_iso}}"}}`,
  install: `{${head()},"settings":{},"envelope":{"type":"install","id":"evt_install_{{run_id}}","chat_id":"chat_{{run_id}}",${from},"timestamp":"{{now_iso}}"}}`,
  ping: `{${head()},"settings":{},"envelope":{"type":"ping","id":"evt_ping_{{run_id}}","chat_id":"chat_{{run_id}}",${from},"timestamp":"{{now_iso}}"}}`,
  unknown: `{${head()},"settings":{},"envelope":{"type":"some_future_event","id":"evt_future_{{run_id}}","chat_id":"chat_{{run_id}}",${from},"timestamp":"{{now_iso}}"}}`,
  badSig: `{${head()},${replyBits},"envelope":{"type":"message","id":"msg_forged_{{run_id}}","chat_id":"chat_{{run_id}}",${from},"timestamp":"{{now_iso}}","content":{"kind":"text","text":"This request has a wrong signature and must be refused."}}}`,
  noSig: `{${head()},${replyBits},"envelope":{"type":"message","id":"msg_unsigned_{{run_id}}","chat_id":"chat_{{run_id}}",${from},"timestamp":"{{now_iso}}","content":{"kind":"text","text":"This request has no signature and must be refused."}}}`,
};

const tests = {
  ok: (what) => [
    `pm.test('${what} → 2xx', () => pm.expect(pm.response.code).to.be.within(200, 299));`,
  ],
  fast: [
    "pm.test('message → 2xx', () => pm.expect(pm.response.code).to.be.within(200, 299));",
    "pm.test('message answered within 8 s', () => pm.expect(pm.response.responseTime).to.be.below(8000));",
  ],
  refused: (what) => [
    `pm.test('${what} → 401', () => pm.expect(pm.response.code).to.equal(401));`,
  ],
};

const post = (name, description, body, prerequest, test) => ({
  name,
  event: [
    { listen: 'prerequest', script: { type: 'text/javascript', exec: prerequest } },
    { listen: 'test', script: { type: 'text/javascript', exec: test } },
  ],
  request: {
    method: 'POST',
    header: [{ key: 'Content-Type', value: 'application/json' }],
    body: { mode: 'raw', raw: body, options: { raw: { language: 'json' } } },
    url: '{{webhook_url}}',
    description,
  },
});

const collection = {
  info: {
    name: 'Agentry webhook check',
    description:
      'Sends what Agentry sends to a webhook agent and checks the answers. Set webhook_url, health_url and webhook_secret in the environment. Run the whole collection; replies the agent posts to reply_url go to {{reply_base}} — the skill\'s scripts/check.mjs runs a receiver there and checks them.',
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  event: [
    {
      listen: 'prerequest',
      script: {
        type: 'text/javascript',
        exec: [
          "pm.variables.set('now_iso', new Date().toISOString());",
          '// A fresh run id per run, so the server\'s de-dupe doesn\'t swallow a re-run. check.mjs pins it.',
          "if (pm.info.requestName === 'Health' && !pm.variables.get('keep_run_id')) {",
          "  pm.environment.set('run_id', Date.now().toString(36) + Math.random().toString(36).slice(2, 6));",
          '}',
        ],
      },
    },
  ],
  item: [
    {
      name: 'Health',
      event: [{ listen: 'test', script: { type: 'text/javascript', exec: tests.ok('GET /health') } }],
      request: { method: 'GET', header: [], url: '{{health_url}}', description: 'Agentry calls <origin>/health; any 2xx passes.' },
    },
    post('Missing signature', 'No X-Super-Signature header. Must be refused with 401.', bodies.noSig, NO_SIGN, tests.refused('missing signature')),
    post('Wrong signature', 'A well-formed but wrong signature. Must be refused with 401.', bodies.badSig, WRONG_SIGN, tests.refused('wrong signature')),
    post('Ping', 'Setup check the console sends. 2xx, nothing else.', bodies.ping, SIGN, tests.ok('ping')),
    post('Install', 'A user added the agent. 2xx; no reply_url.', bodies.install, SIGN, tests.ok('install event')),
    post('User typing', 'The user is typing. 2xx, no reply.', bodies.typing, SIGN, tests.ok('user typing event')),
    post('Unknown event type', 'Future event types must be acknowledged, not rejected.', bodies.unknown, SIGN, tests.ok('unknown event type')),
    post('Message', 'A real user message. 2xx within 8 s; the answer goes to reply_url afterwards.', bodies.message, SIGN, tests.fast),
    post('Message again (retry)', 'The same envelope id again, as a retry. 2xx, and the agent must not answer twice.', bodies.message, SIGN, tests.ok('retried message')),
  ],
};

const environment = {
  name: 'Agentry webhook — local',
  values: [
    ['webhook_url', 'http://localhost:3000/agentry/webhook'],
    ['health_url', 'http://localhost:3000/health'],
    ['webhook_secret', 'local-test-secret'],
    ['reply_base', 'http://127.0.0.1:4599'],
    ['agent_id', 'agt_check'],
    ['user_id', 'usr_check'],
    ['test_message', 'Hi! This is a setup check from Agentry. Please reply with a short greeting.'],
    ['run_id', ''],
  ].map(([key, value]) => ({ key, value, enabled: true, ...(key === 'webhook_secret' ? { type: 'secret' } : {}) })),
};

writeFileSync(join(assets, 'agentry.postman_collection.json'), JSON.stringify(collection, null, 2) + '\n');
writeFileSync(join(assets, 'agentry.postman_environment.json'), JSON.stringify(environment, null, 2) + '\n');
console.log('wrote', join(assets, 'agentry.postman_collection.json'));
