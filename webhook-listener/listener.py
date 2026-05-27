#!/usr/bin/env python3
"""dashi-plugin webhook listener.

Receives POST /hooks/agent from gbrain swarm worker, verifies Bearer,
spawns a headless `claude -p` subprocess in the agent's workspace that
picks up the task from gbrain via swarm.list_my_pending.

Designed for the dashi-channel plugin family, which has no inbox-poll
loop — Claude is invoked directly when a webhook arrives.

Bind: $WEBHOOK_BIND_HOST:$WEBHOOK_PORT (default 0.0.0.0:8094).
Auth: Bearer token from $WEBHOOK_BEARER_FILE.

v6.3 features:
- enrichment from gbrain.list_my_pending when swarm worker sends an
  empty payload (P0.5 degraded-retry case)
- pre-ack Telegram notification to the agent owner (skip 3-way degraded
  payloads + 5-minute dedup window)
- silent ack when both payload and gbrain inbox are empty (fluke retry)
"""
from __future__ import annotations

import asyncio
import html
import json
import logging
import os
import re
import sys
import time
from pathlib import Path

from aiohttp import web

PORT = int(os.environ.get("WEBHOOK_PORT", "8094"))
# Default to loopback. Operators who terminate TLS upstream can flip to
# 0.0.0.0 explicitly; we do not encourage cleartext public exposure.
BIND_HOST = os.environ.get("WEBHOOK_BIND_HOST", "127.0.0.1")
BEARER_FILE = os.environ.get("WEBHOOK_BEARER_FILE", "/etc/dashi-plugin/webhook.token")
AGENT_WORKSPACE = Path(os.environ.get(
    "WEBHOOK_AGENT_WORKSPACE",
    str(Path.home() / ".claude"),
))
CLAUDE_BIN = os.environ.get("CLAUDE_BIN", "/usr/local/bin/claude")
LOG_DIR = Path(os.environ.get(
    "WEBHOOK_LOG_DIR", "/var/log/dashi-plugin-webhook",
))
INVOCATION_TIMEOUT_SEC = int(os.environ.get("INVOCATION_TIMEOUT_SEC", "1800"))

GBRAIN_TOKEN_PATH = Path(os.environ.get(
    "WEBHOOK_GBRAIN_TOKEN_FILE",
    str(Path.home() / ".secrets" / "dashi-gbrain.token"),
))
GBRAIN_SWARM_URL = os.environ.get("WEBHOOK_GBRAIN_SWARM_URL", "").strip()
AGENT_NAME = os.environ.get("WEBHOOK_AGENT_NAME", "").strip()
if not AGENT_NAME:
    raise SystemExit(
        "WEBHOOK_AGENT_NAME is required — set it to the logical agent name "
        "that owns this listener (it is embedded into the spawn prompt)."
    )

OWNER_CHAT_ID = os.environ.get("WEBHOOK_OWNER_CHAT_ID", "").strip()
TG_BOT_TOKEN_FILE = Path(os.environ.get(
    "WEBHOOK_TG_BOT_TOKEN_FILE",
    str(Path.home() / ".secrets" / "telegram-bot-token"),
))

NOTIFY_TTL_SEC = int(os.environ.get("WEBHOOK_NOTIFY_TTL_SEC", "300"))

_TOXIC = re.compile(
    r"(Bearer\s+\S+|sk-[A-Za-z0-9_-]+|password=\S+)",
    re.IGNORECASE,
)


class RedactingFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        return _TOXIC.sub("<REDACTED>", super().format(record))


_handler = logging.StreamHandler(sys.stdout)
_handler.setFormatter(RedactingFormatter("%(asctime)s %(levelname)s %(message)s"))
logging.basicConfig(level=logging.INFO, handlers=[_handler])
log = logging.getLogger("dashi-plugin-webhook")


def _read_secret(path: str) -> bytes:
    p = Path(path).expanduser()
    if not p.is_file():
        raise SystemExit(f"secret file not found: {p}")
    return p.read_text().rstrip("\n").encode("utf-8")


BEARER_TOKEN: bytes = _read_secret(BEARER_FILE)
LOG_DIR.mkdir(parents=True, exist_ok=True)


def _verify_bearer(request: web.Request) -> bool:
    import hmac as _hmac
    header = request.headers.get("Authorization", "")
    if not header.startswith("Bearer "):
        return False
    candidate = header[7:].strip().encode("utf-8")
    return _hmac.compare_digest(candidate, BEARER_TOKEN)


_SAFE_TASK_ID = re.compile(r"[^a-zA-Z0-9_.:-]")


