"""Reminder store: CRUD operations against the reminders table."""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

import asyncpg

logger = logging.getLogger(__name__)

MAX_RETRY_COUNT = 5


def _row_to_dict(row: Any) -> dict[str, Any]:
    fires_at = row["fires_at"]
    sent_at = row["sent_at"]
    created_at = row["created_at"]
    return {
        "id": row["id"],
        "chat_id": row["chat_id"],
        "text": row["text"],
        "fires_at": fires_at.isoformat() if hasattr(fires_at, "isoformat") else fires_at,
        "sent_at": sent_at.isoformat() if (sent_at and hasattr(sent_at, "isoformat")) else sent_at,
        "retry_count": row["retry_count"],
        "created_by": row["created_by"],
        "created_at": created_at.isoformat() if hasattr(created_at, "isoformat") else created_at,
    }


async def create_reminder(
    pool: asyncpg.Pool,
    chat_id: str,
    text: str,
    fires_at: datetime,
    created_by: str = "alfred",
) -> dict[str, Any]:
    """Create a reminder record.

    Args:
        pool: Asyncpg connection pool.
        chat_id: Telegram chat ID to deliver to.
        text: Reminder message text.
        fires_at: Timezone-aware UTC datetime when to fire.
        created_by: Agent that created the reminder.

    Returns:
        Created reminder dict.

    Raises:
        ValueError: If fires_at is naive, in the past, or text is empty.
    """
    if fires_at.tzinfo is None:
        raise ValueError("fires_at must be timezone-aware (use datetime with tzinfo)")
    now = datetime.now(tz=timezone.utc)
    if fires_at <= now:
        raise ValueError(f"fires_at must be in the future, got {fires_at.isoformat()}")
    if not text or not text.strip():
        raise ValueError("text must not be empty")

    row = await pool.fetchrow(
        """
        INSERT INTO reminders (chat_id, text, fires_at, created_by)
        VALUES ($1, $2, $3, $4)
        RETURNING id, chat_id, text, fires_at, sent_at, retry_count, created_by, created_at
        """,
        chat_id,
        text.strip(),
        fires_at,
        created_by,
    )
    logger.info("reminder.create id=%d chat_id=%s fires_at=%s", row["id"], chat_id, fires_at)
    return _row_to_dict(row)


async def fetch_due(
    pool: asyncpg.Pool,
    limit: int = 100,
) -> list[dict[str, Any]]:
    """Fetch pending reminders whose fires_at <= now().

    Uses FOR UPDATE SKIP LOCKED so parallel dispatcher instances
    never double-process the same reminder.

    Args:
        pool: Asyncpg connection pool.
        limit: Maximum batch size.

    Returns:
        List of due reminder dicts.
    """
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT id, chat_id, text, fires_at, sent_at, retry_count, created_by, created_at
            FROM reminders
            WHERE fires_at <= now()
              AND sent_at IS NULL
              AND retry_count < $1
            ORDER BY fires_at ASC
            LIMIT $2
            FOR UPDATE SKIP LOCKED
            """,
            MAX_RETRY_COUNT,
            limit,
        )
    return [_row_to_dict(r) for r in rows]


async def mark_sent(
    pool: asyncpg.Pool,
    reminder_id: int,
) -> None:
    """Mark a reminder as successfully sent.

    Args:
        pool: Asyncpg connection pool.
        reminder_id: ID of the reminder to mark.
    """
    await pool.execute(
        "UPDATE reminders SET sent_at = now() WHERE id = $1",
        reminder_id,
    )
    logger.info("reminder.sent id=%d", reminder_id)


async def mark_retry(
    pool: asyncpg.Pool,
    reminder_id: int,
) -> None:
    """Increment retry_count after a failed send attempt.

    Args:
        pool: Asyncpg connection pool.
        reminder_id: ID of the reminder to update.
    """
    await pool.execute(
        "UPDATE reminders SET retry_count = retry_count + 1 WHERE id = $1",
        reminder_id,
    )
    logger.warning("reminder.retry id=%d", reminder_id)


async def cancel_reminder(
    pool: asyncpg.Pool,
    reminder_id: int,
) -> dict[str, Any] | None:
    """Cancel a reminder (delete it).

    Args:
        pool: Asyncpg connection pool.
        reminder_id: ID of the reminder to cancel.

    Returns:
        Cancelled reminder dict or None if not found.
    """
    row = await pool.fetchrow(
        """
        DELETE FROM reminders WHERE id = $1
        RETURNING id, chat_id, text, fires_at, sent_at, retry_count, created_by, created_at
        """,
        reminder_id,
    )
    if row is None:
        return None
    logger.info("reminder.cancel id=%d", reminder_id)
    return _row_to_dict(row)


async def list_reminders(
    pool: asyncpg.Pool,
    chat_id: str | None = None,
    include_sent: bool = False,
) -> list[dict[str, Any]]:
    """List reminders with optional filters.

    Args:
        pool: Asyncpg connection pool.
        chat_id: Filter by Telegram chat ID.
        include_sent: Include already-sent reminders.

    Returns:
        List of reminder dicts ordered by fires_at ASC.
    """
    conditions: list[str] = []
    params: list[Any] = []
    idx = 1

    if chat_id is not None:
        conditions.append(f"chat_id = ${idx}")
        params.append(chat_id)
        idx += 1

    if not include_sent:
        conditions.append("sent_at IS NULL")

    where = ("WHERE " + " AND ".join(conditions)) if conditions else ""
    rows = await pool.fetch(
        f"""
        SELECT id, chat_id, text, fires_at, sent_at, retry_count, created_by, created_at
        FROM reminders
        {where}
        ORDER BY fires_at ASC
        LIMIT 200
        """,
        *params,
    )
    return [_row_to_dict(r) for r in rows]
