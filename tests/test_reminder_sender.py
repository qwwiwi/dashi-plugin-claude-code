"""Unit tests for Telegram sender: success, HTTP error, token not logged."""
from __future__ import annotations

import logging
import sys
import os
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from services.reminder_dispatcher.sender import send_message


class _FakeResponse:
    def __init__(self, status_code: int, json_data: dict):
        self.status_code = status_code
        self._json = json_data

    def raise_for_status(self):
        if self.status_code >= 400:
            import httpx
            raise httpx.HTTPStatusError(
                f"{self.status_code}",
                request=MagicMock(),
                response=MagicMock(status_code=self.status_code),
            )

    def json(self):
        return self._json


@pytest.mark.asyncio
async def test_send_message_posts_to_telegram_api():
    """send_message calls the Telegram Bot API sendMessage endpoint."""
    mock_client = AsyncMock()
    mock_client.post = AsyncMock(return_value=_FakeResponse(200, {"ok": True}))

    await send_message(chat_id="123", text="Hello!", token="bot-token", client=mock_client)

    mock_client.post.assert_awaited_once()
    url = mock_client.post.call_args[0][0]
    assert "sendMessage" in url
    assert "bot-token" in url


@pytest.mark.asyncio
async def test_send_message_raises_on_http_error():
    """send_message raises an exception on Telegram API HTTP error."""
    import httpx
    mock_client = AsyncMock()
    mock_client.post = AsyncMock(return_value=_FakeResponse(429, {"ok": False}))

    with pytest.raises(httpx.HTTPStatusError):
        await send_message(chat_id="123", text="Hello!", token="tok", client=mock_client)


@pytest.mark.asyncio
async def test_send_message_does_not_log_token(caplog):
    """Token must never appear in log output."""
    SECRET_TOKEN = "secret-bot-12345"
    mock_client = AsyncMock()
    mock_client.post = AsyncMock(return_value=_FakeResponse(200, {"ok": True}))

    with caplog.at_level(logging.DEBUG):
        await send_message(chat_id="123", text="test", token=SECRET_TOKEN, client=mock_client)

    for record in caplog.records:
        assert SECRET_TOKEN not in record.getMessage()


@pytest.mark.asyncio
async def test_send_message_passes_chat_id_and_text():
    """send_message sends correct chat_id and text in request body."""
    mock_client = AsyncMock()
    mock_client.post = AsyncMock(return_value=_FakeResponse(200, {"ok": True}))

    await send_message(chat_id="999", text="Reminder: call John", token="t", client=mock_client)

    call_kwargs = mock_client.post.call_args
    # Check either positional json param or keyword
    body = call_kwargs.kwargs.get("json") or (call_kwargs.args[1] if len(call_kwargs.args) > 1 else None)
    assert body is not None
    assert body["chat_id"] == "999"
    assert body["text"] == "Reminder: call John"
