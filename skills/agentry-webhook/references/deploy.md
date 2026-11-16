# Deployment: detecting it, filling gaps, setting the secret

Never deploy, push, or change hosting settings without the user saying go.

## Detect

| File / sign | Host | Public URL usually is |
|---|---|---|
| `vercel.json`, `.vercel/`, Next.js on Vercel | Vercel (serverless) | `https://<project>.vercel.app` or a custom domain |
| `fly.toml` | Fly.io | `https://<app>.fly.dev` |
| `render.yaml` | Render | `https://<service>.onrender.com` |
| `railway.json` / `railway.toml` | Railway | `https://<service>.up.railway.app` |
| `Procfile` (+ `app.json`) | Heroku (or Procfile-based) | `https://<app>.herokuapp.com` |
| `app.yaml` | Google App Engine | `https://<project>.appspot.com` |
| `Dockerfile` / `docker-compose.yml` only | Self-hosted / VPS / any container host | Ask |
| `k8s/`, Helm chart, `*.yaml` with `kind: Deployment` / `Ingress` | Kubernetes | The Ingress host — ask if not in the YAML |
| `serverless.yml`, `template.yaml` (SAM) | AWS Lambda | API Gateway URL — ask |
| `wrangler.toml` | Cloudflare Workers | `https://<name>.<account>.workers.dev` |
| `.github/workflows/*deploy*` | Whatever the workflow targets | Read the workflow |
| pm2 `ecosystem.config.*`, systemd units, nginx conf | A VPS | The nginx `server_name` — ask |

If there's config but something is missing, ask for **exactly** the missing pieces, together:
the public base URL, whether HTTPS is set up, how env vars are set there, and whether deploying
this branch is OK. Don't guess a hostname.

If nothing is deployed and the user wants to deploy now, suggest the simplest fit for their stack
(a small always-on service: Render / Railway / Fly.io for a long-running server) and walk them
through it — but a tunnel is enough to finish the console's **First contact** step.

## Serverless caveat (Vercel, Netlify, Lambda, Cloudflare Workers)

The function is frozen as soon as the response is sent. The reply to `reply_url` must be kept
alive explicitly:

- **Vercel**: `import { waitUntil } from '@vercel/functions'` → `waitUntil(runTurn(payload))`
  before returning the 200. Check the function's `maxDuration` covers the agent's slowest turn.
- **Cloudflare Workers**: `ctx.waitUntil(runTurn(payload))`.
- **Netlify**: a background function (`-background` suffix) for the turn, invoked from the
  webhook function.
- **AWS Lambda**: return 200 from the webhook Lambda and hand the turn to an async invocation
  (`InvocationType: 'Event'`) or an SQS queue.

Per-chat memory can't live in process memory on serverless — use the project's DB/KV.

## Setting `AGENTRY_WEBHOOK_SECRET` on the host

| Host | How |
|---|---|
| Vercel | Project → Settings → Environment Variables, or `vercel env add AGENTRY_WEBHOOK_SECRET production`; then redeploy. |
| Render | Service → Environment → Add, saves and redeploys. |
| Railway | Service → Variables → New variable (redeploys). |
| Fly.io | `fly secrets set AGENTRY_WEBHOOK_SECRET=…` (restarts machines). |
| Heroku | `heroku config:set AGENTRY_WEBHOOK_SECRET=…`. |
| Cloudflare Workers | `wrangler secret put AGENTRY_WEBHOOK_SECRET`. |
| AWS Lambda | Function → Configuration → Environment variables (or Secrets Manager). |
| Kubernetes | A `Secret` + `env.valueFrom.secretKeyRef` in the Deployment; `kubectl rollout restart`. |
| VPS / Docker | The service's env file (not in git) or `docker run -e` / compose `env_file`; restart the service. |

After setting it, restart/redeploy, then re-run `scripts/check.mjs --no-reply` against the public URL.
