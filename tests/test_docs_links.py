"""Docs integrity tests for top-level README.md, plugin/README.md, DEPRECATION-PATH.md.

TASK-11 owns these three files. Their content must satisfy:

  1. Every relative markdown link resolves to an existing path in the repo.
  2. The old repository name `qwwiwi-channel-telegram-Claude-code` is never
     referenced — canonical name is `dashi-plugin-claude-code`.
  3. README.md mentions the multichat enablement flag and the install-hooks
     step in the quick-start.
  4. README.md states the v2.1.80+ requirement for Claude Code (matches the
     channels-reference docs).

The test stays narrow on purpose: TASK-11 only edits the three markdown
files above. Other docs (PLAN.md, docs/dev/*) carry historical paths that
predate the rename and are out of scope here.
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]

ROOT_README = REPO_ROOT / "README.md"
PLUGIN_README = REPO_ROOT / "plugin" / "README.md"
DEPRECATION = REPO_ROOT / "DEPRECATION-PATH.md"
TROUBLESHOOTING = REPO_ROOT / "docs" / "05-troubleshooting.md"

OWNED_FILES = (ROOT_README, PLUGIN_README, DEPRECATION)

# Files that TASK-12 archived. Any non-archive link to these paths from
# tracked markdown is stale and must either be removed or redirected to
# docs/archive/.
ARCHIVED_PATHS = (
    "PLAN.md",
    "plugin/docs/PLAN-A2-A3.md",
)

# Warchief's Telegram user ID — must never leak into public-facing docs.
WARCHIEF_USER_ID = "164795011"

OLD_REPO_NAME = "qwwiwi-channel-telegram-Claude-code"

# Matches `[label](target)` markdown links. Captures the target only.
MD_LINK_RE = re.compile(r"\[[^\]]*\]\(([^)]+)\)")


def _extract_link_targets(text: str) -> list[str]:
    return MD_LINK_RE.findall(text)


def _is_external(target: str) -> bool:
    if target.startswith("http://") or target.startswith("https://"):
        return True
    if target.startswith("mailto:"):
        return True
    return False


def _strip_anchor(target: str) -> str:
    # Drop the in-file anchor (`docs/foo.md#section`) when checking existence.
    idx = target.find("#")
    if idx == -1:
        return target
    return target[:idx]


class RelativeLinksResolveTest(unittest.TestCase):
    """Every relative markdown link in owned files must point to a real file."""

    def _check_file(self, path: Path) -> None:
        text = path.read_text(encoding="utf-8")
        base_dir = path.parent
        failures: list[str] = []
        for target in _extract_link_targets(text):
            if _is_external(target):
                continue
            stripped = _strip_anchor(target).strip()
            if not stripped:
                # Pure anchor link (#section) — same-file, treat as OK.
                continue
            resolved = (base_dir / stripped).resolve()
            if not resolved.exists():
                failures.append(f"{path.name}: link `{target}` -> {resolved} (missing)")
        self.assertEqual(failures, [], "\n".join(failures))

    def test_root_readme_links_resolve(self) -> None:
        self._check_file(ROOT_README)

    def test_plugin_readme_links_resolve(self) -> None:
        self._check_file(PLUGIN_README)

    def test_deprecation_path_links_resolve(self) -> None:
        self._check_file(DEPRECATION)


class OldRepoNameAbsentTest(unittest.TestCase):
    """The legacy repo name must not appear in any owned file."""

    def test_root_readme_no_old_repo_name(self) -> None:
        self.assertNotIn(
            OLD_REPO_NAME,
            ROOT_README.read_text(encoding="utf-8"),
            f"Old repo name `{OLD_REPO_NAME}` must be removed from {ROOT_README}",
        )

    def test_plugin_readme_no_old_repo_name(self) -> None:
        self.assertNotIn(
            OLD_REPO_NAME,
            PLUGIN_README.read_text(encoding="utf-8"),
            f"Old repo name `{OLD_REPO_NAME}` must be removed from {PLUGIN_README}",
        )

    def test_deprecation_no_old_repo_name(self) -> None:
        self.assertNotIn(
            OLD_REPO_NAME,
            DEPRECATION.read_text(encoding="utf-8"),
            f"Old repo name `{OLD_REPO_NAME}` must be removed from {DEPRECATION}",
        )


class RootReadmeContentRequirementsTest(unittest.TestCase):
    """Spot-checks for key strings the warchief expects in README.md."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.text = ROOT_README.read_text(encoding="utf-8")

    def test_multichat_enabled_documented(self) -> None:
        self.assertIn(
            "multichat.enabled",
            self.text,
            "README.md must document the `multichat.enabled` config flag — "
            "multichat is the headline opt-in feature.",
        )

    def test_install_hooks_in_quick_start(self) -> None:
        self.assertIn(
            "install-hooks.sh",
            self.text,
            "Quick start must mention `install-hooks.sh` — without hooks the "
            "ProgressReporter / TaskMirror / ActivityRenderer never fire.",
        )

    def test_claude_code_version_pinned_to_2_1_80(self) -> None:
        self.assertIn(
            "v2.1.80",
            self.text,
            "Requirements must pin Claude Code to v2.1.80+ per the official "
            "channels-reference docs.",
        )

    def test_billing_mentions_plan_tiers(self) -> None:
        for marker in ("Pro", "Max 5", "Max 20"):
            self.assertIn(
                marker,
                self.text,
                f"Billing section must list the `{marker}` plan tier so users "
                "do not assume a flat $200/mo pool.",
            )


