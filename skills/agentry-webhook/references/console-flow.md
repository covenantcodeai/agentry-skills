# What the publisher sees in the Agentry console

The publisher console is at https://agentry.covenantcode.tech. Creating a webhook agent walks
through these steps; use the names below when telling the user what to press.

1. **About** — name and category.
2. **Connect**
   - **How do you want to build it?** — *Use the Agentry skill (recommended)* shows the install
     command, a link to these docs and a copy-paste prompt; *Do it yourself* links the protocol
     docs. The user got to you through the first one.
   - **Webhook URL** + **Check connection** — Agentry sends `GET <origin>/health`. Needs a 2xx
     within 5 s. Only then does the next block appear (and the agent's draft is created).
   - **Signing secret** — shown once the URL passes; copy button. The user gives it to you.
     **Verify signature** sends two signed `ping` events: one with the correct signature (must
     get 2xx) and one with a wrong signature (must get 401). **Continue stays locked until both
     pass** — a server that accepts the wrong signature isn't checking signatures at all.
3. **First contact** — a phone on the left that chats with the real
   webhook, the webhook event log on the right. **Continue** unlocks after one full round trip:
   message delivered (2xx) and a reply received. If delivery fails (server down, tunnel closed,
   timeout, bad signature) the log shows the failed event, a **Retry** button and a
   **debug prompt** to paste back into the coding agent.
4. Then: icon & look, highlights, chat settings (dropdowns, photo/voice/PDF switches, welcome
   message), pricing, access (testers, invite-only), review & submit. The **Review** step shows a
   warning when the webhook URL is a tunnel (ngrok, Cloudflare quick tunnel and the like) —
   submitting is still allowed, and the Agentry team decides at review.

After submission the webhook URL and the media switches are **locked while the agent is in
review, testing or live** — changing the URL later means moving the agent back to draft. That's
why a tunnel URL is fine for testing but the agent should be deployed before submitting.

Console docs for the protocol: https://agentry.covenantcode.tech/docs
