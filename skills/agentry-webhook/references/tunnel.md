# Local testing with an ngrok tunnel

Use this only when the agent runs on the user's computer. Ask before installing anything.

## Why ngrok, and why the static domain

- Agentry needs a public HTTPS URL. ngrok gives one that forwards to `localhost:<port>`.
- Every free ngrok account includes **one static domain** (e.g. `quiet-otter-42.ngrok-free.app`).
  Use it. A random URL changes on every restart, and the console stores the URL — the user would
  have to re-paste it each time, and after submission the URL is locked.
- Cloudflare quick tunnels (`cloudflared tunnel --url`) need no account but also change URL every
  run — fine for a one-off curl, not for the console.

## Steps

1. **Check if it's already installed:** `ngrok version`. If it prints v3.x, skip to step 3.
2. **Install** (pick the user's OS; ask first):
   - macOS: `brew install ngrok`
   - Windows: `winget install ngrok.ngrok` (or `choco install ngrok`)
   - Linux (Debian/Ubuntu): `sudo snap install ngrok` — or the apt repo from
     https://ngrok.com/download
   - Any OS, no package manager: download the binary from https://ngrok.com/download
3. **Account + authtoken.** The user signs up (free) at https://dashboard.ngrok.com/signup, then
   copies the authtoken from https://dashboard.ngrok.com/get-started/your-authtoken. Ask them to
   run (or paste it and you run): `ngrok config add-authtoken <token>`.
4. **Static domain.** Dashboard → **Domains** → claim the free domain if it isn't claimed. Ask
   the user for it.
5. **Start the tunnel** (in its own terminal — it must keep running):
   `ngrok http --url=<static-domain> <port>`
   (older v3 builds: `ngrok http --domain=<static-domain> <port>`)
6. **Check it:** `curl https://<static-domain>/health` → 2xx. Then run `scripts/check.mjs`
   against `https://<static-domain>/agentry/webhook`.

## What to tell the user

> This link works only while this computer is awake and both your server and ngrok are running.
> If either stops, Agentry's test messages fail and the console shows the error — just start them
> again; the link stays the same. Deploy before submitting the agent for review.

The ngrok free plan has request limits that testing won't hit. The browser interstitial warning
only appears for browsers, not for Agentry's server-to-server requests.