def _sanitize_task_id(raw: str) -> str:
    return _SAFE_TASK_ID.sub("_", raw)[:64] or "no-id"


def _build_prompt(payload: dict) -> str:
    from_agent = payload.get("from_agent") or payload.get("from") or "unknown"
    raw_task_id = payload.get("task_id") or payload.get("_task_id") or "no-id"
    task_id = _sanitize_task_id(str(raw_task_id))
    title = payload.get("title") or "(no title)"
    body = payload.get("body") or ""
    context = payload.get("context") or ""

    return (
        f"Inter-agent task delivered via swarm webhook.\n\n"
        f"From agent: {from_agent}\n"
        f"task_id: {task_id}\n"
        f"Title: {title}\n\n"
        f"Body:\n{body}\n\n"
        f"Context: {context}\n\n"
        f"Steps:\n"
        f"1) Read your inbox: mcp__dashi-gbrain-swarm__list_my_pending(agent=\"{AGENT_NAME}\")\n"
        f"2) Check the task board IN THIS ORDER:\n"
        f"   a) task_list(assignee=\"{AGENT_NAME}\", status=\"progress\") — your ACTIVE tasks. "
        f"If any — continue the FRESHEST (max id), do not reject it as new.\n"
        f"   b) If progress is empty — task_list(assignee=\"{AGENT_NAME}\", status=\"new\") — "
        f"take the FRESHEST (max id). IGNORE stale tasks older than 7 days "
        f"(created_at < today minus 7d) — residual garbage, not work.\n"
        f"   c) If both empty — webhook was a fluke retry. swarm.ack and exit.\n"
        f"3) If payload carries a meaningful task_id, it wins. Otherwise use the task from (a) or (b).\n"
        f"4) Do the work.\n"
        f"5) Report to the owner via your usual channel.\n"
        f"6) After the owner report, send a short summary to the dispatching agent via "
        f"mcp__dashi-gbrain-swarm__notify with payload "
        f"{{'title': 'Report from {AGENT_NAME}: <task title>', 'body': '<2-4 bullets>', "
        f"'_task_id': '{task_id}'}}.\n"
        f"7) Only then call mcp__dashi-gbrain-swarm__ack(task_id=\"{task_id}\").\n"
    )


_SUBPROCESS_ENV_ALLOW = frozenset({
    "HOME", "PATH", "USER", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TZ",
})
_SUBPROCESS_ENV_PREFIX = ("CLAUDE_", "ANTHROPIC_")


def _build_subprocess_env() -> dict[str, str]:
    """Build a minimal env for the spawned Claude.

    Drops anything the listener reads (WEBHOOK_*, gbrain tokens, telegram bot
    tokens) so secrets do not leak into the child process. Allows a small
    POSIX baseline + an opt-in CLAUDE_/ANTHROPIC_ prefix passthrough.
    """
    env: dict[str, str] = {}
    for key in _SUBPROCESS_ENV_ALLOW:
        val = os.environ.get(key)
        if val is not None:
            env[key] = val
    for key, val in os.environ.items():
        if key.startswith(_SUBPROCESS_ENV_PREFIX):
            env[key] = val
    env.setdefault("HOME", str(Path.home()))
    return env


async def _spawn_claude(prompt: str, task_id: str) -> None:
    ts = int(time.time())
    safe_id = _sanitize_task_id(task_id)
    log_path = LOG_DIR / f"{ts}_{safe_id}.log"

    env = _build_subprocess_env()

    log.info("spawning claude for task_id=%s, log=%s", task_id, log_path.name)
    log_fh = log_path.open("w")
    proc = await asyncio.create_subprocess_exec(
        CLAUDE_BIN, "-p", prompt,
        "--dangerously-skip-permissions",
        cwd=str(AGENT_WORKSPACE),
        env=env,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=log_fh,
        stderr=asyncio.subprocess.STDOUT,
    )

    async def _wait_and_close() -> None:
        try:
            await asyncio.wait_for(proc.wait(), timeout=INVOCATION_TIMEOUT_SEC)
            log.info("claude task_id=%s exited rc=%s", task_id, proc.returncode)
        except asyncio.TimeoutError:
            log.warning("claude task_id=%s timed out, killing", task_id)
            proc.kill()
        finally:
            log_fh.close()

    asyncio.create_task(_wait_and_close())


