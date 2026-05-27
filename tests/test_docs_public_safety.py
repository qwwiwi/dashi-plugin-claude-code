"""Docs safety tests for files that ship in the public repo.

TASK-10 (REPORT C3): plugin/docs/canary-smoke.md was originally an internal
Orgrimmar runbook that hardcoded:
  - the test bot id (8507713167)
  - the warchief's personal Telegram user id (164795011)
  - operator-specific Mac paths (~/Users/jasonqwwen/...)
  - production session names (channel-thrall, channel-silvana, etc. — kept
    in the original as `orgrimmar-silvana`, `orgrimmar-kaelthas`, ...)
  - server-specific paths (/home/openclaw, sa-thrall agent ids)
  - Tailscale IPs (100.97.43.49, 100.104.191.127)
  - Orgrimmar-internal terminology ("принц approval", "warchief", "вождь")

This test fails if any of those leak back into the public docs zone, while
keeping the file as a non-trivial public canary recipe a third-party operator
could follow (size floor enforces that sanitization did not degenerate into
deletion).

Add new forbidden tokens here when future PRs reintroduce internal context.
"""

from __future__ import annotations

import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]

CANARY_SMOKE = REPO_ROOT / "plugin" / "docs" / "canary-smoke.md"

# Tokens that must NEVER appear in any public docs file. Grouped by leak type
# so failure messages stay actionable.
FORBIDDEN_IDENTIFIERS = (
    # Bot / user ids
    "8507713167",
    "164795011",
    # Operator usernames / unix users
    "jasonqwwen",
    "openclaw",
    # Absolute server paths
    "/home/openclaw",
    # Agent identifiers
    "sa-thrall",
    # Tailscale IPs (Orgrimmar-internal network)
    "100.97.43.49",
    "100.104.191.127",
    # Internal terminology
    "principe",
    "принц",
    "warchief",
    "вождь",
    # Production session names — these are concrete prod tmux sessions
    # listed in the original "Do NOT touch" block. Public docs must
    # generalize to `channel-<your-agent>`.
    "orgrimmar-silvana",
    "orgrimmar-kaelthas",
    "orgrimmar-garrosh",
    "orgrimmar-arthas",
    "orgrimmar-claude",
    "orgrimmar-canary",
)

# Files in scope for this safety check. TASK-10 starts with canary-smoke.md;
# extend the tuple as more docs are sanitized.
#
# Note: TASK-12 removed the warchief Telegram user id (164795011) from
# docs/05-troubleshooting.md but that file still uses Orgrimmar-specific
# operator paths (`/home/openclaw`, `openclaw`, `принц`) inside concrete
# sudo / systemd examples. Adding TROUBLESHOOTING to this tuple requires
# rewriting those examples first. TASK-12 instead added a narrower
# `TroubleshootingPublicSafetyTest` in tests/test_docs_links.py that
# only enforces the user-id rule. A future TASK-N can promote the file
# here once the wider sanitization lands.
PUBLIC_DOCS = (CANARY_SMOKE,)

# Lower bound on file size. Sanitization must not collapse the runbook into
# a stub — it has value as a public smoke-test template only if it stays
# substantive.
MIN_BYTES = 500


class PublicDocsExistTest(unittest.TestCase):
    """Sanitization should not delete the file outright."""

    def test_canary_smoke_exists(self) -> None:
        self.assertTrue(
            CANARY_SMOKE.exists(),
            f"{CANARY_SMOKE} missing — sanitization should rewrite, not delete.",
        )

    def test_canary_smoke_non_trivial(self) -> None:
        size = CANARY_SMOKE.stat().st_size
        self.assertGreater(
            size,
            MIN_BYTES,
            f"{CANARY_SMOKE} is only {size} bytes; expected > {MIN_BYTES}. "
            "Sanitization should not strip the runbook down to a stub.",
        )


class PublicDocsNoInternalLeaksTest(unittest.TestCase):
    """Every public docs file must be free of Orgrimmar-internal identifiers."""

    def _scan(self, path: Path) -> list[str]:
        text = path.read_text(encoding="utf-8")
        return [token for token in FORBIDDEN_IDENTIFIERS if token in text]

    def test_canary_smoke_no_leaks(self) -> None:
        leaks = self._scan(CANARY_SMOKE)
        self.assertEqual(
            leaks,
            [],
            f"{CANARY_SMOKE} still contains internal identifiers: {leaks}. "
            "Replace each with a public placeholder (e.g. `<test-bot-id>`, "
            "`<your-telegram-user-id>`, `~/path/to/your/.claude-lab`, "
            "`channel-<your-agent>`, `operator approval`).",
        )

    def test_all_public_docs_no_leaks(self) -> None:
        """Sweep all in-scope docs in one pass so adding new files to
        ``PUBLIC_DOCS`` automatically inherits the same guard."""
        failures: list[str] = []
        for path in PUBLIC_DOCS:
            for token in self._scan(path):
                failures.append(f"{path.name}: contains forbidden token `{token}`")
        self.assertEqual(failures, [], "\n".join(failures))


class PublicDocsMacPathsGeneralizedTest(unittest.TestCase):
    """Operator-specific Mac paths must be replaced with placeholders."""

    def test_canary_smoke_no_jasonqwwen_users_path(self) -> None:
        text = CANARY_SMOKE.read_text(encoding="utf-8")
        self.assertNotIn(
            "/Users/jasonqwwen",
            text,
            "Mac path `/Users/jasonqwwen/...` must be replaced with a generic "
            "placeholder like `~/path/to/your/.claude-lab`.",
        )

    def test_canary_smoke_uses_placeholder_path(self) -> None:
        text = CANARY_SMOKE.read_text(encoding="utf-8")
        self.assertIn(
            "~/path/to/your/.claude-lab",
            text,
            "Sanitized runbook should reference the placeholder "
            "`~/path/to/your/.claude-lab` so third-party operators see how to "
            "adapt the commands.",
        )


class PublicDocsPlaceholderHintsTest(unittest.TestCase):
    """The runbook must explain its placeholders so a stranger can follow it."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.text = CANARY_SMOKE.read_text(encoding="utf-8")

    def test_test_bot_placeholder_present(self) -> None:
        self.assertIn(
            "<test-bot-id>",
            self.text,
            "Runbook should use `<test-bot-id>` placeholder where the leaked "
            "concrete id used to live.",
        )

    def test_user_id_placeholder_present(self) -> None:
        self.assertIn(
            "<your-telegram-user-id>",
            self.text,
            "Runbook should use `<your-telegram-user-id>` placeholder where "
            "the warchief's concrete id used to live.",
        )

    def test_userinfobot_hint_present(self) -> None:
        self.assertIn(
            "userinfobot",
            self.text,
            "Runbook should mention @userinfobot so operators know how to "
            "discover their numeric Telegram user id.",
        )

    def test_pre_cutover_section_marked(self) -> None:
        # Rule #5 of the sanitization spec: gateway.py references stay, but
        # must be marked as a pre-cutover migration path.
        self.assertIn(
            "Pre-cutover",
            self.text,
            "Runbook must mark Python `gateway.py` sections as `Pre-cutover` "
            "so fresh installers know to skip them.",
        )

    def test_operator_approval_wording(self) -> None:
        # "принц approval" / "warchief" was replaced with "operator approval".
        self.assertIn(
            "operator approval",
            self.text,
            "Production cutover sentence should read `operator approval` "
            "instead of the Orgrimmar-internal `принц approval` wording.",
        )


if __name__ == "__main__":
    unittest.main()
