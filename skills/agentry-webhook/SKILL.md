---
name: agentry-webhook
description: Connects an existing AI agent codebase to Agentry (the AI agent marketplace app) as a webhook agent — reads the codebase, adds the Agentry webhook route on a new git branch (signed requests, 200-within-8s ack, typing indicators, replies via reply_url, settings, usage, install events), tests it with a bundled Postman collection, exposes it with ngrok or the existing deployment, hands back the webhook URL for the Agentry console, then installs the signing secret. Use when the user wants to publish, connect, list or ship their agent on Agentry, mentions an Agentry webhook URL, signing secret, X-Super-Signature or reply_url, or pastes the setup prompt from the Agentry publisher console.
---

# Connect an agent to Agentry

You are wiring the user's existing agent into **Agentry**: a mobile app where people chat with
AI agents. Agentry POSTs each user message to a webhook URL on the user's server; the server
answers `200` fast, then posts the reply back. Your job is to add that webhook to *their* code,
prove it works, and hand them a URL to paste into the Agentry publisher console.

The person you're helping is the **publisher** — the agent's developer. They have the Agentry
console open in a browser on the **Connect** step, which asks for the webhook URL, then shows a
signing secret, then **First contact** — a live test chat. `references/console-flow.md` describes exactly what they
see, so you can tell them which button to press.

## Ground rules

- **Ask before** installing anything, creating accounts, deploying, pushing, or touching
  production. Never run destructive git commands. Never commit secrets or `.env` files.
- **Don't invent the agent.** You are adding a transport layer around the logic that exists.
  If a tool, prompt or key is missing or half-built, ask (Phase 3) — don't fill it with guesses.
- **Keep changes on a branch** and keep the diff small: new route + small adapter + config.
- Speak plainly. The publisher may not know webhook jargon. Short status lines, one question at
  a time when you need a decision.
- Read `references/protocol.md` before writing code. It is the contract; follow it exactly.

Track progress with this checklist and show it when you finish each phase:

```
Agentry setup
- [ ] 1. Understand the codebase
- [ ] 2. Branch + webhook route
- [ ] 3. Gaps confirmed with you
- [ ] 4. Local test passed (Postman)
- [ ] 5. Public URL ready (deployed or tunnel)
- [ ] 6. URL in the console → signing secret installed → verified
```

---

## Phase 1 — Understand the codebase

Read before you write. Find and note:

- **Stack**: language, framework, package manager, how it starts (`package.json` scripts,
  `pyproject.toml`, `Procfile`, `Dockerfile`, `main.go` …). If there's no web server at all
  (a CLI, a notebook, a bot for another platform), you'll add a minimal one in the stack the
  project already uses — see `references/stacks/`.
- **The agent's brain**: the function/class that takes a user message and produces an answer
  (LLM call, tool loop, chain/graph). This is what the webhook will call.
- **Model provider + model id** (for usage reporting) and whether token counts are available
  from the response.
- **Tools / integrations** the agent uses, and their env vars / keys.
- **State**: does it already keep conversation history? Where (memory, DB, file)?
- **Media**: can it take images, audio, PDFs? Can it produce any?
- **Deployment hints**: Dockerfile, `fly.toml`, `render.yaml`, `vercel.json`, `railway.json`,
  `app.yaml`, `Procfile`, Kubernetes/Helm YAML, `serverless.yml`, CI deploy workflows,
  `.env.example`, README deploy notes.
- **Git state**: branch, uncommitted changes.

Then give the user a short summary (≤10 lines) — stack, the function you'll call, model,
tools, memory, deployment status — and ask them to confirm or correct it before Phase 2.

## Phase 2 — Branch and add the webhook

1. Branch: `git checkout -b agentry-webhook` (if the tree is dirty, ask whether to commit,
   stash, or carry the changes over first). If the project isn't a git repo, say so and offer
   `git init` — don't force it.
2. Open the matching guide in `references/stacks/` (`node-express.md`, `nextjs.md`,
   `python-fastapi.md`, `python-flask.md`, `go.md`; for anything else follow the closest one —
   the rules in `protocol.md` are what matter).
3. Add, following `references/protocol.md` exactly:
   - `GET /health` at the **root** of the host → 200.
   - `POST /agentry/webhook` (or a path that fits the project) that, in this order:
     reads the **raw body** → verifies `X-Super-Signature` with `AGENTRY_WEBHOOK_SECRET`
     (401 if wrong/missing, 503 if the secret isn't set) → parses JSON → de-dupes on
     `envelope.id` → returns 200 immediately → handles the event **in the background**.
   - Event handling: `message` runs a turn; `typing_*` / `ping` / unknown types are ignored;
     `install` / `uninstall` are acknowledged (offer a proactive welcome only if the user wants one).
   - The turn: `typing_start` → call the agent's brain with the message text (and media, if the
     agent supports it) plus that chat's history → reply `message` (+ `usage` if token counts
     exist) → `typing_stop`. Failure → `typing_stop` + a short apology message, real error logged.
   - Per-`chat_id` conversation memory (protocol §5) if the agent is multi-turn.
   - `settings` (dropdown picks) passed through to the brain if the agent has anything
     configurable; `user.timezone` passed through if anything is time-aware.
   - `AGENTRY_WEBHOOK_SECRET=` added to `.env.example` (empty value) and the project's config
     loader; make sure `.env` is in `.gitignore`.
4. Keep the agent's existing entry points working — add, don't replace.
5. Install any new dependency with the project's package manager, and say what you added.
6. Commit on the branch with a clear message (ask first if the user prefers to commit themselves).