async def _fetch_pending_task(agent: str) -> dict | None:
    """Pull freshest pending delivery from gbrain swarm. Returns enriched dict or None.

    gbrain swarm list_my_pending derives the agent from the Bearer token via
    AuthCaptureMiddleware, so the `agent` argument is informational/logging
    only — it must match the token's owner.
    """
    if not GBRAIN_SWARM_URL:
        log.debug("fetch_pending skip — WEBHOOK_GBRAIN_SWARM_URL not set")
        return None
    try:
        import aiohttp
        import json as _json
        token = GBRAIN_TOKEN_PATH.read_text().strip()
        body = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {
                "name": "list_my_pending",
                "arguments": {"limit": 5},
            },
        }
        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        }
        async with aiohttp.ClientSession() as session:
            async with session.post(
                GBRAIN_SWARM_URL,
                json=body,
                headers=headers,
                timeout=aiohttp.ClientTimeout(total=10),
            ) as resp:
                raw = await resp.text()
                if resp.status != 200:
                    log.warning("fetch_pending HTTP %d: %s", resp.status, raw[:200])
                    return None
        # Extract JSON from SSE-wrapped response
        envelope = None
        for line in raw.splitlines():
            line = line.strip()
            if line.startswith("data:"):
                line = line[5:].strip()
            if not line or line.startswith(":") or line.startswith("event:"):
                continue
            try:
                envelope = _json.loads(line)
                break
            except Exception:
                continue
        if envelope is None:
            try:
                envelope = _json.loads(raw)
            except Exception:
                log.warning("fetch_pending unparseable: %s", raw[:200])
                return None
        result = envelope.get("result") or {}
        # FastMCP wrap_result: structuredContent.result is the actual list
        structured = result.get("structuredContent") or {}
        deliveries = structured.get("result")
        if deliveries is None:
            # Fallback: content[0].text contains JSON
            contents = result.get("content") or []
            if contents:
                text_payload = contents[0].get("text", "")
                try:
                    parsed = _json.loads(text_payload)
                    if isinstance(parsed, list):
                        deliveries = parsed
                    elif isinstance(parsed, dict):
                        deliveries = (
                            parsed.get("result")
                            or parsed.get("deliveries")
                            or parsed.get("items")
                            or []
                        )
                except Exception:
                    log.warning("fetch_pending inner parse failed: %s", text_payload[:200])
                    return None
        if not deliveries:
            return None
        if not isinstance(deliveries, list):
            log.warning(
                "fetch_pending unexpected deliveries type: %s",
                type(deliveries).__name__,
            )
            return None

        def _sort_key(d):
            # Prefer ISO timestamp over id. created_at is sortable as a
            # string when it is ISO-8601 (which gbrain emits); fall back to
            # a numeric id if present, else string id.
            ts = d.get("created_at")
            if isinstance(ts, str) and ts:
                return (1, ts)
            raw_id = d.get("id")
            if isinstance(raw_id, int):
                return (0, f"{raw_id:020d}")
            if isinstance(raw_id, str) and raw_id.isdigit():
                return (0, f"{int(raw_id):020d}")
            return (0, str(raw_id or ""))

        deliveries.sort(key=_sort_key, reverse=True)
        top = deliveries[0]
        inner = top.get("payload") or {}
        return {
            "from_agent": top.get("from_agent") or inner.get("from_agent") or "unknown",
            "task_id": str(
                inner.get("_task_id")
                or inner.get("task_id")
                or top.get("task_id")
                or top.get("id")
                or "no-id"
            ),
            "title": inner.get("title") or top.get("title") or "(no title)",
            "body": inner.get("body") or top.get("body") or "",
            "delivery_id": top.get("id"),
        }
    except Exception as exc:
        log.warning("fetch_pending failed: %s", exc)
        return None


_NOTIFY_DEDUP: dict[tuple[str, str, str], float] = {}


