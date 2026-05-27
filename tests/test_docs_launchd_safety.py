"""Docs safety tests for macOS launchd installation instructions.

Guards against regressions of the bug where:
  exec tmux new-session -d ...; sleep 6; send-keys ...
was published as install copy-paste. `exec` replaces the shell, so the
follow-up `sleep` and `send-keys` never run. launchd also could not reliably
track a detached tmux process.

Tests in this module fail if the anti-pattern reappears in:
  - docs/03-installation-macos.md
  - docs/02-where-to-place-plugin.md
  - examples/launchd-plist.example.plist

They also verify that the plist example is well-formed XML and references the
wrapper script approach.
"""

from __future__ import annotations

import plistlib
import re
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]

MACOS_DOC = REPO_ROOT / "docs" / "03-installation-macos.md"
PLACE_DOC = REPO_ROOT / "docs" / "02-where-to-place-plugin.md"
PLIST_EXAMPLE = REPO_ROOT / "examples" / "launchd-plist.example.plist"
WRAPPER_EXAMPLE = REPO_ROOT / "examples" / "launchd-wrapper.sh.example"


# Pattern: `exec` (some chars) `tmux` (some chars) `;` (some chars) (`sleep` or `send-keys`)
# This catches the broken antipattern even across whitespace variations.
EXEC_BEFORE_SLEEP_RE = re.compile(
    r"exec\s+[^\n;]*tmux[^\n;]*;\s*[^\n;]*(?:sleep|send-keys)",
    re.IGNORECASE,
)


def _strip_explanatory_text(raw: str) -> str:
    """Remove HTML/shell comments and lines that obviously describe the antipattern
    rather than execute it. Heuristics:
      - Drop HTML comment blocks (<!-- ... -->)
      - Drop lines containing `...` ellipsis placeholder (used in prose to point
        at the broken pattern without printing a runnable command)
      - Drop lines starting with shell comment `#` (wrapper script comments)
    What remains should be runnable/copy-pasteable code only.
    """
    # Strip HTML comments
    raw = re.sub(r"<!--.*?-->", "", raw, flags=re.DOTALL)
    kept: list[str] = []
    for line in raw.splitlines():
        stripped = line.strip()
        if "..." in line:
            continue
        if stripped.startswith("#"):
            continue
        kept.append(line)
    return "\n".join(kept)


class LaunchdAntipatternTest(unittest.TestCase):
    """Fail if `exec ... tmux ... ; sleep|send-keys` pattern is reintroduced."""

    def _scan(self, path: Path) -> list[str]:
        text = _strip_explanatory_text(path.read_text(encoding="utf-8"))
        return EXEC_BEFORE_SLEEP_RE.findall(text)

    def test_macos_install_doc_no_exec_before_sleep(self) -> None:
        matches = self._scan(MACOS_DOC)
        self.assertEqual(
            matches,
            [],
            f"Broken `exec tmux ...; sleep/send-keys` pattern found in {MACOS_DOC}:\n"
            + "\n".join(matches),
        )

    def test_where_to_place_doc_no_exec_before_sleep(self) -> None:
        matches = self._scan(PLACE_DOC)
        self.assertEqual(
            matches,
            [],
            f"Broken `exec tmux ...; sleep/send-keys` pattern found in {PLACE_DOC}:\n"
            + "\n".join(matches),
        )

    def test_plist_example_no_exec_before_sleep(self) -> None:
        matches = self._scan(PLIST_EXAMPLE)
        self.assertEqual(
            matches,
            [],
            f"Broken `exec tmux ...; sleep/send-keys` pattern found in {PLIST_EXAMPLE}:\n"
            + "\n".join(matches),
        )


