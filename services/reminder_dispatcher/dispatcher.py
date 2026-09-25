"""Reminder dispatcher: polls DB for due reminders and delivers to Telegram."""
from __future__ import annotations

import asyncio
import logging
from typing import Awaitable, Callable, Optional

import asyncpg

from . import store
from .sender import send_message

logger = logging.getLogger(__name__)

DEFAULT_INTERVAL_SECONDS = 30

_SendFn = Callable[[str, str, str], Awaitable[None]]


async def run_once(
    pool: asyncpg.Pool,
    token: str,
    send_fn: Optional[_SendFn] = None,
) -> int:
    """Fetch due reminders, send each, mark sent or retry on failure.

    Args:
        pool: Asyncpg connection pool.
        token: Telegram Bot token (never logged).
        send_fn: Optional injectable sender (for tests). Defaults to send_message.

    Returns:
        Number of successfully sent reminders.
    """
    sender = send_fn or send_message
    due = await store.fetch_due(pool)

    if not due:
        return 0

    sent_count = 0
    for reminder in due:
        rid = reminder["id"]
        try:
            await sender(reminder["chat_id"], reminder["text"], token)
            await store.mark_sent(pool, reminder_id=rid)
            sent_count += 1
        except Exception:
            logger.exception("reminder.send_failed id=%d", rid)
            await store.mark_retry(pool, reminder_id=rid)

    return sent_count


async def run_loop(
    pool: asyncpg.Pool,
    token: str,
    interval_seconds: int = DEFAULT_INTERVAL_SECONDS,
) -> None:
    """Main dispatcher loop. Runs until cancelled.

    Args:
        pool: Asyncpg connection pool.
        token: Telegram Bot token.
        interval_seconds: Polling interval in seconds.
    """
    logger.info("dispatcher.start interval=%ds", interval_seconds)
    while True:
        try:
            count = await run_once(pool=pool, token=token)
            if count:
                logger.info("dispatcher.tick sent=%d", count)
        except asyncio.CancelledError:
            logger.info("dispatcher.stop")
            raise
        except Exception:
            logger.exception("dispatcher.tick_error")

        await asyncio.sleep(interval_seconds)
