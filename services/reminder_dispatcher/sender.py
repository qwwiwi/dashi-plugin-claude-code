"""Telegram Bot API sender for reminder delivery."""
from __future__ import annotations

import logging
from typing import Optional

import httpx

logger = logging.getLogger(__name__)

TELEGRAM_API_BASE = "https://api.telegram.org"


async def send_message(
    chat_id: str,
    text: str,
    token: str,
    client: Optional[httpx.AsyncClient] = None,
) -> None:
    """Send a Telegram message via Bot API sendMessage.

    Args:
        chat_id: Telegram chat ID (string).
        text: Message text.
        token: Bot token (never logged).
        client: Optional httpx.AsyncClient for injection in tests.

    Raises:
        httpx.HTTPStatusError: On non-2xx response from Telegram API.
    """
    url = f"{TELEGRAM_API_BASE}/bot{token}/sendMessage"
    payload = {"chat_id": chat_id, "text": text}

    # Log without token
    logger.info("reminder.send chat_id=%s text_len=%d", chat_id, len(text))

    if client is not None:
        response = await client.post(url, json=payload)
        response.raise_for_status()
        return

    async with httpx.AsyncClient(timeout=15.0) as auto_client:
        response = await auto_client.post(url, json=payload)
        response.raise_for_status()