class LaunchdPlistStructureTest(unittest.TestCase):
    """Verify launchd plist example is valid and uses the wrapper approach."""

    def test_plist_example_is_valid_xml(self) -> None:
        with PLIST_EXAMPLE.open("rb") as fh:
            data = plistlib.load(fh)
        self.assertIsInstance(data, dict)
        self.assertIn("Label", data)
        self.assertIn("ProgramArguments", data)
        self.assertIn("WorkingDirectory", data)

    def test_plist_program_arguments_invokes_wrapper(self) -> None:
        with PLIST_EXAMPLE.open("rb") as fh:
            data = plistlib.load(fh)
        args = data.get("ProgramArguments")
        self.assertIsInstance(args, list)
        self.assertGreater(len(args), 0)
        # Must NOT be a `sh -c` one-liner shoving everything inline.
        first = args[0]
        self.assertNotIn(
            "/bin/sh",
            first,
            "ProgramArguments[0] should be the wrapper script path, not /bin/sh",
        )
        self.assertNotIn(
            "/bin/bash",
            first,
            "ProgramArguments[0] should be the wrapper script path, not /bin/bash",
        )
        # Wrapper path should reference launchd-wrapper.sh (allowing any prefix)
        self.assertIn(
            "launchd-wrapper.sh",
            first,
            f"ProgramArguments[0] should invoke launchd-wrapper.sh, got: {first}",
        )

    def test_plist_keep_alive_is_conditional(self) -> None:
        """KeepAlive must be a dict with SuccessfulExit=false, not bare <true/>.

        Bare <true/> respawns on graceful exit too, causing infinite loops when
        welcome-prompts have not been bypassed.

        SuccessfulExit=false (NOT Crashed=true) is required so that wrapper's
        own non-zero exit on unexpected tmux death also triggers respawn.
        Crashed=true only fires for signal-deaths (SIGSEGV/SIGABRT), missing
        the case where the wrapper itself detects a dead tmux and exits 1.
        """
        with PLIST_EXAMPLE.open("rb") as fh:
            data = plistlib.load(fh)
        keep_alive = data.get("KeepAlive")
        self.assertIsInstance(
            keep_alive,
            dict,
            "KeepAlive must be a dict with conditional keys "
            "(SuccessfulExit=false), not a bare boolean.",
        )
        self.assertIn(
            "SuccessfulExit",
            keep_alive,
            "KeepAlive must use SuccessfulExit=false so launchd respawns on "
            "ANY non-zero exit (wrapper's exit 1 on unexpected tmux death AND "
            "signal-deaths). Crashed=true only handles signals, missing the "
            "wrapper-detected-dead-tmux case.",
        )
        self.assertFalse(
            keep_alive.get("SuccessfulExit", True),
            "KeepAlive.SuccessfulExit must be False — respawn unless prior "
            "exit code was 0 (operator-initiated stop via launchctl kill).",
        )
        self.assertNotIn(
            "Crashed",
            keep_alive,
            "KeepAlive.Crashed=true is superseded by SuccessfulExit=false. "
            "Having both is redundant and confusing — remove Crashed.",
        )

    def test_plist_xml_does_not_contain_crashed_true(self) -> None:
        """Raw XML check: <key>Crashed</key><true/> must not appear.

        Parser-level check above catches it in the KeepAlive dict, but operators
        sometimes copy stale snippets. Belt-and-suspenders.
        """
        raw = PLIST_EXAMPLE.read_text(encoding="utf-8")
        # Tolerate whitespace/newlines between the key and value tags.
        crashed_pattern = re.compile(
            r"<key>\s*Crashed\s*</key>\s*<true\s*/>",
            re.IGNORECASE,
        )
        self.assertIsNone(
            crashed_pattern.search(raw),
            "plist still contains <key>Crashed</key><true/> — replace with "
            "<key>SuccessfulExit</key><false/> per FIX-I migration.",
        )