async def _notify_owner(from_agent: str, task_id: str, title: str) -> None:
    """Send Telegram pre-ack to the agent owner. Skips degraded payloads + 5-min dedup."""
    if not OWNER_CHAT_ID:
        log.debug("notify_owner skip — WEBHOOK_OWNER_CHAT_ID not set")
        return
    import time as _time
    # Skip 3-way degraded payloads (residual swarm worker retries, not real tasks).
    if from_agent == "unknown" and task_id == "no-id" and "degraded" in title.lower():
        log.info("notify_owner skip 3-way-degraded payload (silent retry)")
        return
    key = (from_agent, task_id, title)
    now = _time.time()
    last = _NOTIFY_DEDUP.get(key, 0.0)
    if now - last < NOTIFY_TTL_SEC:
        log.info(
            "notify_owner dedup skip from=%s task_id=%s (last %.0fs ago)",
            from_agent, task_id, now - last,
        )
        return
    if len(_NOTIFY_DEDUP) > 100:
        cutoff = now - NOTIFY_TTL_SEC
        for k in [kk for kk, ts in _NOTIFY_DEDUP.items() if ts < cutoff]:
            del _NOTIFY_DEDUP[k]
    _NOTIFY_DEDUP[key] = now
    try:
        import aiohttp
        token = TG_BOT_TOKEN_FILE.read_text().strip()
        safe_from = html.escape(str(from_agent), quote=False)
        safe_task_id = html.escape(str(task_id), quote=False)
        safe_title = html.escape(str(title), quote=False)
        text = (
            f"<b>Task accepted.</b>\n\n"
            f"From: <b>{safe_from}</b>\n"
            f"task_id: <code>{safe_task_id}</code>\n"
            f"Title: <b>{safe_title}</b>\n\n"
            f"Working on it. Will report when done."
        )
        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"https://api.telegram.org/bot{token}/sendMessage",
                json={"chat_id": OWNER_CHAT_ID, "text": text, "parse_mode": "HTML"},
                timeout=aiohttp.ClientTimeout(total=10),
            ) as resp:
                if resp.status != 200:
                    log.warning(
                        "notify_owner HTTP %d: %s",
                        resp.status,
                        (await resp.text())[:200],
                    )
                else:
                    log.info(
                        "notified owner about task_id=%s from=%s", task_id, from_agent
                    )
    except Exception as exc:
        log.warning("notify_owner failed: %s", exc)


async def handle_webhook(request: web.Request) -> web.Response:
    body = await request.read()

    if not _verify_bearer(request):
        log.warning("auth failed from %s", request.remote)
        return web.Response(status=401, text="auth failed")

    try:
        payload = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        log.warning("bad payload: %s", exc)
        return web.Response(status=400, text="invalid JSON body")

    task_id = payload.get("task_id") or payload.get("_task_id") or "no-id"
    from_agent = payload.get("from_agent") or payload.get("from") or "unknown"

    # P0.5 swarm worker degraded-payload case: the worker sends task_id="no-id"
    # (and typically from_agent="unknown" + "degraded" in title). Title-only
    # missing is NOT a degraded signal — a real task with no title would be
    # silently dropped. Gate strictly on task_id.
    if task_id == "no-id":
        enriched = await _fetch_pending_task(AGENT_NAME)
        if enriched:
            from_agent = enriched["from_agent"]
            task_id = _sanitize_task_id(str(enriched["task_id"]))
            # Write enriched values back into payload so _build_prompt embeds
            # the real task_id (otherwise step 7 tells Claude to ack "no-id").
            payload["from_agent"] = from_agent
            payload["task_id"] = task_id
            payload.setdefault("title", enriched["title"])
            payload.setdefault("body", enriched["body"])
            payload["_enriched_from"] = "gbrain.list_my_pending"
            if enriched.get("delivery_id"):
                payload["_delivery_id"] = enriched["delivery_id"]
            log.info(
                "webhook enriched from gbrain: task_id=%s title=%s",
                task_id, enriched["title"],
            )
        else:
            log.info("webhook degraded and gbrain list_my_pending empty — silent ack")
            return web.json_response({"status": "empty_inbox"})
    else:
        # Non-degraded payload: still normalize task_id so downstream uses
        # the sanitized form.
        task_id = _sanitize_task_id(str(task_id))
        payload["task_id"] = task_id

    title = payload.get("title") or "(no title)"
    await _notify_owner(from_agent, task_id, title)

    prompt = _build_prompt(payload)
    await _spawn_claude(prompt, task_id)

    log.info("webhook accepted: from=%s task_id=%s", from_agent, task_id)
    return web.json_response({"status": "accepted", "task_id": task_id})


async def handle_healthz(_: web.Request) -> web.Response:
    # Liveness probe only. Intentionally does not echo workspace path,
    # claude binary path, or any other server-side configuration — those
    # are useful only for the operator and leak deployment shape if the
    # listener is ever exposed beyond loopback.
    return web.json_response({"status": "ok"})


def make_app() -> web.Application:
    app = web.Application()
    app.router.add_post("/hooks/agent", handle_webhook)
    app.router.add_get("/healthz", handle_healthz)
    return app


def main() -> None:
    log.info(
        "starting dashi-plugin-webhook on %s:%d (agent=%s workspace=%s)",
        BIND_HOST, PORT, AGENT_NAME, AGENT_WORKSPACE,
    )
    web.run_app(make_app(), host=BIND_HOST, port=PORT, access_log=None)


if __name__ == "__main__":
    main()
