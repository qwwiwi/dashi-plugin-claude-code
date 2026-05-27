"""Unit tests for webhook-listener/listener.py (v6.3 hot-patch).

Covers:
- Module loads cleanly when WEBHOOK_BEARER_FILE / WEBHOOK_LOG_DIR are set.
- Redacting formatter strips Bearer tokens and sk-* secrets from log records.
- _build_prompt embeds the configured agent name + task_id.
- _notify_owner is a no-op when WEBHOOK_OWNER_CHAT_ID is unset.
- _notify_owner skips 3-way degraded payloads (the v6.3 silent-retry rule).
- listener.py source has no Orgrimmar-internal identifiers (public-repo safety).
"""

from __future__ import annotations

import asyncio
import importlib.util
import json
import logging
import os
import sys
import tempfile
import unittest
from importlib.machinery import SourceFileLoader
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
LISTENER_PATH = REPO_ROOT / "webhook-listener" / "listener.py"


def _load_listener(tmpdir: Path) -> object:
    """Load listener.py with safe defaults pointing into tmpdir."""
    bearer_file = tmpdir / "bearer.token"
    bearer_file.write_text("test-bearer-secret\n", encoding="utf-8")
    log_dir = tmpdir / "log"
    log_dir.mkdir()

    os.environ["WEBHOOK_BEARER_FILE"] = str(bearer_file)
    os.environ["WEBHOOK_LOG_DIR"] = str(log_dir)
    os.environ["WEBHOOK_AGENT_WORKSPACE"] = str(tmpdir)
    os.environ["WEBHOOK_AGENT_NAME"] = "testagent"
    # Default tests run without enrichment to avoid surprising network gates.
    os.environ.pop("WEBHOOK_GBRAIN_SWARM_URL", None)
    # Make sure no owner pings get sent during tests.
    os.environ.pop("WEBHOOK_OWNER_CHAT_ID", None)

    # Force a fresh load so env var changes are honored across tests.
    sys.modules.pop("webhook_listener_under_test", None)
    loader = SourceFileLoader("webhook_listener_under_test", str(LISTENER_PATH))
    spec = importlib.util.spec_from_loader("webhook_listener_under_test", loader)
    module = importlib.util.module_from_spec(spec)
    sys.modules["webhook_listener_under_test"] = module
    loader.exec_module(module)
    return module