class PluginReadmeContentRequirementsTest(unittest.TestCase):
    """Spot-checks for plugin/README.md."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.text = PLUGIN_README.read_text(encoding="utf-8")

    def test_multichat_enabled_documented(self) -> None:
        # Plugin README uses the JSON-config block form (`"multichat": { "enabled": ... }`)
        # and the env-var form (`TELEGRAM_MULTICHAT_ENABLED`). Either is fine —
        # the test only fails if BOTH are absent.
        has_json_form = '"multichat"' in self.text and '"enabled"' in self.text
        has_env_form = "TELEGRAM_MULTICHAT_ENABLED" in self.text
        has_dotted_form = "multichat.enabled" in self.text
        self.assertTrue(
            has_json_form or has_env_form or has_dotted_form,
            "plugin/README.md must document the multichat enable flag in one of: "
            "JSON `\"multichat\": { \"enabled\": ... }`, env `TELEGRAM_MULTICHAT_ENABLED`, "
            "or dotted `multichat.enabled`.",
        )

    def test_mirror_oob_command_documented(self) -> None:
        # The old plugin/README claimed `/mirror on|off|status` was out of
        # scope. PR #17 shipped it — the doc must reflect that.
        self.assertIn(
            "/mirror",
            self.text,
            "plugin/README.md must mention the `/mirror` OOB command (PR #17).",
        )
        self.assertNotIn(
            "Out of scope (отдельные PR'ы):\n- `/mirror",
            self.text,
            "plugin/README.md must NOT claim `/mirror` is out of scope — it is shipped.",
        )

    def test_what_is_this_link_uses_correct_filename(self) -> None:
        # Old broken link: ../docs/01-context.md. Real file: 01-what-is-this.md.
        self.assertNotIn(
            "01-context.md",
            self.text,
            "plugin/README.md must use `01-what-is-this.md`, not the non-existent `01-context.md`.",
        )


class ArchivedDocLinksTest(unittest.TestCase):
    """TASK-12: stale plan docs are now under docs/archive/.

    Any tracked markdown that still links to the pre-archive path of
    `PLAN.md` or `plugin/docs/PLAN-A2-A3.md` must instead either
    drop the link or point to `docs/archive/...`. Otherwise readers
    follow a 404.
    """

    def _tracked_markdown_files(self) -> list[Path]:
        # Walk repo, exclude untracked dev artifacts (loop-coding-runs/),
        # node_modules, .git, virtualenvs.
        exclude_dirs = {
            ".git",
            "node_modules",
            "loop-coding-runs",
            "__pycache__",
            ".venv",
            "venv",
            "dist",
            "build",
        }
        results: list[Path] = []
        for path in REPO_ROOT.rglob("*.md"):
            if any(part in exclude_dirs for part in path.relative_to(REPO_ROOT).parts):
                continue
            results.append(path)
        return results

    def test_no_stale_links_to_archived_plans(self) -> None:
        failures: list[str] = []
        for md_file in self._tracked_markdown_files():
            text = md_file.read_text(encoding="utf-8")
            for target in _extract_link_targets(text):
                if _is_external(target):
                    continue
                stripped = _strip_anchor(target).strip().lstrip("./")
                # Permit links that already point to docs/archive/.
                if "docs/archive/" in stripped:
                    continue
                for archived in ARCHIVED_PATHS:
                    # Treat both the bare basename and the full repo-relative
                    # path as stale. Example: link `../PLAN.md` from plugin/
                    # resolves up to repo-root PLAN.md.
                    archived_basename = archived.rsplit("/", 1)[-1]
                    if stripped.endswith(archived) or stripped.endswith(archived_basename):
                        failures.append(
                            f"{md_file.relative_to(REPO_ROOT)}: link `{target}` -> "
                            f"archived path `{archived}` (move to docs/archive/...)"
                        )
                        break
        self.assertEqual(failures, [], "\n".join(failures))


class TroubleshootingPublicSafetyTest(unittest.TestCase):
    """TASK-12 + TASK-10 overlap: docs/05-troubleshooting.md is public-facing.

    The warchief's personal Telegram user ID must NEVER appear there.
    TASK-10 owns the broader public-safety doctrine; this test stays
    narrow to the one file TASK-12 directly edits, so it can land first
    without conflicting with TASK-10's coverage.
    """

    def test_no_warchief_user_id_in_troubleshooting(self) -> None:
        text = TROUBLESHOOTING.read_text(encoding="utf-8")
        self.assertNotIn(
            WARCHIEF_USER_ID,
            text,
            f"Warchief Telegram user ID `{WARCHIEF_USER_ID}` must NOT appear "
            f"in {TROUBLESHOOTING.relative_to(REPO_ROOT)}. Replace with "
            "`<your-telegram-user-id>` or generalise the example.",
        )


class DeprecationPathContentRequirementsTest(unittest.TestCase):
    """Spot-checks for DEPRECATION-PATH.md."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.text = DEPRECATION.read_text(encoding="utf-8")

    def test_billing_does_not_claim_flat_200_pool(self) -> None:
        # The original wording said "$200/мес pool" period, no plan breakdown.
        # Reality: credit depends on plan (Pro $20 / Max 5x $100 / Max 20x $200).
        self.assertIn(
            "Pro",
            self.text,
            "Deprecation billing block must mention Pro tier — credit is plan-dependent.",
        )
        self.assertIn(
            "Max 5",
            self.text,
            "Deprecation billing block must mention Max 5x tier.",
        )
        self.assertIn(
            "Max 20",
            self.text,
            "Deprecation billing block must mention Max 20x tier.",
        )

    def test_no_dated_support_chat_placeholder(self) -> None:
        # The old wording said «открывается ближе к 2026-06-01» — that date
        # is now imminent and the placeholder is stale.
        self.assertNotIn(
            "ближе к 2026-06-01",
            self.text,
            "Support-chat date placeholder must be removed; use the community-run wording instead.",
        )


if __name__ == "__main__":
    unittest.main()