class LaunchdWrapperExampleTest(unittest.TestCase):
    """Verify wrapper example exists and avoids the antipattern itself."""

    def test_wrapper_example_exists(self) -> None:
        self.assertTrue(
            WRAPPER_EXAMPLE.exists(),
            f"Wrapper example missing: {WRAPPER_EXAMPLE}. "
            "The launchd plist references this script.",
        )

    def test_wrapper_example_no_exec_before_sleep(self) -> None:
        text = _strip_explanatory_text(WRAPPER_EXAMPLE.read_text(encoding="utf-8"))
        matches = EXEC_BEFORE_SLEEP_RE.findall(text)
        self.assertEqual(
            matches,
            [],
            f"Wrapper itself contains the broken pattern:\n" + "\n".join(matches),
        )

    def test_wrapper_starts_with_shebang(self) -> None:
        first_line = WRAPPER_EXAMPLE.read_text(encoding="utf-8").splitlines()[0]
        self.assertTrue(
            first_line.startswith("#!"),
            f"Wrapper must start with shebang, got: {first_line!r}",
        )

    def test_wrapper_has_trap_cleanup(self) -> None:
        text = WRAPPER_EXAMPLE.read_text(encoding="utf-8")
        self.assertIn(
            "trap",
            text,
            "Wrapper should install a trap for SIGTERM cleanup so launchctl "
            "kill can shut down tmux gracefully.",
        )

    def test_wrapper_blocks_on_session_alive(self) -> None:
        """Wrapper must stay in foreground while tmux session exists.

        Otherwise launchd loses the supervised PID immediately after detach.
        """
        text = WRAPPER_EXAMPLE.read_text(encoding="utf-8")
        self.assertIn(
            "has-session",
            text,
            "Wrapper should poll `tmux has-session` to stay supervised by launchd.",
        )

    def test_wrapper_has_expected_shutdown_flag(self) -> None:
        """Wrapper must distinguish operator-stop from unexpected tmux death.

        Without an EXPECTED_SHUTDOWN flag, every exit path returns 0 and
        launchd's SuccessfulExit=false KeepAlive treats unexpected tmux death
        as a graceful exit — the agent silently stays dead after a claude
        crash, defeating the supervision setup.
        """
        text = WRAPPER_EXAMPLE.read_text(encoding="utf-8")
        self.assertIn(
            "EXPECTED_SHUTDOWN",
            text,
            "Wrapper must define EXPECTED_SHUTDOWN flag set by trap cleanup, "
            "so unexpected tmux death can be distinguished from operator stop.",
        )

    def test_wrapper_exits_nonzero_on_unexpected_death(self) -> None:
        """Wrapper must `exit 1` (not `exit 0`) on unexpected tmux session death.

        Strips trap-cleanup code (where exit 0 is legitimate for operator
        stop) and asserts the remaining "session died" branch uses exit 1.
        """
        text = WRAPPER_EXAMPLE.read_text(encoding="utf-8")
        # Sanity: exit 1 branch must exist for the unexpected-death path.
        self.assertIn(
            "exit 1",
            text,
            "Wrapper must `exit 1` on unexpected tmux death so launchd "
            "(KeepAlive.SuccessfulExit=false) respawns the agent.",
        )
        # Strip cleanup() block — exit 0 inside trap is intentional and correct.
        cleanup_re = re.compile(r"cleanup\s*\(\s*\)\s*\{.*?\}", re.DOTALL)
        without_cleanup = cleanup_re.sub("", text)
        # In the remaining body, there must be at least one `exit 1` after the
        # has-session polling loop. We assert by checking that after the loop
        # there exists an `exit 1` before EOF.
        has_session_idx = without_cleanup.rfind("has-session")
        self.assertGreaterEqual(
            has_session_idx,
            0,
            "Wrapper missing has-session polling loop outside cleanup().",
        )
        tail = without_cleanup[has_session_idx:]
        self.assertIn(
            "exit 1",
            tail,
            "After the has-session polling loop, wrapper must `exit 1` on "
            "unexpected death (only inside trap cleanup is `exit 0` allowed).",
        )


if __name__ == "__main__":
    unittest.main()