class ListenerImportTest(unittest.TestCase):
    def test_module_loads(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            tmpdir = Path(raw)
            module = _load_listener(tmpdir)
            self.assertEqual(module.AGENT_NAME, "testagent")
            self.assertEqual(module.BEARER_TOKEN, b"test-bearer-secret")
            self.assertTrue(module.LOG_DIR.exists())


class RedactingFormatterTest(unittest.TestCase):
    def test_redacts_bearer_and_sk(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            module = _load_listener(Path(raw))
            fmt = module.RedactingFormatter("%(message)s")
            record = logging.LogRecord(
                name="test",
                level=logging.INFO,
                pathname=__file__,
                lineno=1,
                msg="leak Bearer abcdefghij and sk-secretkey_123 and password=hunter2",
                args=(),
                exc_info=None,
            )
            out = fmt.format(record)
            self.assertNotIn("abcdefghij", out)
            self.assertNotIn("sk-secretkey_123", out)
            self.assertNotIn("hunter2", out)
            self.assertIn("<REDACTED>", out)


class BuildPromptTest(unittest.TestCase):
    def test_prompt_includes_agent_name_and_task_id(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            module = _load_listener(Path(raw))
            prompt = module._build_prompt({
                "from_agent": "sender-x",
                "task_id": "tid-42",
                "title": "Do the thing",
                "body": "body-here",
            })
            self.assertIn("testagent", prompt)
            self.assertIn("tid-42", prompt)
            self.assertIn("sender-x", prompt)
            self.assertIn("Do the thing", prompt)


class NotifyOwnerTest(unittest.TestCase):
    def test_notify_owner_noop_without_chat_id(self) -> None:
        """When WEBHOOK_OWNER_CHAT_ID is unset, _notify_owner is a silent no-op."""
        with tempfile.TemporaryDirectory() as raw:
            module = _load_listener(Path(raw))
            self.assertEqual(module.OWNER_CHAT_ID, "")
            # Should not raise, and should not touch the dedup map.
            asyncio.run(module._notify_owner("agent", "tid", "title"))
            self.assertEqual(module._NOTIFY_DEDUP, {})

    def test_notify_owner_skips_3way_degraded(self) -> None:
        """3-way degraded payload (unknown / no-id / degraded title) must be silent."""
        with tempfile.TemporaryDirectory() as raw:
            tmpdir = Path(raw)
            module = _load_listener(tmpdir)
            os.environ["WEBHOOK_OWNER_CHAT_ID"] = "12345"
            os.environ["WEBHOOK_TG_BOT_TOKEN_FILE"] = str(tmpdir / "bot.token")
            (tmpdir / "bot.token").write_text("fake-bot-token\n", encoding="utf-8")
            module.OWNER_CHAT_ID = "12345"
            module.TG_BOT_TOKEN_FILE = tmpdir / "bot.token"
            asyncio.run(module._notify_owner("unknown", "no-id", "degraded retry"))
            self.assertEqual(module._NOTIFY_DEDUP, {})


class TaskIdSanitizationTest(unittest.TestCase):
    def test_strips_unsafe_chars_and_caps_length(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            module = _load_listener(Path(raw))
            # Single quotes, newlines, backticks must not survive into prompt
            # nor into the log filename.
            hostile = "abc'\n`$(ls)`def\x00xyz" + "x" * 80
            cleaned = module._sanitize_task_id(hostile)
            self.assertNotIn("'", cleaned)
            self.assertNotIn("\n", cleaned)
            self.assertNotIn("`", cleaned)
            self.assertNotIn("$", cleaned)
            self.assertNotIn("\x00", cleaned)
            self.assertLessEqual(len(cleaned), 64)

    def test_empty_input_falls_back(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            module = _load_listener(Path(raw))
            # An input that is entirely unsafe characters collapses to underscores,
            # never to an empty string (which would corrupt path joining).
            cleaned = module._sanitize_task_id("''''")
            self.assertGreater(len(cleaned), 0)


class BuildPromptInjectionTest(unittest.TestCase):
    def test_prompt_does_not_carry_quote_or_newline(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            module = _load_listener(Path(raw))
            hostile = "evil'\n--break"
            prompt = module._build_prompt({
                "from_agent": "x",
                "task_id": hostile,
                "title": "t",
                "body": "b",
            })
            # task_id is single-quoted into a JSON-ish literal inside the
            # prompt; a raw single quote in the value would close the literal.
            self.assertNotIn("evil'", prompt)
            self.assertNotIn("'\n--break", prompt)


class NotifyOwnerHtmlEscapeTest(unittest.TestCase):
    """Hostile interpolation values must not break Telegram parse_mode=HTML."""

    def test_escapes_html_in_payload(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            tmpdir = Path(raw)
            module = _load_listener(tmpdir)
            (tmpdir / "bot.token").write_text("fake-bot\n", encoding="utf-8")
            module.OWNER_CHAT_ID = "12345"
            module.TG_BOT_TOKEN_FILE = tmpdir / "bot.token"

            captured: dict = {}

            class _FakeResp:
                status = 200

                async def text(self):
                    return ""

                async def __aenter__(self):
                    return self

                async def __aexit__(self, *a):
                    return False

            class _FakeSession:
                async def __aenter__(self):
                    return self

                async def __aexit__(self, *a):
                    return False

                def post(self, url, json=None, timeout=None):
                    captured["url"] = url
                    captured["json"] = json
                    return _FakeResp()

            import importlib
            fake_aiohttp = type(sys)("aiohttp_fake")
            fake_aiohttp.ClientSession = lambda: _FakeSession()
            fake_aiohttp.ClientTimeout = lambda total=None: None
            sys.modules["aiohttp"] = fake_aiohttp
            try:
                asyncio.run(module._notify_owner(
                    "agent<script>",
                    "tid<>&\"'",
                    "title</b><img src=x>",
                ))
            finally:
                sys.modules.pop("aiohttp", None)
                # Reload real aiohttp for any later tests that use it.
                importlib.invalidate_caches()

            self.assertIn("json", captured)
            body = captured["json"]
            self.assertEqual(body["parse_mode"], "HTML")
            self.assertNotIn("<script>", body["text"])
            self.assertNotIn("</b><img", body["text"])
            # Escaped form must appear instead.
            self.assertIn("&lt;script&gt;", body["text"])
            self.assertIn("&lt;/b&gt;", body["text"])


class SubprocessEnvAllowlistTest(unittest.TestCase):
    """`_build_subprocess_env` must drop WEBHOOK_* and other secrets."""

    def test_webhook_vars_not_forwarded(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            module = _load_listener(Path(raw))
            os.environ["WEBHOOK_GBRAIN_TOKEN_FILE"] = "/some/path"
            os.environ["WEBHOOK_TG_BOT_TOKEN_FILE"] = "/another/path"
            os.environ["SECRET_FOO"] = "should-not-leak"
            os.environ["CLAUDE_HARNESS_MARKER"] = "yes"
            try:
                env = module._build_subprocess_env()
                self.assertNotIn("WEBHOOK_GBRAIN_TOKEN_FILE", env)
                self.assertNotIn("WEBHOOK_TG_BOT_TOKEN_FILE", env)
                self.assertNotIn("SECRET_FOO", env)
                # Allowlisted prefix passes through.
                self.assertEqual(env.get("CLAUDE_HARNESS_MARKER"), "yes")
                # Baseline POSIX vars present.
                self.assertIn("HOME", env)
                self.assertIn("PATH", env)
            finally:
                os.environ.pop("WEBHOOK_GBRAIN_TOKEN_FILE", None)
                os.environ.pop("WEBHOOK_TG_BOT_TOKEN_FILE", None)
                os.environ.pop("SECRET_FOO", None)
                os.environ.pop("CLAUDE_HARNESS_MARKER", None)


class RequiredEnvTest(unittest.TestCase):
    def test_agent_name_required(self) -> None:
        """Empty WEBHOOK_AGENT_NAME must abort startup, not fall back to a default."""
        with tempfile.TemporaryDirectory() as raw:
            tmpdir = Path(raw)
            bearer_file = tmpdir / "bearer.token"
            bearer_file.write_text("t\n", encoding="utf-8")
            log_dir = tmpdir / "log"
            log_dir.mkdir()
            os.environ["WEBHOOK_BEARER_FILE"] = str(bearer_file)
            os.environ["WEBHOOK_LOG_DIR"] = str(log_dir)
            os.environ["WEBHOOK_AGENT_WORKSPACE"] = str(tmpdir)
            os.environ["WEBHOOK_AGENT_NAME"] = ""
            os.environ.pop("WEBHOOK_OWNER_CHAT_ID", None)
            sys.modules.pop("webhook_listener_under_test", None)
            loader = SourceFileLoader("webhook_listener_under_test", str(LISTENER_PATH))
            spec = importlib.util.spec_from_loader("webhook_listener_under_test", loader)
            module = importlib.util.module_from_spec(spec)
            sys.modules["webhook_listener_under_test"] = module
            with self.assertRaises(SystemExit):
                loader.exec_module(module)


class EnrichmentSortKeyTest(unittest.TestCase):
    """Numeric ids must sort by value, not lexicographic order."""

    def test_numeric_id_sort_picks_newest(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            module = _load_listener(Path(raw))

            class _FakeResp:
                status = 200

                async def text(self):
                    return json.dumps({
                        "result": {
                            "structuredContent": {
                                "result": [
                                    {"id": "9",  "payload": {"task_id": "old-9",  "title": "old"}},
                                    {"id": "10", "payload": {"task_id": "new-10", "title": "new"}},
                                ]
                            }
                        }
                    })

                async def __aenter__(self):
                    return self

                async def __aexit__(self, *a):
                    return False

            class _FakeSession:
                async def __aenter__(self):
                    return self

                async def __aexit__(self, *a):
                    return False

                def post(self, url, json=None, headers=None, timeout=None):
                    return _FakeResp()

            os.environ["WEBHOOK_GBRAIN_SWARM_URL"] = "https://example.invalid/swarm/mcp"
            module.GBRAIN_SWARM_URL = "https://example.invalid/swarm/mcp"
            tokenfile = Path(raw) / "gbrain.token"
            tokenfile.write_text("t\n", encoding="utf-8")
            module.GBRAIN_TOKEN_PATH = tokenfile

            fake_aiohttp = type(sys)("aiohttp_fake")
            fake_aiohttp.ClientSession = lambda: _FakeSession()
            fake_aiohttp.ClientTimeout = lambda total=None: None
            sys.modules["aiohttp"] = fake_aiohttp
            try:
                result = asyncio.run(module._fetch_pending_task("testagent"))
            finally:
                sys.modules.pop("aiohttp", None)
                os.environ.pop("WEBHOOK_GBRAIN_SWARM_URL", None)
            self.assertIsNotNone(result)
            self.assertEqual(result["task_id"], "new-10")
            self.assertEqual(result["title"], "new")


class EnrichmentWritebackTest(unittest.TestCase):
    """Codex HIGH: enriched task_id/from_agent must be written into payload
    so _build_prompt sees the real values, not 'no-id'/'unknown'."""

    def test_payload_carries_enriched_task_id_into_prompt(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            tmpdir = Path(raw)
            module = _load_listener(tmpdir)

            spawned: dict = {}

            async def _fake_fetch(agent):
                return {
                    "from_agent": "real-sender",
                    "task_id": "real-task-42",
                    "title": "Real title",
                    "body": "Real body",
                    "delivery_id": "deliv-1",
                }

            async def _fake_spawn(prompt, task_id):
                spawned["prompt"] = prompt
                spawned["task_id"] = task_id

            class _FakeRequest:
                remote = "127.0.0.1"
                headers = {"Authorization": f"Bearer {module.BEARER_TOKEN.decode()}"}

                async def read(self):
                    return b'{"task_id": "no-id", "from_agent": "unknown", "title": "degraded retry"}'

            module._fetch_pending_task = _fake_fetch
            module._spawn_claude = _fake_spawn

            async def run():
                resp = await module.handle_webhook(_FakeRequest())
                payload = json.loads(resp.body.decode("utf-8"))
                self.assertEqual(payload["status"], "accepted")
                self.assertEqual(payload["task_id"], "real-task-42")

            asyncio.run(run())
            self.assertEqual(spawned["task_id"], "real-task-42")
            # The prompt the spawned Claude sees must mention the real task_id,
            # not the original 'no-id'.
            self.assertIn("real-task-42", spawned["prompt"])
            self.assertNotIn("ack(task_id=\"no-id\")", spawned["prompt"])

    def test_empty_inbox_returns_silent_ack(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            tmpdir = Path(raw)
            module = _load_listener(tmpdir)

            async def _fake_fetch(agent):
                return None

            module._fetch_pending_task = _fake_fetch

            class _FakeRequest:
                remote = "127.0.0.1"
                headers = {"Authorization": f"Bearer {module.BEARER_TOKEN.decode()}"}

                async def read(self):
                    return b'{"task_id": "no-id", "from_agent": "unknown", "title": "degraded"}'

            async def run():
                resp = await module.handle_webhook(_FakeRequest())
                payload = json.loads(resp.body.decode("utf-8"))
                self.assertEqual(payload, {"status": "empty_inbox"})

            asyncio.run(run())


class BearerAuthTest(unittest.TestCase):
    def test_missing_bearer_returns_401(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            module = _load_listener(Path(raw))

            class _FakeRequest:
                remote = "127.0.0.1"
                headers: dict = {}

                async def read(self):
                    return b'{}'

            async def run():
                resp = await module.handle_webhook(_FakeRequest())
                self.assertEqual(resp.status, 401)

            asyncio.run(run())

    def test_wrong_bearer_returns_401(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            module = _load_listener(Path(raw))

            class _FakeRequest:
                remote = "127.0.0.1"
                headers = {"Authorization": "Bearer wrong-secret"}

                async def read(self):
                    return b'{}'

            async def run():
                resp = await module.handle_webhook(_FakeRequest())
                self.assertEqual(resp.status, 401)

            asyncio.run(run())


class HealthzMinimalTest(unittest.TestCase):
    """`/healthz` must not leak workspace path / claude binary path."""

    def test_handler_returns_only_status(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            module = _load_listener(Path(raw))

            async def run():
                resp = await module.handle_healthz(None)
                payload = json.loads(resp.body.decode("utf-8"))
                self.assertEqual(payload, {"status": "ok"})

            asyncio.run(run())


class ListenerSourceSafetyTest(unittest.TestCase):
    """Catch Orgrimmar-internal identifiers if they sneak into the listener
    or its bundled examples. Mirrors the docs-zone check in
    test_docs_public_safety.py but for the listener artifacts."""

    FORBIDDEN = (
        "164795011",
        "/home/openclaw",
        "sa-thrall",
        "100.97.43.49",
        "100.104.191.127",
        "принц",
        "warchief",
        "вождь",
        "jasonqwwen",
        "TRALL_WORKSPACE",
        # Bare org/agent identifiers. Defaults must be placeholders, not the
        # operator's concrete agent name or gbrain host.
        "orgrimmar",
        "orgrimmar.xyz",
        "thrall",
        "channel-thrall",
        "orgrimmar-silvana",
        "orgrimmar-kaelthas",
        "orgrimmar-garrosh",
        "orgrimmar-arthas",
    )

    FILES = (
        REPO_ROOT / "webhook-listener" / "listener.py",
        REPO_ROOT / "webhook-listener" / "README.md",
        REPO_ROOT / "webhook-listener" / "requirements.txt",
        REPO_ROOT / "examples" / "webhook-listener.env.example",
        REPO_ROOT / "examples" / "webhook-listener.service.example",
    )

    def test_no_internal_leaks(self) -> None:
        leaks: list[str] = []
        for path in self.FILES:
            text = path.read_text(encoding="utf-8")
            for token in self.FORBIDDEN:
                if token in text:
                    leaks.append(f"{path.name}: contains forbidden token `{token}`")
        self.assertEqual(leaks, [], "\n".join(leaks))


if __name__ == "__main__":
    unittest.main()
