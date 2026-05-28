#!/usr/bin/env python3
"""Claude Code Stop hook for multichat-thrall — bridge transcript → outbox.

Role:
    In headless mode the router captures the SDK ``result`` event and writes
    the agent's final text to the per-chat outbox. In *interactive* (tmux)
    mode there is no ``result`` event — the per-chat ``claude`` session only
    prints to its transcript JSONL, so nothing ever lands in
    ``{MULTICHAT_STATE_DIR}/chats/{CHAT_ID}/outbox/`` and the router has
    nothing to drain to Telegram. This Stop hook is the interactive-mode
    analog of capturing the headless ``result`` event: on every turn-end it
    extracts the latest assistant text from the transcript and writes an
    ``OutboxMessage`` JSON the router already knows how to send.

Extraction algorithm:
    Based on ``readLastAssistantText`` in ``src/memory/transcript-reader.ts``
    — tail-read the trailing ``TAIL_BYTES`` of the transcript and drop the
    first (possibly truncated) line when not starting at byte 0. It then walks
    lines backward to the MOST RECENT assistant message and returns its
    ``{"type": "text", "text": ...}`` blocks joined with newlines.

    Divergence from the memory reader (deliberate): if that most-recent
    assistant message is tool-use-only (no text blocks), we return ``None``
    rather than continuing back to an OLDER text message. For outbox delivery
    we must send only the reply of the turn that just ended — resurfacing an
    older answer would re-deliver a stale reply to Telegram after a tool-only
    turn, a resume, or a clear (the memory reader wants the last text ever,
    which is the opposite requirement).

Safety:
    Fail-safe everywhere — every error path exits 0 so the hook never blocks
    or crashes the session. ``chat_id`` is taken strictly from the ``CHAT_ID``
    environment variable, never from the transcript. Nothing is shelled out,
    so transcript content can never be shell-interpolated. Errors are logged
    to stderr only; stdout is kept clean.

Dedupe:
    Stop can fire repeatedly for the same turn. A state file records the last
    delivered ``(session_id, transcript_path, dedupe_token)``; an identical
    triple short-circuits with no write, preventing duplicate Telegram sends.
    ``dedupe_token`` is the assistant transcript line's ``uuid`` when present
    (falling back to the text hash), so two DIFFERENT turns that happen to
    reply with identical text (e.g. "Готово." twice) are NOT suppressed —
    only the same turn re-firing is.
    This assumes Claude Code serialises Stop invocations for a session (it
    does): two truly-concurrent fires could each read the pre-write state and
    both write. The atomic state rename prevents corruption, not that race —
    acceptable since a rare duplicate send beats a lost reply.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import secrets
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

TAIL_BYTES = 256 * 1024

# Telegram chat ids are integers (groups are negative). CHAT_ID is used as a
# filesystem path segment, so we reject anything else to block path-traversal
# / wrong-chat writes from a malformed env value.
_CHAT_ID_RE = re.compile(r"-?\d+")

logging.basicConfig(stream=sys.stderr, level=logging.INFO)
logger = logging.getLogger("stop-to-outbox")


def read_last_assistant_text(transcript_path: Path) -> tuple[str, str | None] | None:
    """Tail-read the latest assistant text from a Claude transcript JSONL.

    Based on ``readLastAssistantText`` (transcript-reader.ts): reads at most
    the trailing ``TAIL_BYTES`` bytes, drops the first possibly-truncated
    line when the read did not start at byte 0, then walks lines backward to
    the MOST RECENT assistant message and returns its
    ``{"type": "text", "text": str}`` blocks joined with newlines, together
    with that transcript line's ``uuid`` (when present) for dedupe.

    Args:
        transcript_path: Absolute path to the session transcript ``.jsonl``.

    Returns:
        ``(text, uuid)`` for the most recent assistant message — ``uuid`` is
        the transcript line's ``uuid`` field or ``None`` if absent. Returns
        ``None`` if the file is missing/empty/unreadable, there is no
        assistant message, or the most recent assistant message is
        tool-use-only (no text).
    """
    try:
        with transcript_path.open("rb") as fh:
            fh.seek(0, os.SEEK_END)
            size = fh.tell()
            if size == 0:
                return None
            length = min(size, TAIL_BYTES)
            start = size - length
            fh.seek(start, os.SEEK_SET)
            buf = fh.read(length)
    except OSError as exc:
        logger.error("transcript read failed: %s", exc)
        return None

    # errors="replace" guarantees decode never raises.
    text = buf.decode("utf-8", errors="replace")

    split = text.split("\n")
    lines = (split[1:] if start > 0 else split)
    lines = [line for line in lines if line]

    for line in reversed(lines):
        try:
            obj: Any = json.loads(line)
        except (ValueError, TypeError):
            continue
        if not isinstance(obj, dict):
            continue
        message = obj.get("message")
        if not isinstance(message, dict):
            continue
        if message.get("role") != "assistant":
            continue
        content = message.get("content")
        if not isinstance(content, list):
            continue
        parts: list[str] = []
        for block in content:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "text" and isinstance(block.get("text"), str):
                parts.append(block["text"])
        # This is the MOST RECENT assistant message. Return its text if any;
        # otherwise it is a tool-use-only final turn — return None rather than
        # resurfacing an older (already-delivered / stale) answer.
        if not parts:
            return None
        uuid = obj.get("uuid")
        return "\n".join(parts), (uuid if isinstance(uuid, str) and uuid else None)
    return None


def build_filename() -> str:
    """Build an outbox filename matching the router's ``buildFilename`` scheme.

    Returns:
        ``{epoch_ms}-{rand}.json`` where ``epoch_ms`` is millisecond unix time
        and ``rand`` is 4 hex chars (2 random bytes).
    """
    epoch_ms = int(time.time() * 1000)
    rand = secrets.token_hex(2)
    return f"{epoch_ms}-{rand}.json"


def atomic_write_json(target: Path, payload: dict[str, Any]) -> None:
    """Write ``payload`` as JSON to ``target`` atomically (tmp + fsync + rename).

    The router only consumes ``*.json`` files, so the intermediate ``.tmp``
    file is invisible to it mid-write.

    Args:
        target: Final destination path (must end in ``.json`` for the outbox).
        payload: JSON-serialisable mapping to write.
    """
    tmp = target.with_name(target.name + ".tmp")
    try:
        with tmp.open("w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False)
            fh.flush()
            os.fsync(fh.fileno())
        os.rename(tmp, target)
    except OSError:
        # Never leave an orphan .tmp behind. The router ignores non-.json
        # files, but a crash between open and rename would otherwise leak
        # tmp files into the outbox dir forever.
        try:
            tmp.unlink()
        except OSError:
            pass
        raise


def main() -> int:
    """Read the Stop payload, extract assistant text, write an OutboxMessage.

    Returns:
        Always ``0`` — every error path is fail-safe so the hook never
        blocks the session.
    """
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw)
    except (ValueError, TypeError):
        return 0
    if not isinstance(payload, dict):
        return 0

    chat_id = os.environ.get("CHAT_ID", "")
    state_dir = os.environ.get("MULTICHAT_STATE_DIR", "")
    if not chat_id or not state_dir:
        return 0
    if not _CHAT_ID_RE.fullmatch(chat_id):
        logger.error("invalid CHAT_ID shape; refusing to write")
        return 0

    transcript_path_raw = payload.get("transcript_path")
    if not isinstance(transcript_path_raw, str) or not transcript_path_raw:
        return 0
    session_id_raw = payload.get("session_id")
    session_id = session_id_raw if isinstance(session_id_raw, str) else ""

    extracted = read_last_assistant_text(Path(transcript_path_raw))
    if extracted is None:
        return 0
    assistant_text, assistant_uuid = extracted
    if not assistant_text.strip():
        return 0

    assistant_hash = hashlib.sha256(assistant_text.encode("utf-8")).hexdigest()
    # Dedupe discriminator: the transcript line's uuid uniquely identifies the
    # turn, so two DIFFERENT turns with identical text (e.g. "Готово." twice)
    # are NOT suppressed. Fall back to the text hash only when the transcript
    # carries no uuid.
    dedupe_token = assistant_uuid or assistant_hash

    chat_root = Path(state_dir) / "chats" / chat_id
    hook_state_dir = chat_root / ".hook-state"
    state_file = hook_state_dir / "last-stop-outbox.json"
    outbox_dir = chat_root / "outbox"

    # Dedupe: skip if this exact turn was already delivered.
    try:
        prior = json.loads(state_file.read_text(encoding="utf-8"))
        if (
            isinstance(prior, dict)
            and prior.get("session_id") == session_id
            and prior.get("transcript_path") == transcript_path_raw
            and prior.get("dedupe_token") == dedupe_token
        ):
            return 0
    except (OSError, ValueError, TypeError):
        pass  # No prior state / unreadable — proceed with write.

    try:
        outbox_dir.mkdir(parents=True, exist_ok=True)
        hook_state_dir.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        logger.error("mkdir failed: %s", exc)
        return 0

    now_iso = datetime.now(timezone.utc).isoformat()
    message: dict[str, Any] = {
        "text": assistant_text,
        "chat_id": chat_id,  # strictly from env, never from transcript
        "timestamp": now_iso,
        "format": "text",
    }

    final_path = outbox_dir / build_filename()
    try:
        atomic_write_json(final_path, message)
    except OSError as exc:
        logger.error("outbox write failed: %s", exc)
        return 0

    # Update dedupe state only after a successful outbox write.
    try:
        atomic_write_json(
            state_file,
            {
                "session_id": session_id,
                "transcript_path": transcript_path_raw,
                "dedupe_token": dedupe_token,
                "assistant_hash": assistant_hash,
                "sent_at": now_iso,
            },
        )
    except OSError as exc:
        logger.error("state write failed: %s", exc)
        # Outbox write already succeeded — fail-safe, don't undo it.

    return 0


if __name__ == "__main__":
    sys.exit(main())
