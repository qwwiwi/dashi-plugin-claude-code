"""Unit tests for reminder dispatcher loop: timing, no duplicates, retry on error, catch-up."""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from services.reminder_dispatcher.dispatcher import run_once


def _due_reminder(id: int = 1, chat_id: str = "123", text: str = "hello") -> dict[str, Any]:
    return {
        "id": id,
        "chat_id": chat_id,
        "text": text,
        "fires_at": datetime.now(tz=timezone.utc) - timedelta(minutes=1),
        "sent_at": None,
        "retry_count": 0,
    }


def _make_pool():
    pool = MagicMock()
    return pool


# ---------------------------------------------------------------------------
# Fires on time / not early
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_run_once_sends_due_reminders():
    """run_once sends all due reminders and marks them sent."""
    reminder = _due_reminder(id=1, chat_id="111", text="Test!")
    pool = _make_pool()

    sent_calls = []

    async def fake_send(chat_id: str, text: str, token: str) -> None:
        sent_calls.append({"chat_id": chat_id, "text": text})

    with (
        patch("services.reminder_dispatcher.dispatcher.store.fetch_due", new=AsyncMock(return_value=[reminder])),
        patch("services.reminder_dispatcher.dispatcher.store.mark_sent", new=AsyncMock()) as mock_mark_sent,
    ):
        count = await run_once(pool=pool, token="fake-token", send_fn=fake_send)

    assert count == 1
    assert sent_calls[0]["chat_id"] == "111"
    assert sent_calls[0]["text"] == "Test!"
    mock_mark_sent.assert_awaited_once_with(pool, reminder_id=1)


@pytest.mark.asyncio
async def test_run_once_returns_zero_when_nothing_due():
    """run_once returns 0 when no pending reminders."""
    pool = _make_pool()

    async def fake_send(chat_id: str, text: str, token: str) -> None:
        raise AssertionError("should not be called")

    with patch("services.reminder_dispatcher.dispatcher.store.fetch_due", new=AsyncMock(return_value=[])):
        count = await run_once(pool=pool, token="fake-token", send_fn=fake_send)

    assert count == 0


# ---------------------------------------------------------------------------
# No duplicates (idempotency)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_run_once_does_not_send_already_sent_reminder():
    """Already-sent reminders (sent_at != None) are never returned by fetch_due."""
    # fetch_due only returns unsent — if it returns empty, run_once sends nothing
    pool = _make_pool()
    send_calls = []

    async def fake_send(chat_id: str, text: str, token: str) -> None:
        send_calls.append(chat_id)

    with patch("services.reminder_dispatcher.dispatcher.store.fetch_due", new=AsyncMock(return_value=[])):
        count = await run_once(pool=pool, token="fake-token", send_fn=fake_send)

    assert count == 0
    assert len(send_calls) == 0


# ---------------------------------------------------------------------------
# Catch-up after downtime
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_run_once_catches_up_overdue_reminders():
    """Reminders that are hours past their fires_at are still sent."""
    old_reminder = _due_reminder(id=10, chat_id="999", text="Very late!")
    # fires_at is far in the past — simulating downtime
    old_reminder["fires_at"] = datetime.now(tz=timezone.utc) - timedelta(hours=6)

    pool = _make_pool()
    sent_calls = []

    async def fake_send(chat_id: str, text: str, token: str) -> None:
        sent_calls.append({"chat_id": chat_id, "text": text})

    with (
        patch("services.reminder_dispatcher.dispatcher.store.fetch_due", new=AsyncMock(return_value=[old_reminder])),
        patch("services.reminder_dispatcher.dispatcher.store.mark_sent", new=AsyncMock()),
    ):
        count = await run_once(pool=pool, token="fake-token", send_fn=fake_send)

    assert count == 1
    assert sent_calls[0]["chat_id"] == "999"


# ---------------------------------------------------------------------------
# Retry on Telegram API error
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_run_once_calls_mark_retry_on_send_failure():
    """When send fails, mark_retry is called instead of mark_sent."""
    reminder = _due_reminder(id=2, chat_id="555")
    pool = _make_pool()

    async def failing_send(chat_id: str, text: str, token: str) -> None:
        raise RuntimeError("Telegram API error 429")

    with (
        patch("services.reminder_dispatcher.dispatcher.store.fetch_due", new=AsyncMock(return_value=[reminder])),
        patch("services.reminder_dispatcher.dispatcher.store.mark_sent", new=AsyncMock()) as mock_sent,
        patch("services.reminder_dispatcher.dispatcher.store.mark_retry", new=AsyncMock()) as mock_retry,
    ):
        count = await run_once(pool=pool, token="fake-token", send_fn=failing_send)

    assert count == 0
    mock_sent.assert_not_awaited()
    mock_retry.assert_awaited_once_with(pool, reminder_id=2)


@pytest.mark.asyncio
async def test_run_once_continues_after_single_send_failure():
    """A failure on one reminder does not stop processing the rest."""
    r1 = _due_reminder(id=1, chat_id="111", text="First")
    r2 = _due_reminder(id=2, chat_id="222", text="Second")
    pool = _make_pool()
    sent = []

    async def partial_send(chat_id: str, text: str, token: str) -> None:
        if chat_id == "111":
            raise RuntimeError("timeout")
        sent.append(chat_id)

    with (
        patch("services.reminder_dispatcher.dispatcher.store.fetch_due", new=AsyncMock(return_value=[r1, r2])),
        patch("services.reminder_dispatcher.dispatcher.store.mark_sent", new=AsyncMock()),
        patch("services.reminder_dispatcher.dispatcher.store.mark_retry", new=AsyncMock()),
    ):
        count = await run_once(pool=pool, token="fake-token", send_fn=partial_send)

    assert count == 1
    assert "222" in sent
