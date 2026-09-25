-- Reminders table for persistent, timezone-aware reminder delivery.
-- Idempotent: safe to re-run.
--
-- Usage: alfred stores reminders via reminder_create MCP tool.
-- Dispatcher polls this table every N seconds and delivers via Telegram Bot API.
-- Idempotency at query level: dispatcher uses FOR UPDATE SKIP LOCKED.

CREATE TABLE IF NOT EXISTS reminders (
    id          bigserial   PRIMARY KEY,
    chat_id     text        NOT NULL,
    text        text        NOT NULL,
    fires_at    timestamptz NOT NULL,
    sent_at     timestamptz,
    retry_count int         NOT NULL DEFAULT 0,
    created_by  text        NOT NULL DEFAULT 'alfred',
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- Partial index: only pending (unsent) reminders need fast lookup by fires_at.
CREATE INDEX IF NOT EXISTS idx_reminders_fires_at_pending
    ON reminders (fires_at ASC)
    WHERE sent_at IS NULL;

-- Grants ------------------------------------------------------------------

GRANT ALL PRIVILEGES ON TABLE reminders TO gbrain;
GRANT ALL PRIVILEGES ON SEQUENCE reminders_id_seq TO gbrain;
