# Agentry skills

Skills for coding agents (Claude Code, Codex, Cursor, Gemini CLI, GitHub Copilot, Windsurf and
the rest of the [Agent Skills](https://skills.sh) ecosystem) that help developers ship agents on
**Agentry**.

| Skill | What it does |
|---|---|
| [`agentry-webhook`](skills/agentry-webhook/SKILL.md) | Connects an existing agent codebase to Agentry: reads the code, adds the webhook on a new branch, tests it with a bundled Postman collection, gets a public URL (deployment or ngrok), and installs the signing secret from the Agentry console. |

## Install

In the root of the agent's project:

```bash
npx skills add covenantcodeai/agentry-skills --skill agentry-webhook
```

Then ask your coding agent: *"Connect this agent to Agentry."* The Agentry console's **Connect**
step gives you a ready-made prompt to paste.

Claude Code also works as a plugin marketplace:

```
/plugin marketplace add covenantcodeai/agentry-skills
/plugin install agentry@agentry-skills
```

No coding agent with skills? Point any AI assistant at
[`skills/agentry-webhook/SKILL.md`](skills/agentry-webhook/SKILL.md) and the files in
[`references/`](skills/agentry-webhook/references/) — they're plain Markdown.

Update later with `npx skills update`.

## What it needs on the developer's machine

- Node.js 18+ (for the test runner; the agent itself can be any language).
- `npx` — the runner fetches [Newman](https://www.npmjs.com/package/newman) (Postman's CLI
  runner) on first use. No Postman account, no app install. The same collection imports into
  the Postman app: `skills/agentry-webhook/assets/`.
- ngrok, only if the agent isn't deployed yet — the skill asks before installing it.

## The copy-paste prompt (shown in the console)

```text
Connect this project's agent to Agentry as a webhook agent, using the agentry-webhook skill.
Agent name: {{name}} · Category: {{category}}
Docs: https://agentry.covenantcode.tech/docs
Work on a new git branch. When the webhook is tested and reachable, give me the webhook URL to
paste into the Agentry console, then wait for the signing secret.
If you don't have the skill installed, read
https://github.com/covenantcodeai/agentry-skills/blob/main/skills/agentry-webhook/SKILL.md and the files
in its references/ folder first, and follow them.
```

## Repo layout

```
skills/agentry-webhook/
  SKILL.md                     the workflow the coding agent follows (6 phases)
  references/protocol.md       the webhook contract
  references/stacks/*.md       Express, Next.js, FastAPI, Flask/Django, Go
  references/deploy.md         spotting the host, serverless caveat, setting the secret
  references/tunnel.md         ngrok with a static domain
  references/console-flow.md   what the publisher sees in the console
  references/troubleshooting.md
  assets/agentry.postman_collection.json (+ environment)   — generated, see tools/
  scripts/check.mjs            runs the collection + a local reply_url receiver, prints pass/fail
.claude-plugin/                Claude Code plugin + marketplace manifests
tools/build-collection.mjs     regenerates the Postman collection
```

## Maintaining

- **The protocol has three copies**: the backend's `docs/CHAT_PROTOCOL.md` (source of truth), the
  console's `DocsPage.jsx`, and `references/protocol.md` here. A protocol change updates all
  three, and `scripts/check.mjs`'s reply validator mirrors the backend's `validateReplyEnvelope`
  (`controllers/chats.js`).
- Edit the collection through `tools/build-collection.mjs`, then `node tools/build-collection.mjs`.
- Before a release, run the check against each stack reference (extract the code blocks into a
  scratch project with a stub `runAgent`) — all should pass 17/17.
- Release = push to `main` and tag (`v1.0.0`, …). skills.sh lists the repo automatically once
  people install from it; there's nothing to submit.
