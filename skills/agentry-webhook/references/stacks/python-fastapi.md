# Python — FastAPI (also the pattern for Starlette/Litestar)

Uses `httpx` for the reply (add it if the project doesn't have it). Raw body: `await request.body()`
— verify those bytes before `json.loads`. Background work: `BackgroundTasks`, which runs after
the response is sent.

```python
# agentry.py — Agentry webhook adapter
import hashlib, hmac, json, os, time, uuid, logging
from datetime import datetime, timezone, timedelta
from collections import OrderedDict

import httpx
from fastapi import APIRouter, BackgroundTasks, Request
from fastapi.responses import JSONResponse

log = logging.getLogger("agentry")
router = APIRouter()
_seen: "OrderedDict[str, float]" = OrderedDict()      # envelope.id -> time (retry de-dupe)
_histories: dict[str, list[dict]] = {}                # chat_id -> turns (in-memory: resets on restart)


def _secret() -> str:
    return os.environ.get("AGENTRY_WEBHOOK_SECRET", "")


def _verify(raw: bytes, header: str | None) -> bool:
    if not header or not _secret():
        return False
    expected = "sha256=" + hmac.new(_secret().encode(), raw, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, header)


def _first_time(event_id: str) -> bool:
    if event_id in _seen:
        return False
    _seen[event_id] = time.time()
    while len(_seen) > 5000:
        _seen.popitem(last=False)
    return True


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _base(payload: dict, type_: str) -> dict:
    return {
        "type": type_,
        "id": f"{'msg' if type_ == 'message' else 'evt'}_{uuid.uuid4()}",
        "chat_id": payload["envelope"]["chat_id"],
        "from": {"kind": "agent", "id": payload["agent_id"]},
        "timestamp": _now(),
    }


async def _send(client: httpx.AsyncClient, payload: dict, envelope: dict, usage: dict | None = None) -> None:
    body = {"envelope": envelope, **({"usage": usage} if usage else {})}
    r = await client.post(payload["reply_url"], json=body,
                          headers={"Authorization": f"Bearer {payload['reply_token']}"})
    if r.status_code >= 300:
        log.error("reply %s -> %s %s", envelope["type"], r.status_code, r.text[:300])


async def _typing(client, payload, type_):
    env = _base(payload, type_)
    if type_ == "typing_start":
        env["expires_at"] = (datetime.now(timezone.utc) + timedelta(seconds=10)).isoformat().replace("+00:00", "Z")
    await _send(client, payload, env)


async def run_turn(payload: dict) -> None:
    env = payload["envelope"]
    chat_id = env["chat_id"]
    content = env.get("content") or {}
    if content.get("kind") == "text":
        text = content["text"]
    elif content.get("kind") == "action":
        a = content["action"]
        text = a.get("label") or json.dumps(a.get("values"))
    else:
        text = content.get("caption") or f"[{content.get('kind')}]"

    async with httpx.AsyncClient(timeout=30) as client:
        await _typing(client, payload, "typing_start")
        try:
            history = _histories.get(chat_id, [])
            # ⬇ Call the project's real agent here. Return {"text": ..., "usage": {...} | None}
            result = await run_agent(text=text, content=content, history=history,
                                     settings=payload.get("settings") or {}, user=payload.get("user") or {}, chat_id=chat_id)
            _histories[chat_id] = (history + [{"role": "user", "content": text},
                                              {"role": "assistant", "content": result["text"]}])[-40:]
            msg = {**_base(payload, "message"), "in_reply_to": env["id"], "content": {"kind": "text", "text": result["text"]}}
            await _send(client, payload, msg, result.get("usage"))
        except Exception:
            log.exception("turn failed")
            msg = {**_base(payload, "message"), "in_reply_to": env["id"],
                   "content": {"kind": "text", "text": "Sorry — something went wrong on my side. Please try again."}}
            await _send(client, payload, msg)
        finally:
            await _typing(client, payload, "typing_stop")


@router.get("/health")
async def health():
    return {"ok": True}


@router.post("/agentry/webhook")
async def webhook(request: Request, background: BackgroundTasks):
    if not _secret():
        return JSONResponse({"error": "signing_secret_not_configured"}, status_code=503)
    raw = await request.body()
    if not _verify(raw, request.headers.get("x-super-signature")):
        return JSONResponse({"error": "bad_signature"}, status_code=401)
    try:
        payload = json.loads(raw)
    except ValueError:
        return JSONResponse({"error": "invalid_json"}, status_code=400)
    env = payload.get("envelope") or {}
    if env.get("id") and not _first_time(env["id"]):
        return {"ok": True, "duplicate": True}
    if env.get("type") == "message":
        background.add_task(run_turn, payload)
    return {"ok": True}  # install / uninstall / typing / ping / unknown: acknowledged
```

Mount it: `app.include_router(agentry.router)` — no prefix, so `/health` sits at the root.

Long turns (> a minute) or several workers: `BackgroundTasks` runs in the same worker; that's fine
for most agents. For heavy jobs use the project's queue (Celery/RQ/Arq) and pass `payload` to it.
Multiple workers (`uvicorn --workers N`, gunicorn) don't share `_seen`/`_histories` — move them to
Redis/the DB.

If `run_agent` is synchronous, call it with `await asyncio.to_thread(run_agent, ...)` so it doesn't
block the event loop.
