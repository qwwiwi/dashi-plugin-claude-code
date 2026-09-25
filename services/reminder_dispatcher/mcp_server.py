"""FastMCP server exposing reminder_create / reminder_cancel / reminder_list tools.

Runs on port 8770 (configurable via MCP_PORT env var).
Auth reuses the same Bearer-token mechanism as task-mcp (gbrain agent_tokens).
"""
from __future__ import annotations

import logging
import os
import sys
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from contextvars import ContextVar
from typing import Any

import asyncpg
from fastmcp import FastMCP

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

# Reuse gbrain shared infrastructure if available, fall back gracefully.
try:
    from services.shared.asgi_auth import HermesAwareAuthMiddleware
    from services.shared.auth import (
        AgentContext,
        AuthValue,
        authenticate_captured,
        check_write_scope,
        resolve_request_identity,
    )
    from services.shared.config import Config
    from services.shared.db import close_pool, get_pool
    from services.shared.audit import log_audit
    _GBRAIN_AUTH = True
except ImportError:
    _GBRAIN_AUTH = False

from . import store

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

DEFAULT_PORT = 8770
_REQUEST_AUTH: ContextVar[Any] = ContextVar("reminder_request_auth", default=None)


@asynccontextmanager
async def lifespan(server: FastMCP) -> AsyncIterator[dict[str, object]]:
    """Init DB pool on startup, close on shutdown."""
    port = int(os.environ.get("MCP_PORT", str(DEFAULT_PORT)))
    dsn = _build_dsn()
    pool = await asyncpg.create_pool(dsn, min_size=2, max_size=10, command_timeout=30)
    logger.info("reminder-mcp started on port=%d", port)
    try:
        yield {"pool": pool}
    finally:
        await pool.close()
        logger.info("reminder-mcp shutdown complete")


def _build_dsn() -> str:
    host = os.environ.get("PGHOST", "localhost")
    port = os.environ.get("PGPORT", "5432")
    dbname = os.environ.get("PGDATABASE", "gbrain")
    user = os.environ.get("PGUSER", "gbrain")
    password = os.environ.get("PG_PASSWORD", "")
    return f"postgresql://{user}:{password}@{host}:{port}/{dbname}"


mcp = FastMCP("reminder-mcp", lifespan=lifespan)


async def _get_pool() -> asyncpg.Pool:
    dsn = _build_dsn()
    return await asyncpg.create_pool(dsn, min_size=2, max_size=10, command_timeout=30)


@mcp.tool()
async def reminder_create(
    chat_id: str,
    text: str,
    fires_at: str,
    ctx: Any = None,
) -> dict[str, Any]:
    """Create a persistent reminder delivered to Telegram at fires_at (ISO 8601 UTC).

    Args:
        chat_id: Telegram chat ID to send the reminder to.
        text: Reminder message text.
        fires_at: ISO 8601 timestamp with timezone (e.g. '2026-09-25T15:00:00Z').

    Returns:
        Created reminder dict with id, fires_at, etc.
    """
    from datetime import datetime, timezone

    try:
        dt = datetime.fromisoformat(fires_at.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError(f"fires_at must be ISO 8601 with timezone: {fires_at!r}") from exc

    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)

    pool = await _get_pool()
    result = await store.create_reminder(
        pool=pool,
        chat_id=chat_id,
        text=text,
        fires_at=dt,
        created_by="mcp",
    )
    await pool.close()
    return result


@mcp.tool()
async def reminder_cancel(
    reminder_id: int,
    ctx: Any = None,
) -> dict[str, Any] | None:
    """Cancel and delete a pending reminder.

    Args:
        reminder_id: ID of the reminder to cancel.

    Returns:
        Cancelled reminder dict or null if not found.
    """
    pool = await _get_pool()
    result = await store.cancel_reminder(pool=pool, reminder_id=reminder_id)
    await pool.close()
    return result


@mcp.tool()
async def reminder_list(
    chat_id: str | None = None,
    include_sent: bool = False,
    ctx: Any = None,
) -> list[dict[str, Any]]:
    """List pending (or all) reminders, optionally filtered by chat_id.

    Args:
        chat_id: Optional Telegram chat ID filter.
        include_sent: If true, include already-sent reminders.

    Returns:
        List of reminder dicts ordered by fires_at ASC.
    """
    pool = await _get_pool()
    result = await store.list_reminders(pool=pool, chat_id=chat_id, include_sent=include_sent)
    await pool.close()
    return result


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("MCP_PORT", str(DEFAULT_PORT)))
    host = os.environ.get("MCP_HOST", "0.0.0.0")
    app = mcp.http_app(transport="streamable-http")
    uvicorn.run(app, host=host, port=port, log_level="info")