## Phase 3 — Confirm gaps with the user

Before testing, list anything that would make a real conversation fail or feel broken, and ask
about each — in one message, numbered, with your suggested default:

- Tools that are stubbed, TODO, half-implemented, or need keys that aren't in the env.
- Missing env vars / API keys the agent needs at runtime.
- No conversation memory (offer: in-memory now, DB/Redis before deploying).
- Media the agent could support but doesn't (photos/voice/PDF in, images/files out) — and that
  each needs its switch turned on in the console's **Chat** step later.
- Settings dropdowns worth exposing (model choice, language, tone…) — max 3, configured in the
  console's **Chat** step; the code reads them from `settings`.
- Anything slow (>5 s) that must move behind the background task.

Apply only what the user agrees to.

## Phase 4 — Test locally with Postman

The skill ships a Postman collection and a runner. Nothing to download by hand — the runner uses
Newman (Postman's command-line runner) through `npx`. **Ask before the first `npx` run** (it
downloads Newman, ~20 MB, no account needed).

1. Start the server locally with a **throwaway test secret**:
   `AGENTRY_WEBHOOK_SECRET=local-test-secret` (set it the way the project loads env — shell
   export, `.env`, run config). This is *not* the real secret; that comes from the console in
   Phase 6.
2. Run, from this skill's directory (`scripts/` sits next to this file):

   ```bash
   node scripts/check.mjs --url http://localhost:<port>/agentry/webhook --secret local-test-secret
   ```

   It starts a mock `reply_url` receiver on `127.0.0.1:4599`, runs the collection
   (`assets/agentry.postman_collection.json`) against the server, waits for the agent's reply,
   and prints a pass/fail table:
   health 2xx · signed message 2xx in < 8 s · wrong signature 401 · missing signature 401 ·
   typing/install/ping/unknown types 2xx · reply arrives with a valid envelope · typing_start
   before the message · typing_stop after it · usage block shape (if sent) · duplicate id not
   answered twice.
3. Fix every failure (the table names the rule; `references/troubleshooting.md` maps symptoms to
   fixes) and re-run until it's all green. `--timeout 60` gives a slow agent longer to reply.
4. Tell the user they can open the same collection in the Postman app (Import →
   `assets/agentry.postman_collection.json` + `assets/agentry.postman_environment.json`) if they
   want to poke at it by hand.

## Phase 5 — Get a public URL

Agentry's servers must be able to reach the webhook over the internet with HTTPS.

**A. Already deployed** (a live URL exists, or the user says so): get the public base URL from
the user or the config, deploy the branch the way the project already deploys **only after the
user says go**, set `AGENTRY_WEBHOOK_SECRET` there later (Phase 6). If deploy config exists but
details are missing (no URL, unknown host, missing env, unclear region), ask for exactly the
missing pieces — see `references/deploy.md`. Run the check against the public URL:

```bash
node scripts/check.mjs --url https://<their-host>/agentry/webhook --secret <whatever the deployed server has> --no-reply
```

(`--no-reply`: a remote server can't reach the local mock receiver; the real round trip is
proven in the console's **First contact** step.)

**B. Only local**: offer a tunnel so they can test now. Explain first, then ask permission:
> "Your agent only runs on this computer, so Agentry can't reach it yet. I can install ngrok
> (free) to give it a public HTTPS link while you test. OK to install it?"

Follow `references/tunnel.md` — install ngrok, add their authtoken, and use their **free static
domain** so the URL doesn't change between restarts (the console remembers the URL). Start
`ngrok http --url=<static-domain> <port>`, then re-run the check against
`https://<static-domain>/agentry/webhook` (the mock receiver works here — the server is local).

When it's green, tell them clearly:
> "Your agent is reachable at **https://<static-domain>/agentry/webhook**. This link only works
> while this computer is on and both your server and ngrok are running. It's perfect for testing
> in the Agentry console. Before you submit the agent for review, deploy it somewhere that's
> always on — the console's Review step flags tunnel links, and the Agentry team may not approve
> one. I can help you deploy whenever you're ready."

## Phase 6 — Hand over the URL, then install the signing secret

1. Say, as its own short message:
   > **Here is your webhook URL:** `https://…/agentry/webhook`
   > Paste it into the Agentry console (Connect step → Webhook URL) and press **Check connection**.
   > When it turns green, the console shows your **signing secret**. Copy it and paste it here.
2. Then wait, with a final line: **"Waiting for the signing secret from the Agentry console…"**
   Also offer the private route: *"If you'd rather not paste the secret into this chat, put it in
   your `.env` as `AGENTRY_WEBHOOK_SECRET=…` yourself and tell me when it's done."*
3. When the secret arrives (or the user says it's in place):
   - Local: write it to `.env` (never to a tracked file), confirm `.env` is git-ignored.
   - Deployed: tell them exactly where to set it for their host (`references/deploy.md`) or set
     it with the host's CLI if they ask you to. Never print the secret back in full.
   - Restart the server (and keep ngrok running).
   - Re-run `node scripts/check.mjs --url <public url> --secret <the real secret>` (add
     `--no-reply` if deployed remotely).
4. Tell them: **"Press Verify signature in the console. When it passes, press Continue — the next
   step is **First contact**, a live test chat with your agent."**
5. Stay available for **First contact**: if a test message fails there, the console shows
   a **debug prompt** — ask them to paste it here, read it, check the server logs, fix, and re-run
   the check.

Finish with the checklist, all boxes ticked, plus one line on what's left: deploying if they're on
a tunnel, and the console steps after testing (icon, highlights, pricing, review).
