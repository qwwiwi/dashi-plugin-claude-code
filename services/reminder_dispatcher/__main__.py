"""Entry point: starts FastMCP server + dispatcher loop in parallel.

Usage:
    python -m services.reminder_dispatcher

Required env vars:
    PG_PASSWORD        - PostgreSQL password
    TELEGRAM_BOT_TOKEN - Telegram Bot API token for delivery

Optional env vars:
    PGHOST                      (default: localhost)
    PGPORT                      (default: 5432)
    PGDATABASE                  (default: gbrain)
    PGUSER                      (default: gbrain)
    MCP_HOST                    (default: 0.0.0.0)
    MCP_PORT                    (default: 8770)
    DISPATCHER_INTERVAL_SECONDS (default: 30)
"""
from __future__ import annotations

import asyncio
import logging
import os
import sys

import asyncpg

from .dispatcher import run_loop

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)


def _require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        logger.error("Required env var %s is not set. Aborting.", name)
        sys.exit(1)
    return value


def _build_dsn() -> str:
    host = os.environ.get("PGHOST", "localhost")
    port = os.environ.get("PGPORT", "5432")
    dbname = os.environ.get("PGDATABASE", "gbrain")
    user = os.environ.get("PGUSER", "gbrain")
    password = _require_env("PG_PASSWORD")
    return f"postgresql://{user}:{password}@{host}:{port}/{dbname}"


async def _main() -> None:
    token = _require_env("TELEGRAM_BOT_TOKEN")
    interval = int(os.environ.get("DISPATCHER_INTERVAL_SECONDS", "30"))
    dsn = _build_dsn()

    pool = await asyncpg.create_pool(dsn, min_size=2, max_size=10, command_timeout=30)
    logger.info("reminder-dispatcher started interval=%ds", interval)

    try:
        await run_loop(pool=pool, token=token, interval_seconds=interval)
    finally:
        await pool.close()
        logger.info("reminder-dispatcher stopped")


if __name__ == "__main__":
    asyncio.run(_main())
