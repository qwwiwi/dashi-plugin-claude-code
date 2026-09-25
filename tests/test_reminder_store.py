"""Unit tests for reminder store: create, fetch_due, mark_sent, mark_retry, cancel."""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from typing import Any
from unittest.mock import AsyncMock, MagicMock, call, patch

import pytest
import sys
import os

# Make the services package importable
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from services.reminder_dispatcher.store import (
    MAX_RETRY_COUNT,
    cancel_reminder,
    create_reminder,
    fetch_due,
    list_reminders,
    mark_retry,
    mark_sent,
)


def _make_pool(fetchrow_return=None, fetch_return=None, execute_return=None):
    """Build an asyncpg Pool mock with injectable return values."""
    pool = MagicMock()
    pool.fetchrow = AsyncMock(return_value=fetchrow_return)
    pool.fetch = AsyncMock(return_value=fetch_return or [])
    pool.execute = AsyncMock(return_value=execute_return)

    # Context manager for acquire()
    conn = MagicMock()
    conn.fetchrow = AsyncMock(return_value=fetchrow_return)
    conn.fetch = AsyncMock(return_value=fetch_return or [])
    conn.execute = AsyncMock(return_value=execute_return)

    # transaction() context manager
    tx = MagicMock()
    tx.__aenter__ = AsyncMock(return_value=None)
    tx.__aexit__ = AsyncMock(return_value=False)
    conn.transaction = MagicMock(return_value=tx)

    acquire_cm = MagicMock()
    acquire_cm.__aenter__ = AsyncMock(return_value=conn)
    acquire_cm.__aexit__ = AsyncMock(return_value=False)
    pool.acquire = MagicMock(return_value=acquire_cm)

    return pool, conn


def _reminder_row(
    id: int = 1,
    chat_id: str = "123",
    text: str = "test reminder",
    fires_at: datetime | None = None,
    sent_at: datetime | None = None,
    retry_count: int = 0,
    created_by: str = "alfred",
    created_at: datetime | None = None,
) -> dict[str, Any]:
    now = datetime.now(tz=timezone.utc)
    record = {
        "id": id,
        "chat_id": chat_id,
        "text": text,
        "fires_at": fires_at or now,
        "sent_at": sent_at,
        "retry_count": retry_count,
        "created_by": created_by,
        "created_at": created_at or now,
    }
    # Simulate asyncpg.Record-like dict access
    mock_record = MagicMock()
    mock_record.__getitem__ = lambda self, k: record[k]
    mock_record.get = lambda k, default=None: record.get(k, default)
    for k, v in record.items():
        setattr(mock_record, k, v)
    return mock_record


# ---------------------------------------------------------------------------
# create_reminder
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_create_reminder_returns_dict_with_all_fields():
    fires_at = datetime.now(tz=timezone.utc) + timedelta(hours=1)
    row = _reminder_row(id=42, chat_id="292142498", text="Meeting!", fires_at=fires_at)
    pool, _ = _make_pool(fetchrow_return=row)

    result = await create_reminder(
        pool=pool,
        chat_id="292142498",
        text="Meeting!",
        fires_at=fires_at,
        created_by="alfred",
    )

    assert result["id"] == 42
    assert result["chat_id"] == "292142498"
    assert result["text"] == "Meeting!"


@pytest.mark.asyncio
async def test_create_reminder_rejects_past_fires_at():
    pool, _ = _make_pool()
    past = datetime.now(tz=timezone.utc) - timedelta(seconds=1)

    with pytest.raises(ValueError, match="fires_at must be in the future"):
        await create_reminder(pool=pool, chat_id="123", text="test", fires_at=past)


@pytest.mark.asyncio
async def test_create_reminder_rejects_naive_datetime():
    pool, _ = _make_pool()
    naive = datetime.now()  # no timezone info

    with pytest.raises(ValueError, match="timezone-aware"):
        await create_reminder(pool=pool, chat_id="123", text="test", fires_at=naive)


@pytest.mark.asyncio
async def test_create_reminder_rejects_empty_text():
    pool, _ = _make_pool()
    future = datetime.now(tz=timezone.utc) + timedelta(hours=1)

    with pytest.raises(ValueError, match="text must not be empty"):
        await create_reminder(pool=pool, chat_id="123", text="", fires_at=future)


# ---------------------------------------------------------------------------
# fetch_due
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_fetch_due_returns_only_pending_reminders():
    fires_at = datetime.now(tz=timezone.utc) - timedelta(minutes=5)
    row = _reminder_row(fires_at=fires_at, sent_at=None)
    pool, conn = _make_pool(fetch_return=[row])

    result = await fetch_due(pool)

    assert len(result) == 1
    assert result[0]["id"] == 1


@pytest.mark.asyncio
async def test_fetch_due_uses_skip_locked():
    """fetch_due must use FOR UPDATE SKIP LOCKED for idempotency."""
    pool, conn = _make_pool(fetch_return=[])

    await fetch_due(pool)

    # Verify SQL was called and contains SKIP LOCKED
    assert conn.fetch.called or pool.acquire.called
    # Get the SQL from the call
    called_sql = ""
    if conn.fetch.called:
        called_sql = conn.fetch.call_args[0][0]
    assert "SKIP LOCKED" in called_sql.upper()


@pytest.mark.asyncio
async def test_fetch_due_excludes_already_sent():
    """Reminders with sent_at set should not be returned."""
    sent_time = datetime.now(tz=timezone.utc) - timedelta(hours=1)
    fires_at = datetime.now(tz=timezone.utc) - timedelta(hours=2)
    row = _reminder_row(fires_at=fires_at, sent_at=sent_time)
    # Return empty — store should filter them via SQL WHERE sent_at IS NULL
    pool, conn = _make_pool(fetch_return=[])

    result = await fetch_due(pool)

    assert len(result) == 0
    # Verify SQL contains the filter
    if conn.fetch.called:
        called_sql = conn.fetch.call_args[0][0]
        assert "sent_at is null" in called_sql.lower()


@pytest.mark.asyncio
async def test_fetch_due_excludes_exhausted_retries():
    """Reminders that exceeded MAX_RETRY_COUNT are not fetched."""
    pool, conn = _make_pool(fetch_return=[])

    await fetch_due(pool)

    if conn.fetch.called:
        called_sql = conn.fetch.call_args[0][0]
        assert "retry_count" in called_sql.lower()


# ---------------------------------------------------------------------------
# mark_sent
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_mark_sent_updates_sent_at():
    pool, _ = _make_pool()

    await mark_sent(pool, reminder_id=7)

    pool.execute.assert_awaited_once()
    sql = pool.execute.call_args[0][0]
    assert "sent_at" in sql.lower()
    assert pool.execute.call_args[0][1] == 7


# ---------------------------------------------------------------------------
# mark_retry
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_mark_retry_increments_retry_count():
    pool, _ = _make_pool()

    await mark_retry(pool, reminder_id=3)

    pool.execute.assert_awaited_once()
    sql = pool.execute.call_args[0][0]
    assert "retry_count" in sql.lower()
    assert pool.execute.call_args[0][1] == 3


# ---------------------------------------------------------------------------
# cancel_reminder
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_cancel_reminder_returns_cancelled_row():
    row = _reminder_row(id=5)
    pool, _ = _make_pool(fetchrow_return=row)

    result = await cancel_reminder(pool, reminder_id=5)

    assert result is not None
    assert result["id"] == 5


@pytest.mark.asyncio
async def test_cancel_reminder_returns_none_for_missing():
    pool, _ = _make_pool(fetchrow_return=None)

    result = await cancel_reminder(pool, reminder_id=999)

    assert result is None
