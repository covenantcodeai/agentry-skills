# Python — Flask (also the pattern for Django)

Flask is synchronous, so the turn runs on a background thread (or the project's queue —
Celery/RQ — if it has one). Raw body: `request.get_data()` **before** touching `request.json`.
Uses `requests` for the reply.

```python
# agentry.py
import hashlib, hmac, json, os, threading, uuid, logging
from datetime import datetime, timezone, timedelta
from collections import OrderedDict

import requests
from flask import Blueprint, request, jsonify

log = logging.getLogger("agentry")
bp = Blueprint("agentry", __name__)
_seen: "OrderedDict[str, bool]" = OrderedDict()
_lock = threading.Lock()
_histories: dict[str, list[dict]] = {}


def _secret():
    return os.environ.get("AGENTRY_WEBHOOK_SECRET", "")


def _verify(raw: bytes, header):
    if not header or not _secret():
        return False
    expected = "sha256=" + hmac.new(_secret().encode(), raw, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, header)


def _now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _base(payload, type_):
    return {"type": type_, "id": f"{'msg' if type_ == 'message' else 'evt'}_{uuid.uuid4()}",
            "chat_id": payload["envelope"]["chat_id"], "from": {"kind": "agent", "id": payload["agent_id"]},
            "timestamp": _now()}


def _send(payload, envelope, usage=None):
    body = {"envelope": envelope, **({"usage": usage} if usage else {})}
    r = requests.post(payload["reply_url"], json=body, timeout=30,
                      headers={"Authorization": f"Bearer {payload['reply_token']}"})
    if r.status_code >= 300:
        log.error("reply %s -> %s %s", envelope["type"], r.status_code, r.text[:300])


def run_turn(payload):
    env = payload["envelope"]
    content = env.get("content") or {}
    text = content.get("text") if content.get("kind") == "text" else (content.get("caption") or f"[{content.get('kind')}]")
    start = _base(payload, "typing_start")
    start["expires_at"] = (datetime.now(timezone.utc) + timedelta(seconds=10)).isoformat().replace("+00:00", "Z")
    _send(payload, start)
    try:
        history = _histories.get(env["chat_id"], [])
        result = run_agent(text=text, content=content, history=history,          # ⬇ the project's agent
                           settings=payload.get("settings") or {}, user=payload.get("user") or {})
        _histories[env["chat_id"]] = (history + [{"role": "user", "content": text},
                                                 {"role": "assistant", "content": result["text"]}])[-40:]
        _send(payload, {**_base(payload, "message"), "in_reply_to": env["id"],
                        "content": {"kind": "text", "text": result["text"]}}, result.get("usage"))
    except Exception:
        log.exception("turn failed")
        _send(payload, {**_base(payload, "message"), "in_reply_to": env["id"],
                        "content": {"kind": "text", "text": "Sorry — something went wrong on my side. Please try again."}})
    finally:
        _send(payload, _base(payload, "typing_stop"))


@bp.get("/health")
def health():
    return jsonify(ok=True)


@bp.post("/agentry/webhook")
def webhook():
    if not _secret():
        return jsonify(error="signing_secret_not_configured"), 503
    raw = request.get_data()
    if not _verify(raw, request.headers.get("X-Super-Signature")):
        return jsonify(error="bad_signature"), 401
    payload = json.loads(raw)
    env = payload.get("envelope") or {}
    with _lock:
        if env.get("id") in _seen:
            return jsonify(ok=True, duplicate=True)
        _seen[env.get("id")] = True
        while len(_seen) > 5000:
            _seen.popitem(last=False)
    if env.get("type") == "message":
        threading.Thread(target=run_turn, args=(payload,), daemon=True).start()
    return jsonify(ok=True)
```

Register: `app.register_blueprint(agentry.bp)` (no `url_prefix`, so `/health` is at the root).

**Django:** same logic in a view decorated with `@csrf_exempt` and `@require_POST`; read
`request.body` (bytes) for the HMAC; `JsonResponse(..., status=...)`; route `path("health", …)`
at the root URLconf. Run the turn on a thread, or Celery if the project uses it.

**Gunicorn with several workers:** `_seen`/`_histories` aren't shared — use Redis/the DB.
