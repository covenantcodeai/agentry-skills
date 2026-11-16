# Next.js (App Router) — usually on Vercel

Two route handlers. Next.js gives the raw body via `await req.text()` — verify that string, then
`JSON.parse` it. Keep the turn alive past the response with `waitUntil` (`npm i @vercel/functions`)
— without it Vercel freezes the function and the reply never goes out. Self-hosted `next start`
doesn't need `waitUntil`, but it's harmless there.

Memory: serverless instances don't share process memory — keep per-chat history and seen ids in
the project's DB/KV (Vercel KV/Upstash Redis/Postgres). The in-memory `Map`s below are only for a
first local test.

`app/health/route.ts` (must be at the root path `/health`):

```ts
export const dynamic = 'force-dynamic';
export function GET() {
  return Response.json({ ok: true });
}
```

`app/agentry/webhook/route.ts`:

```ts
import crypto from 'node:crypto';
import { waitUntil } from '@vercel/functions';

export const runtime = 'nodejs';
export const maxDuration = 60; // seconds the background turn may take (plan limits apply)

const secret = () => process.env.AGENTRY_WEBHOOK_SECRET || '';
const seen = new Set<string>(); // replace with KV in production

function verify(raw: string, header: string | null) {
  if (!header || !secret()) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret()).update(raw).digest('hex');
  const a = Buffer.from(expected), b = Buffer.from(header);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function POST(req: Request) {
  if (!secret()) return Response.json({ error: 'signing_secret_not_configured' }, { status: 503 });
  const raw = await req.text();
  if (!verify(raw, req.headers.get('x-super-signature'))) return Response.json({ error: 'bad_signature' }, { status: 401 });
  const payload = JSON.parse(raw);
  const id = payload?.envelope?.id;
  if (id && seen.has(id)) return Response.json({ ok: true, duplicate: true });
  if (id) seen.add(id);
  if (payload.envelope?.type === 'message') waitUntil(runTurn(payload));
  return Response.json({ ok: true });
}
```

`runTurn`, `send`, `typing` and the envelope helpers are the same as in `node-express.md` (copy
them into `lib/agentry.ts`), with `runAgent` calling the project's agent.

Pages Router (`pages/api/...`): set `export const config = { api: { bodyParser: false } }` and
read the raw body from the request stream before verifying.
