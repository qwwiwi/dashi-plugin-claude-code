"""Behaviour tests for scripts/confirm-startup-screen.sh and
scripts/check-startup-screen.sh.

Both scripts talk to tmux only through the `tmux` executable, so the tests put
a fake `tmux` on PATH. The fake prints a canned pane (chosen by how many keys
were sent so far) and records every `send-keys` call. No real tmux server is
ever contacted.

The dev-channels, trust-folder, ready and logged-out panes are REAL captures
(`tmux capture-pane -p`, Claude Code 2.1.323, macOS, bash 3.2) kept under
tests/fixtures/startup-screen/. The remaining dialogs (external imports, login
method, bypass, generic) are still reconstructed from documentation. When a new
real capture is available, add it there and adjust the pattern list at the top
of scripts/confirm-startup-screen.sh together with these tests.
"""

from __future__ import annotations

import os
import plistlib
import signal
import stat
import subprocess
import tempfile
import time
import unittest
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
CONFIRM = REPO_ROOT / "scripts" / "confirm-startup-screen.sh"
CHECK = REPO_ROOT / "scripts" / "check-startup-screen.sh"
FIXTURES = REPO_ROOT / "tests" / "fixtures" / "startup-screen"
PANE_ID = "%7"

FAKE_TMUX = r"""#!/bin/bash
# Fake tmux: canned panes, recorded keys. State lives in $FAKE_TMUX_DIR.
set -u
d="$FAKE_TMUX_DIR"
printf '%s\n' "$*" >> "$d/calls.log"
while [ $# -gt 0 ]; do
  case "$1" in
    -L|-S) shift 2 ;;
    *) break ;;
  esac
done
cmd="${1:-}"
[ $# -gt 0 ] && shift
case "$cmd" in
  display-message)
    # Only the pane id is ever asked for.
    [ -e "$d/gone" ] && exit 1
    if [ -f "$d/pane_id" ]; then cat "$d/pane_id"; else echo '%7'; fi
    ;;
  capture-pane)
    [ -e "$d/gone" ] && exit 1
    # hang: this call never answers (a stuck tmux server).
    [ -e "$d/hang" ] && exec sleep 60
    # delay.<k>: capture number k (from 0) answers that many seconds late.
    k=0
    [ -f "$d/captures.all" ] && k=$(wc -l < "$d/captures.all" | tr -d ' ')
    echo x >> "$d/captures.all"
    [ -f "$d/delay.$k" ] && sleep "$(cat "$d/delay.$k")"
    if [ -d "$d/cycle" ]; then
      # Alternating panes: capture number c shows cycle/<c mod count>.txt.
      c=0
      [ -f "$d/captures.count" ] && c=$(wc -l < "$d/captures.count" | tr -d ' ')
      echo x >> "$d/captures.count"
      count=$(ls "$d/cycle" | wc -l | tr -d ' ')
      cat "$d/cycle/$((c % count)).txt"
      exit 0
    fi
    n=0
    [ -f "$d/keys.log" ] && n=$(wc -l < "$d/keys.log" | tr -d ' ')
    while [ "$n" -gt 0 ] && [ ! -f "$d/screens/$n.txt" ]; do n=$((n - 1)); done
    cat "$d/screens/$n.txt"
    ;;
  send-keys)
    keys=""
    while [ $# -gt 0 ]; do
      case "$1" in
        -t) shift 2 ;;
        *) keys="$keys$1 "; shift ;;
      esac
    done
    printf '%s\n' "${keys% }" >> "$d/keys.log"
    ;;
  *) exit 0 ;;
esac
"""

SECRET = "PRIVATE-CONVERSATION-MARKER-7731"



def fixture(name: str) -> str:
    """Text of one real capture from tests/fixtures/startup-screen/."""
    return (FIXTURES / name).read_text(encoding="utf-8")


def changed(text: str, old: str, new: str) -> str:
    """str.replace that fails loudly when the fixture no longer holds `old`."""
    if old not in text:
        raise AssertionError(f"fixture no longer contains {old!r}")
    return text.replace(old, new)


# Real capture: shell command line and the macOS zsh notice sit above the dialog.
DEV_CHANNELS = fixture("02-dev-channels.txt")
# Same screen captured with `capture-pane -e` (ANSI colour escapes kept).
DEV_CHANNELS_ESCAPES = fixture("02-dev-channels.esc.txt")

DEV_CHANNELS_CURSOR_ON_2 = changed(
    changed(DEV_CHANNELS, "  ❯ 1. I am using", "    1. I am using"), "    2. Exit", "  ❯ 2. Exit"
)

DEV_CHANNELS_EXTRA_OPTION = changed(DEV_CHANNELS, "    2. Exit", "    2. Exit\n    3. Always allow these channels")

DEV_CHANNELS_OTHER_OPTION_1 = changed(
    DEV_CHANNELS, "1. I am using this for local development", "1. Yes, load everything"
)

DEV_CHANNELS_TEXT_BELOW = DEV_CHANNELS.rstrip("\n") + "\n\n Type your answer and press Enter\n"

DEV_CHANNELS_TWO_CURSORS = changed(DEV_CHANNELS, "    2. Exit", "  ❯ 2. Exit")

ESC = "\x1b"
DEV_CHANNELS_WRAPPED_ANSI = (
    f"{ESC}[1m╭──────────────────────────────────────╮{ESC}[0m\n"
    f"│ {ESC}[33mWARNING: Loading development{ESC}[0m         │\n"
    f"│ {ESC}[33mchannels{ESC}[0m                             │\n"
    "│                                      │\n"
    "│ --dangerously-load-development-      │\n"
    "│ channels is for local channel        │\n"
    "│ development only.                    │\n"
    "│                                      │\n"
    f"│ {ESC}[36m❯{ESC}[0m 1. I am using this for local      │\n"
    "│      development                     │\n"
    "│   2. Exit                            │\n"
    "│                                      │\n"
    f"│ {ESC}[2mEnter to confirm · Esc to{ESC}[0m            │\n"
    f"│ {ESC}[2mcancel{ESC}[0m                               │\n"
    "╰──────────────────────────────────────╯\n"
)

# Real capture of a working session: channel banner, input box, mode footer.
READY = fixture("03-ready.txt")

# A live session whose conversation quotes the whole dialog.
READY_QUOTING_DIALOG = DEV_CHANNELS + "\n" + READY

# Real captures: the cursor starts on "No, exit"; the first one has the shell
# command line (with the dev-channels flag name) above the dialog.
TRUST_FOLDER = fixture("01-trust-folder.txt")
TRUST_FOLDER_BARE = fixture("04-trust-folder-work2.txt")
TRUST_FOLDER_WITH_SECRET = changed(TRUST_FOLDER_BARE, "/private/tmp/startup-853-test/work2", f"/srv/agents/{SECRET}")

# Real capture: ready markers on screen, but the session is logged out.
LOGGED_OUT = fixture("04a-notloggedin-after-stray-input.txt")

EXTERNAL_IMPORTS = """\
 Allow external CLAUDE.md file imports?

 ❯ 1. Yes
   2. No

 Enter to confirm · Esc to cancel
"""

LOGIN = """\
 Select login method:

 ❯ 1. Claude account with subscription
   2. Anthropic Console account
"""

BYPASS = """\
 WARNING: Claude Code running in Bypass Permissions mode

 ❯ 1. No, exit
   2. Yes, I accept

 Enter to confirm · Esc to cancel
"""

OTHER_DIALOG = """\
 Pick a colour for the thing

 ❯ 1. Red
   2. Blue

 Enter to select · ↑/↓ to navigate · Esc to cancel
"""

SHELL_ONLY = "bash-3.2$ \n"

LOCK_BLOCK_START = "# >>> lock functions"
LOCK_BLOCK_END = "# <<< lock functions"


def lock_block(script: Path) -> str:
    """The lock functions of one script: the text between the two marker lines."""
    text = script.read_text(encoding="utf-8")
    if LOCK_BLOCK_START not in text or LOCK_BLOCK_END not in text:
        raise AssertionError(f"{script.name} has no marked lock block")
    return text[text.index(LOCK_BLOCK_START) : text.index(LOCK_BLOCK_END)]


def age_tree(path: Path, seconds: int) -> None:
    """Make a lock directory and everything in it look `seconds` old."""
    stamp = time.time() - seconds
    for entry in [*path.rglob("*"), path]:
        os.utime(entry, (stamp, stamp))


def dead_pid() -> int:
    """Pid of a process that has already ended and was reaped."""
    proc = subprocess.Popen(["/bin/sh", "-c", "exit 0"])
    proc.wait()
    return proc.pid


@dataclass
class Result:
    """Outcome of one script run against the fake tmux."""

    code: int
    stdout: str
    stderr: str
    keys: list[str]
    calls: list[str]


class FakeTmuxCase(unittest.TestCase):
    """Base: a temp dir with a fake tmux first on PATH."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)
        self.fake = self.root / "fake"
        (self.fake / "screens").mkdir(parents=True)
        bindir = self.root / "bin"
        bindir.mkdir()
        tmux = bindir / "tmux"
        tmux.write_text(FAKE_TMUX, encoding="utf-8")
        tmux.chmod(tmux.stat().st_mode | stat.S_IXUSR)
        self.env = {
            "PATH": f"{bindir}:/usr/bin:/bin",
            "HOME": str(self.root),
            "FAKE_TMUX_DIR": str(self.fake),
            "STARTUP_CONFIRM_LOCK_DIR": str(self.root / "locks"),
            "LANG": "C",
        }

    def screens(self, *texts: str) -> None:
        """Pane text shown after 0, 1, 2... key presses (last one repeats)."""
        for old in (self.fake / "screens").glob("*.txt"):
            old.unlink()
        for index, text in enumerate(texts):
            (self.fake / "screens" / f"{index}.txt").write_text(text, encoding="utf-8")

    def _lines(self, name: str) -> list[str]:
        path = self.fake / name
        return path.read_text(encoding="utf-8").splitlines() if path.exists() else []

    def cycle(self, *texts: str) -> None:
        """Pane text alternates per capture: capture c shows texts[c mod len]."""
        (self.fake / "cycle").mkdir()
        for index, text in enumerate(texts):
            (self.fake / "cycle" / f"{index}.txt").write_text(text, encoding="utf-8")

    def run_script(
        self, script: Path, *args: str, env: dict[str, str] | None = None, timeout: float = 60
    ) -> Result:
        merged = dict(self.env)
        merged.update(env or {})
        try:
            proc = subprocess.run(
                ["/bin/bash", str(script), *args],
                env=merged,
                capture_output=True,
                text=True,
                timeout=timeout,
                check=False,
            )
        except subprocess.TimeoutExpired:
            self.fail(f"{script.name} {' '.join(args)} did not end within {timeout}s")
        return Result(proc.returncode, proc.stdout, proc.stderr, self._lines("keys.log"), self._lines("calls.log"))

    def spawn(self, script: Path, *args: str, env: dict[str, str] | None = None) -> subprocess.Popen[str]:
        """Start a script in the background; the caller waits for it or kills it."""
        merged = dict(self.env)
        merged.update(env or {})
        proc = subprocess.Popen(
            ["/bin/bash", str(script), *args],
            env=merged,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        self.addCleanup(self._reap, proc)
        return proc

    @staticmethod
    def _reap(proc: subprocess.Popen[str]) -> None:
        if proc.poll() is None:
            proc.kill()
        proc.communicate()

    # ── Lock records ─────────────────────────────────────────────────────────

    def lock_lib(self) -> Path:
        """The lock functions of confirm-startup-screen.sh as a file a shell can source."""
        lib = self.root / "lock-lib.sh"
        if not lib.exists():
            lib.write_text(lock_block(CONFIRM), encoding="utf-8")
        return lib

    def process_identity(self, pid: int) -> str:
        """Identity of a running process, exactly as the scripts record it."""
        proc = subprocess.run(
            ["/bin/bash", "-c", '. "$1"; lock_proc_id "$2"', "identity", str(self.lock_lib()), str(pid)],
            capture_output=True, text=True, check=True, timeout=30,
        )
        self.assertTrue(proc.stdout, "no identity for a running process")
        return proc.stdout

    def write_lock(self, lock: Path, pid: int, identity: str, *, legacy_pid: bool = False) -> None:
        """Put an owner record into a lock directory, as if process `pid` held the lock.

        legacy_pid also writes the `pid` file the previous lock format used, so the
        same test shows what the old age rule did.
        """
        lock.mkdir(parents=True, exist_ok=True)
        (lock / "held").write_text(f"{pid} {pid}-1-test {identity}\n", encoding="utf-8")
        if legacy_pid:
            (lock / "pid").write_text(f"{pid}\n", encoding="utf-8")

    def pane_lock(self) -> Path:
        """Lock directory of the pane the fake tmux reports for `-L channel-test`."""
        return self.root / "locks" / "-Lchannel-test__7.lock"


class ConfirmStartupScreenTest(FakeTmuxCase):
    FAST = ("--timeout", "1", "--interval", "0.05", "--press-pause", "0.05")

    def confirm(self, *args: str, env: dict[str, str] | None = None) -> Result:
        return self.run_script(CONFIRM, *self.FAST, *args, "-L", "channel-test", "channel-test", env=env)

    def test_dev_channels_screen_gets_exactly_one_enter(self) -> None:
        self.screens(DEV_CHANNELS, READY)
        result = self.confirm()
        self.assertEqual(result.code, 0, result.stderr)
        self.assertEqual(result.keys, ["Enter"])
        # B2: the target is resolved to a pane id once; every capture and the key use that id.
        self.assertEqual(result.calls[0], "-L channel-test display-message -p -t channel-test #{pane_id}")
        sends = [call for call in result.calls if "send-keys" in call]
        self.assertEqual(sends, [f"-L channel-test send-keys -t {PANE_ID} Enter"])
        captures = [call for call in result.calls if "capture-pane" in call]
        self.assertTrue(captures)
        self.assertEqual(set(captures), {f"-L channel-test capture-pane -p -t {PANE_ID}"})

    def test_socket_path_flag_is_passed_through(self) -> None:
        self.screens(DEV_CHANNELS, READY)
        result = self.run_script(CONFIRM, *self.FAST, "-S", "/tmp/some.sock", "sess:0.0")
        self.assertEqual(result.code, 0, result.stderr)
        self.assertIn("-S /tmp/some.sock display-message -p -t sess:0.0 #{pane_id}", result.calls)
        self.assertIn(f"-S /tmp/some.sock send-keys -t {PANE_ID} Enter", result.calls)

    def test_screen_gone_to_unclassified_ui_after_press_is_success(self) -> None:
        self.screens(DEV_CHANNELS, " loading something not in any pattern list\n")
        result = self.confirm()
        self.assertEqual(result.code, 0, result.stderr)
        self.assertEqual(result.keys, ["Enter"])

    def test_persisting_screen_gets_second_press_then_stops(self) -> None:
        self.screens(DEV_CHANNELS)
        result = self.confirm()
        self.assertEqual(result.code, 3, result.stderr)
        self.assertEqual(result.keys, ["Enter", "Enter"])

    def test_max_presses_is_configurable(self) -> None:
        self.screens(DEV_CHANNELS)
        result = self.confirm("--max-presses", "1")
        self.assertEqual(result.code, 3, result.stderr)
        self.assertEqual(result.keys, ["Enter"])

    def test_unrecognised_warning_variants_get_no_keys(self) -> None:
        variants = {
            "cursor on option 2": DEV_CHANNELS_CURSOR_ON_2,
            "extra option": DEV_CHANNELS_EXTRA_OPTION,
            "different option 1": DEV_CHANNELS_OTHER_OPTION_1,
            "text below the hint": DEV_CHANNELS_TEXT_BELOW,
            "cursor on both options": DEV_CHANNELS_TWO_CURSORS,
        }
        for name, text in variants.items():
            with self.subTest(name):
                self.screens(text)
                keys_log = self.fake / "keys.log"
                if keys_log.exists():
                    keys_log.unlink()
                result = self.confirm()
                self.assertEqual(result.keys, [])
                self.assertEqual(result.code, 4, result.stderr)

    def test_other_dialogs_get_no_keys(self) -> None:
        dialogs = {
            "trust-folder": TRUST_FOLDER,
            "external-imports": EXTERNAL_IMPORTS,
            "login": LOGIN,
            "login (logged-out session)": LOGGED_OUT,
            "bypass-permissions": BYPASS,
            "other-dialog": OTHER_DIALOG,
        }
        for kind, text in dialogs.items():
            with self.subTest(kind):
                self.screens(text)
                result = self.confirm()
                self.assertEqual(result.keys, [])
                self.assertEqual(result.code, 5, result.stderr)
                self.assertIn(f"kind={kind.split(' ')[0]} ", result.stderr)

    def test_normal_prompt_is_idempotent_success_without_keys(self) -> None:
        for name, text in {"ready": READY, "ready quoting the dialog": READY_QUOTING_DIALOG}.items():
            with self.subTest(name):
                self.screens(text)
                result = self.confirm()
                self.assertEqual(result.code, 0, result.stderr)
                self.assertEqual(result.keys, [])

    def test_unknown_screen_times_out_without_keys(self) -> None:
        self.screens(SHELL_ONLY)
        result = self.confirm()
        self.assertEqual(result.code, 6, result.stderr)
        self.assertEqual(result.keys, [])

    def test_missing_session_is_reported_without_keys(self) -> None:
        self.screens(DEV_CHANNELS)
        (self.fake / "gone").touch()
        result = self.confirm()
        self.assertEqual(result.code, 7, result.stderr)
        self.assertEqual(result.keys, [])

    def test_wrapped_lines_and_ansi_still_match(self) -> None:
        self.screens(DEV_CHANNELS_WRAPPED_ANSI, READY)
        result = self.confirm()
        self.assertEqual(result.code, 0, result.stderr)
        self.assertEqual(result.keys, ["Enter"])

    def test_dialog_that_appears_late_is_confirmed(self) -> None:
        # Screen 0 is a bare shell; the dialog shows up only on a later poll.
        self.screens(SHELL_ONLY)
        swap = self.root / "swap.sh"
        swap.write_text(
            f"sleep 0.4; cat > '{self.fake}/screens/0.txt' <<'EOF'\n{DEV_CHANNELS}EOF\n"
            f"cat > '{self.fake}/screens/1.txt' <<'EOF'\n{READY}EOF\n",
            encoding="utf-8",
        )
        bg = subprocess.Popen(["/bin/bash", str(swap)])
        try:
            result = self.run_script(
                CONFIRM, "--timeout", "5", "--interval", "0.05", "--press-pause", "0.05", "channel-test"
            )
        finally:
            bg.wait(timeout=10)
        self.assertEqual(result.code, 0, result.stderr)
        self.assertEqual(result.keys, ["Enter"])

    def test_classify_mode_prints_kind_and_never_presses(self) -> None:
        expected = {
            "dev-channels": (DEV_CHANNELS, 10),
            "dev-channels-unrecognized": (DEV_CHANNELS_CURSOR_ON_2, 4),
            "trust-folder": (TRUST_FOLDER, 5),
            "ready": (READY, 0),
            "unknown": (SHELL_ONLY, 6),
        }
        for flag in ("--classify", "--dry-run"):
            for kind, (text, code) in expected.items():
                with self.subTest(flag=flag, kind=kind):
                    self.screens(text)
                    result = self.run_script(CONFIRM, flag, "-L", "channel-test", "channel-test")
                    self.assertEqual(result.stdout.strip(), kind)
                    self.assertEqual(result.code, code, result.stderr)
                    self.assertEqual(result.keys, [])

    def test_logs_one_line_per_action_and_no_pane_content(self) -> None:
        log = self.root / "confirm.log"
        self.screens(changed(DEV_CHANNELS, "Channels: server:dummy", SECRET), READY)
        result = self.confirm("--log", str(log))
        self.assertEqual(result.code, 0, result.stderr)
        logged = log.read_text(encoding="utf-8")
        self.assertEqual(logged.count("action=press"), 1)
        self.assertIn("kind=dev-channels", logged)
        for text in (logged, result.stderr, result.stdout):
            self.assertNotIn(SECRET, text)
            self.assertNotIn("Exit", text)

    def test_patterns_are_overridable_by_env(self) -> None:
        text = changed(DEV_CHANNELS, "I am using this for local development", "Yes, this is my own channel")
        self.screens(text, READY)
        self.assertEqual(self.confirm().code, 4)
        (self.fake / "keys.log").unlink(missing_ok=True)
        result = self.confirm(env={"STARTUP_PAT_DEVCH_OPTION": "Yes, this is my own channel"})
        self.assertEqual(result.code, 0, result.stderr)
        self.assertEqual(result.keys, ["Enter"])

    def test_disable_switch_exits_without_touching_tmux(self) -> None:
        self.screens(DEV_CHANNELS)
        result = self.confirm(env={"STARTUP_CONFIRM_DISABLE": "1"})
        self.assertEqual(result.code, 0, result.stderr)
        self.assertEqual(result.calls, [])

    # ── Real captures ────────────────────────────────────────────────────────

    def test_real_captures_classify(self) -> None:
        expected = {
            "02-dev-channels.txt": ("dev-channels", 10),
            "02-dev-channels.esc.txt": ("dev-channels", 10),
            "01-trust-folder.txt": ("trust-folder", 5),
            "04-trust-folder-work2.txt": ("trust-folder", 5),
            "03-ready.txt": ("ready", 0),
            "04a-notloggedin-after-stray-input.txt": ("login", 5),
        }
        for name, (kind, code) in expected.items():
            with self.subTest(name):
                self.screens(fixture(name))
                result = self.run_script(CONFIRM, "--classify", "-L", "channel-test", "channel-test")
                self.assertEqual(result.stdout.strip(), kind, result.stderr)
                self.assertEqual(result.code, code, result.stderr)
                self.assertEqual(result.keys, [])

    def test_capture_with_ansi_escapes_is_flattened_and_confirmed(self) -> None:
        self.assertIn(ESC, DEV_CHANNELS_ESCAPES)
        self.screens(DEV_CHANNELS_ESCAPES, READY)
        result = self.confirm()
        self.assertEqual(result.code, 0, result.stderr)
        self.assertEqual(result.keys, ["Enter"])

    def test_logged_out_session_is_login_not_ready_and_gets_no_keys(self) -> None:
        self.screens(LOGGED_OUT)
        result = self.confirm()
        self.assertEqual(result.code, 5, result.stderr)
        self.assertEqual(result.keys, [])
        self.assertIn("kind=login", result.stderr)
        self.assertNotIn("kind=ready", result.stderr)

    # ── B1: exactly one dialog in the pane ───────────────────────────────────

    def test_stacked_dialogs_get_no_keys(self) -> None:
        stacks = {
            "dev-channels then trust-folder": DEV_CHANNELS + TRUST_FOLDER_BARE,
            "trust-folder then dev-channels": TRUST_FOLDER_BARE + DEV_CHANNELS,
            "dev-channels then external imports": DEV_CHANNELS + EXTERNAL_IMPORTS,
            "dev-channels then bypass": DEV_CHANNELS + BYPASS,
            "dev-channels then login": DEV_CHANNELS + LOGIN,
            "dev-channels then update notice": DEV_CHANNELS + "\n Update available! Run: brew upgrade claude-code\n",
            "dev-channels then unknown dialog": DEV_CHANNELS + OTHER_DIALOG,
            "unknown dialog then dev-channels": OTHER_DIALOG + DEV_CHANNELS,
            "dev-channels twice": DEV_CHANNELS + DEV_CHANNELS,
        }
        for name, text in stacks.items():
            with self.subTest(name):
                self.screens(text)
                keys_log = self.fake / "keys.log"
                if keys_log.exists():
                    keys_log.unlink()
                result = self.confirm()
                self.assertEqual(result.keys, [])
                self.assertEqual(result.code, 4, result.stderr)
                self.assertIn("kind=dev-channels-unrecognized", result.stderr)

    def test_text_above_the_warning_is_allowed(self) -> None:
        # A shell prompt, a redirect and the flag name itself above the dialog.
        above = "bash-3.2$ echo start > /tmp/log\n$ claude --dangerously-load-development-channels server:x\n"
        self.screens(above + DEV_CHANNELS, READY)
        result = self.confirm()
        self.assertEqual(result.code, 0, result.stderr)
        self.assertEqual(result.keys, ["Enter"])

    # ── N1: above the warning only non-dialog text ───────────────────────────

    def test_shell_text_above_the_warning_keeps_the_dialog_pressable(self) -> None:
        # Prompts ending in $ % #, and `>` inside a shell line, are not a selection cursor.
        allowed = {
            "bash prompt with redirect": "bash-3.2$ echo start > /tmp/log\n",
            "zsh prompt": "host% ls -la >> out.txt 2>&1\n",
            "root prompt": "root@box:/srv# cat a > b\n",
            "arrow inside a line": "$ echo 'a -> b' | grep '>'\n",
            "glyph inside a line": "note: press ❯ to move, see docs › page 2\n",
            "plain notice": "The default interactive shell is now zsh.\n",
        }
        for name, above in allowed.items():
            with self.subTest(name):
                self.screens(above + DEV_CHANNELS)
                result = self.run_script(CONFIRM, "--classify", "-L", "channel-test", "channel-test")
                self.assertEqual(result.stdout.strip(), "dev-channels", result.stderr)
                self.assertEqual(result.code, 10, result.stderr)

    def test_selection_dialog_above_the_warning_gets_no_keys(self) -> None:
        refused = {
            "unnumbered dialog (review N1)": "Choose access:\n❯ Allow all actions\n  Deny\nEsc to cancel\n",
            "cursor line only": "Choose access:\n  ❯ Allow all actions\n    Deny\n",
            "ascii cursor at line start": "Choose access:\n> Allow all actions\n  Deny\n",
            "other cursor glyph": " › Allow all actions\n   Deny\n",
            "cursor inside a box": "╭──────────────╮\n│ ❯ Allow all  │\n│   Deny       │\n╰──────────────╯\n",
            "footer only": "Allow all actions?\nEsc to cancel\n",
            "footer wrapped over two lines": "Allow all actions?\n  Esc to\n  cancel\n",
            "prompt drawn with the cursor glyph": "❯ echo start > /tmp/log\n",
        }
        for name, above in refused.items():
            with self.subTest(name):
                self.screens(above + DEV_CHANNELS)
                keys_log = self.fake / "keys.log"
                if keys_log.exists():
                    keys_log.unlink()
                classified = self.run_script(CONFIRM, "--classify", "-L", "channel-test", "channel-test")
                self.assertEqual(classified.stdout.strip(), "dev-channels-unrecognized", classified.stderr)
                self.assertEqual(classified.code, 4, classified.stderr)
                result = self.confirm()
                self.assertEqual(result.keys, [])
                self.assertEqual(result.code, 4, result.stderr)

    def test_escaped_capture_with_a_dialog_above_gets_no_keys(self) -> None:
        above = f"{ESC}[1mChoose access:{ESC}[0m\n{ESC}[36m❯{ESC}[0m Allow all actions\n  Deny\n"
        self.screens(above + DEV_CHANNELS_ESCAPES)
        result = self.confirm()
        self.assertEqual(result.keys, [])
        self.assertEqual(result.code, 4, result.stderr)

    # ── N2: no key after the deadline ────────────────────────────────────────

    def test_slow_second_look_past_the_deadline_sends_no_key(self) -> None:
        # The deadline is 2 s; the look right before the key answers late. 2.6 s
        # is inside the error of a whole-second clock: only a real timer sees it.
        self.screens(DEV_CHANNELS, READY)
        for delay in ("2.6", "2.6", "2.6", "4"):
            with self.subTest(delay):
                for name in ("captures.all", "keys.log"):
                    if (self.fake / name).exists():
                        (self.fake / name).unlink()
                (self.fake / "delay.1").write_text(f"{delay}\n", encoding="utf-8")
                result = self.run_script(
                    CONFIRM, "--timeout", "2", "--interval", "0.05", "--press-pause", "0.05",
                    "-L", "channel-test", "channel-test", timeout=20,
                )
                self.assertEqual(result.keys, [])
                self.assertEqual(result.code, 3, result.stderr)
                self.assertIn("action=timeout", result.stderr)

    def test_hung_tmux_call_ends_at_the_hard_ceiling_and_frees_the_lock(self) -> None:
        self.screens(DEV_CHANNELS)
        (self.fake / "hang").write_text("", encoding="utf-8")
        started = time.monotonic()
        result = self.run_script(
            CONFIRM, "--timeout", "1", "--interval", "0.05", "-L", "channel-test", "channel-test",
            env={"STARTUP_CONFIRM_HARD_MARGIN": "1"}, timeout=30,
        )
        self.assertLess(time.monotonic() - started, 12)
        self.assertEqual(result.code, 11, result.stderr)
        self.assertIn("action=hard-ceiling", result.stderr)
        self.assertEqual(result.keys, [])
        self.assertFalse((self.pane_lock() / "held").exists())
        # The freed lock is usable at once.
        (self.fake / "hang").unlink()
        self.screens(DEV_CHANNELS, READY)
        again = self.confirm()
        self.assertEqual(again.code, 0, again.stderr)
        self.assertEqual(again.keys, ["Enter"])

    def test_watchdog_leaves_no_process_behind_after_a_normal_run(self) -> None:
        self.screens(READY)
        marker = "86399"
        started = time.monotonic()
        result = self.run_script(
            CONFIRM, "--timeout", marker, "-L", "channel-test", "channel-test",
            env={"STARTUP_CONFIRM_HARD_MARGIN": "1"},
        )
        self.assertEqual(result.code, 0, result.stderr)
        # subprocess.run returned: nothing kept the output pipes open.
        self.assertLess(time.monotonic() - started, 10)
        time.sleep(0.3)
        ps = subprocess.run(["ps", "-A", "-o", "args="], capture_output=True, text=True, check=True).stdout
        self.assertNotIn("sleep 86400", ps)

    def test_flag_name_on_the_shell_line_alone_is_not_the_warning(self) -> None:
        self.screens("bash-3.2$ claude --dangerously-load-development-channels server:dummy\n")
        result = self.run_script(CONFIRM, "--classify", "-L", "channel-test", "channel-test")
        self.assertEqual(result.stdout.strip(), "unknown")

    # ── B2: pinned pane id, one confirmer per pane ───────────────────────────

    def _holder(self) -> tuple[subprocess.Popen[str], Path]:
        """A confirmer that sits on a bare shell pane (same socket and pane id) and holds the lock."""
        other = self.root / "fake-holder"
        (other / "screens").mkdir(parents=True)
        (other / "screens" / "0.txt").write_text(SHELL_ONLY, encoding="utf-8")
        holder = self.spawn(
            CONFIRM, "--timeout", "30", "--interval", "0.05", "-L", "channel-test", "channel-test",
            env={"FAKE_TMUX_DIR": str(other)},
        )
        locks = self.root / "locks"
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and not (locks.is_dir() and any(locks.iterdir())):
            time.sleep(0.05)
        return holder, locks

    def test_second_confirmer_with_the_lock_held_presses_nothing(self) -> None:
        holder, locks = self._holder()
        self.assertTrue(locks.is_dir() and any(locks.iterdir()), "the first confirmer took no lock")
        self.screens(DEV_CHANNELS, READY)
        result = self.confirm()
        self.assertEqual(result.code, 8, result.stderr)
        self.assertEqual(result.keys, [])
        self.assertIn("action=lock-held", result.stderr)
        self.assertIsNone(holder.poll(), "the lock holder must still be running")
        holder.send_signal(signal.SIGTERM)
        holder.wait(timeout=10)
        # A confirmer that ends on a signal releases its lock.
        self.assertEqual(list(locks.iterdir()), [])

    def test_lock_of_a_dead_confirmer_is_taken_over(self) -> None:
        holder, locks = self._holder()
        self.assertTrue(locks.is_dir() and any(locks.iterdir()), "the first confirmer took no lock")
        holder.kill()
        holder.wait(timeout=10)
        self.assertTrue(any(locks.iterdir()), "SIGKILL leaves the lock behind")
        self.screens(DEV_CHANNELS, READY)
        result = self.confirm()
        self.assertEqual(result.code, 0, result.stderr)
        self.assertEqual(result.keys, ["Enter"])
        self.assertEqual(list(locks.iterdir()), [])

    # ── Lock ownership: identity, not age ────────────────────────────────────

    def test_live_owner_with_an_old_lock_is_not_robbed(self) -> None:
        # Review B2: a real confirmer that has held the lock "for two hours".
        holder, locks = self._holder()
        self.assertTrue(locks.is_dir() and any(locks.iterdir()), "the first confirmer took no lock")
        for lock in locks.iterdir():
            age_tree(lock, 7200)
        self.screens(DEV_CHANNELS, READY)
        result = self.confirm()
        self.assertEqual(result.code, 8, result.stderr)
        self.assertEqual(result.keys, [])
        self.assertIn("action=lock-held", result.stderr)
        self.assertIsNone(holder.poll(), "the lock holder must still be running")

    def test_old_record_of_a_live_process_is_not_robbed(self) -> None:
        self.write_lock(self.pane_lock(), os.getpid(), self.process_identity(os.getpid()), legacy_pid=True)
        age_tree(self.pane_lock(), 7200)
        self.screens(DEV_CHANNELS, READY)
        result = self.confirm()
        self.assertEqual(result.code, 8, result.stderr)
        self.assertEqual(result.keys, [])

    def test_lock_of_a_dead_pid_is_recovered(self) -> None:
        self.write_lock(self.pane_lock(), dead_pid(), "ps:Thu_Jan__1_00:00:00_1970")
        self.screens(DEV_CHANNELS, READY)
        result = self.confirm()
        self.assertEqual(result.code, 0, result.stderr)
        self.assertEqual(result.keys, ["Enter"])
        self.assertFalse(self.pane_lock().exists())

    def test_lock_of_a_reused_pid_is_recovered(self) -> None:
        # Same pid, alive, but started at another time: not the process that took the lock.
        identity = self.process_identity(os.getpid())
        self.write_lock(self.pane_lock(), os.getpid(), identity + "0", legacy_pid=True)
        self.screens(DEV_CHANNELS, READY)
        result = self.confirm()
        self.assertEqual(result.code, 0, result.stderr)
        self.assertEqual(result.keys, ["Enter"])
        self.assertFalse((self.pane_lock() / "held").exists())

    def test_identity_recorded_by_another_method_is_treated_as_held(self) -> None:
        # Fail closed: a start time we cannot compare never proves the owner gone.
        identity = self.process_identity(os.getpid())
        other = "ps:Thu_Jan__1_00:00:00_1970" if identity.startswith("proc:") else "proc:x:1"
        self.write_lock(self.pane_lock(), os.getpid(), other)
        self.screens(DEV_CHANNELS, READY)
        result = self.confirm()
        self.assertEqual(result.code, 8, result.stderr)
        self.assertEqual(result.keys, [])

    def test_record_without_identity_and_bare_lock_directory_do_not_block(self) -> None:
        # A record is published complete (hard link), so a live owner never has a
        # garbled one; a directory without `held` is not a lock at all.
        lock = self.pane_lock()
        cases = {"empty record": "", "garbage": "not a record\n", "pid zero": "0 0-1-test ps:x\n", "no record": None}
        for name, content in cases.items():
            with self.subTest(name):
                lock.mkdir(parents=True, exist_ok=True)
                if content is not None:
                    (lock / "held").write_text(content, encoding="utf-8")
                keys_log = self.fake / "keys.log"
                if keys_log.exists():
                    keys_log.unlink()
                self.screens(DEV_CHANNELS, READY)
                result = self.confirm()
                self.assertEqual(result.code, 0, result.stderr)
                self.assertEqual(result.keys, ["Enter"])
                self.assertFalse(lock.exists())

    def test_record_being_prepared_by_another_process_is_left_alone(self) -> None:
        # Another process is between writing its record and publishing it.
        lock = self.pane_lock()
        lock.mkdir(parents=True)
        pending = lock / "tmp.4242-1-other"
        pending.write_text("4242 4242-1-other ps:x\n", encoding="utf-8")
        self.screens(DEV_CHANNELS, READY)
        result = self.confirm()
        self.assertEqual(result.code, 0, result.stderr)
        self.assertEqual(pending.read_text(encoding="utf-8"), "4242 4242-1-other ps:x\n")

    def test_marker_of_a_recoverer_that_died_does_not_block_recovery(self) -> None:
        lock = self.pane_lock()
        gone = dead_pid()
        self.write_lock(lock, gone, "ps:Thu_Jan__1_00:00:00_1970")
        # A recoverer claimed the record of that owner and died before removing it.
        other = dead_pid()
        (lock / f"bury.{gone}-1-test").write_text(f"{other} {other}-2-test ps:Thu_Jan__1_00:00:00_1970\n", encoding="utf-8")
        self.screens(DEV_CHANNELS, READY)
        result = self.confirm()
        self.assertEqual(result.code, 0, result.stderr)
        self.assertEqual(result.keys, ["Enter"])
        self.assertFalse(lock.exists())

    def test_marker_of_a_live_recoverer_is_respected(self) -> None:
        lock = self.pane_lock()
        gone = dead_pid()
        self.write_lock(lock, gone, "ps:Thu_Jan__1_00:00:00_1970")
        mine = self.process_identity(os.getpid())
        (lock / f"bury.{gone}-1-test").write_text(f"{os.getpid()} {os.getpid()}-2-test {mine}\n", encoding="utf-8")
        self.screens(DEV_CHANNELS, READY)
        result = self.confirm()
        self.assertEqual(result.code, 8, result.stderr)
        self.assertEqual(result.keys, [])
        self.assertTrue((lock / "held").exists())

    def _race(self, lock: Path, count: int) -> list[int]:
        """Start `count` real processes that take `lock` at once; return the winners' pids."""
        winners = self.root / f"winners.{lock.name}"
        go = self.root / f"go.{lock.name}"
        driver = self.root / "race.sh"
        driver.write_text(
            'set -u\n. "$1"\nwhile [ ! -e "$4" ]; do :; done\n'
            'if lock_take "$2"; then echo "$$" >> "$3"; sleep 1.5; lock_mine || echo lost >> "$3"; lock_release; exit 0; fi\n'
            "exit 1\n",
            encoding="utf-8",
        )
        procs = [
            subprocess.Popen(["/bin/bash", str(driver), str(self.lock_lib()), str(lock), str(winners), str(go)])
            for _ in range(count)
        ]
        time.sleep(0.3)
        go.write_text("", encoding="utf-8")
        codes = [proc.wait(timeout=60) for proc in procs]
        lines = winners.read_text(encoding="utf-8").split() if winners.exists() else []
        self.assertNotIn("lost", lines)
        self.assertEqual(codes.count(0), len(lines))
        return [int(line) for line in lines]

    def test_processes_recovering_one_abandoned_lock_at_once_have_exactly_one_winner(self) -> None:
        for round_number in range(6):
            with self.subTest(round_number):
                lock = self.root / "race-locks" / f"abandoned-{round_number}.lock"
                self.write_lock(lock, dead_pid(), "ps:Thu_Jan__1_00:00:00_1970")
                self.assertEqual(len(self._race(lock, 8)), 1)
                self.assertFalse((lock / "held").exists())

    def test_processes_taking_one_free_lock_at_once_have_exactly_one_winner(self) -> None:
        for round_number in range(3):
            with self.subTest(round_number):
                lock = self.root / "race-locks" / f"free-{round_number}.lock"
                self.assertEqual(len(self._race(lock, 8)), 1)

    def test_confirmers_recovering_one_abandoned_lock_at_once_press_once(self) -> None:
        # Real confirmers on one pane; the winner holds the lock for its whole run.
        self.write_lock(self.pane_lock(), dead_pid(), "ps:Thu_Jan__1_00:00:00_1970")
        self.screens(SHELL_ONLY)
        procs = [
            self.spawn(CONFIRM, "--timeout", "3", "--interval", "0.1", "-L", "channel-test", "channel-test")
            for _ in range(6)
        ]
        codes = sorted(proc.wait(timeout=60) for proc in procs)
        self.assertEqual(codes, [6, 8, 8, 8, 8, 8])
        self.assertFalse(self.pane_lock().exists())

    def test_both_scripts_carry_the_same_lock_functions(self) -> None:
        self.assertEqual(lock_block(CONFIRM), lock_block(CHECK))
        self.assertIn("lock_take()", lock_block(CHECK))

    def test_pane_id_that_cannot_be_resolved_gets_no_keys(self) -> None:
        self.screens(DEV_CHANNELS)
        (self.fake / "pane_id").write_text("channel-test\n", encoding="utf-8")
        result = self.confirm()
        self.assertEqual(result.code, 7, result.stderr)
        self.assertEqual(result.keys, [])

    # ── B3: the deadline holds on every path ─────────────────────────────────

    def test_timeout_zero_is_one_look_at_most_even_on_alternating_screens(self) -> None:
        self.cycle(DEV_CHANNELS, TRUST_FOLDER_BARE)
        result = self.run_script(
            CONFIRM, "--timeout", "0", "--interval", "0.05", "--press-pause", "0.05",
            "-L", "channel-test", "channel-test", timeout=15,
        )
        captures = [call for call in result.calls if "capture-pane" in call]
        self.assertLessEqual(len(captures), 1, captures)
        self.assertEqual(result.keys, [])
        self.assertEqual(result.code, 3, result.stderr)
        self.assertIn("action=timeout", result.stderr)

    def test_alternating_screens_end_at_the_deadline_without_keys(self) -> None:
        # Every first look shows dev-channels, every look right before the key shows trust-folder.
        self.cycle(DEV_CHANNELS, TRUST_FOLDER_BARE)
        started = time.monotonic()
        result = self.run_script(
            CONFIRM, "--timeout", "1", "--interval", "0.2", "--press-pause", "0.2",
            "-L", "channel-test", "channel-test", timeout=15,
        )
        self.assertLess(time.monotonic() - started, 6)
        self.assertEqual(result.keys, [])
        self.assertIn(result.code, (3, 5), result.stderr)
        captures = [call for call in result.calls if "capture-pane" in call]
        self.assertLessEqual(len(captures), 24, len(captures))

    def test_sleep_is_bounded_by_the_remaining_time(self) -> None:
        self.screens(SHELL_ONLY)
        started = time.monotonic()
        result = self.run_script(
            CONFIRM, "--timeout", "1", "--interval", "30", "-L", "channel-test", "channel-test", timeout=15
        )
        self.assertLess(time.monotonic() - started, 6)
        self.assertEqual(result.code, 6, result.stderr)

    # ── tmux binary missing ──────────────────────────────────────────────────

    def test_missing_tmux_binary_has_its_own_exit_code_and_log_line(self) -> None:
        self.screens(DEV_CHANNELS)
        env = {"TMUX_BIN": str(self.root / "no-such-dir" / "tmux")}
        result = self.confirm(env=env)
        self.assertEqual(result.code, 9, result.stderr)
        self.assertIn("result=tmux-not-found", result.stderr)
        self.assertNotIn("no-session", result.stderr)
        classified = self.run_script(CONFIRM, "--classify", "-L", "channel-test", "channel-test", env=env)
        self.assertEqual(classified.code, 9, classified.stderr)
        self.assertEqual(classified.stdout.strip(), "tmux-missing")

    def test_bad_numbers_are_usage_errors(self) -> None:
        self.screens(DEV_CHANNELS)
        for flag, value in (("--interval", "soon"), ("--press-pause", "-1"), ("--timeout", "")):
            with self.subTest(flag):
                result = self.run_script(CONFIRM, flag, value, "-L", "channel-test", "channel-test", timeout=15)
                self.assertEqual(result.code, 2, result.stderr)
                self.assertEqual(result.keys, [])

    def test_timeout_with_a_leading_zero_is_decimal(self) -> None:
        self.screens(SHELL_ONLY)
        result = self.run_script(
            CONFIRM, "--timeout", "08", "--max-presses", "09", "--classify", "-L", "channel-test", "channel-test"
        )
        self.assertEqual(result.code, 6, result.stderr)
        result = self.run_script(
            CONFIRM, "--timeout", "00", "--interval", "0.05", "-L", "channel-test", "channel-test", timeout=15
        )
        self.assertEqual(result.code, 6, result.stderr)
        self.assertNotIn("value too great", result.stderr)

    def test_usage_error_without_target(self) -> None:
        result = self.run_script(CONFIRM)
        self.assertEqual(result.code, 2)
        self.assertEqual(result.calls, [])


class CheckStartupScreenTest(FakeTmuxCase):
    def setUp(self) -> None:
        super().setUp()
        self.state = self.root / "state"
        self.events = self.root / "events.log"
        self.env["STARTUP_ALERT_CMD"] = f"printf '%s %s %s\\n' \"$1\" \"$2\" \"$3\" >> '{self.events}'"

    def check(self, now: int, *extra: str, env: dict[str, str] | None = None) -> Result:
        merged = {"STARTUP_CHECK_NOW": str(now)}
        merged.update(env or {})
        return self.run_script(
            CHECK, "--state-dir", str(self.state), *extra, "kael -L channel-kael channel-kael", env=merged
        )

    def event_lines(self) -> list[str]:
        return self.events.read_text(encoding="utf-8").splitlines() if self.events.exists() else []

    def test_below_threshold_no_event(self) -> None:
        self.screens(DEV_CHANNELS)
        self.assertEqual(self.check(1000).code, 0)
        self.assertEqual(self.check(1060).code, 0)
        self.assertEqual(self.event_lines(), [])
        self.assertTrue((self.state / "kael.startup-screen").exists())

    def test_above_threshold_one_event_even_on_repeated_runs(self) -> None:
        self.screens(DEV_CHANNELS)
        self.check(1000)
        self.check(1130)
        self.check(1190)
        self.check(1250)
        self.assertEqual(self.event_lines(), ["kael dev-channels 130"])

    def test_screen_gone_clears_state_and_next_incident_alerts_again(self) -> None:
        self.screens(DEV_CHANNELS)
        self.check(1000)
        self.check(1130)
        self.screens(READY)
        self.check(1190)
        self.assertFalse((self.state / "kael.startup-screen").exists())
        self.screens(TRUST_FOLDER)
        self.check(5000)
        self.check(5121)
        self.assertEqual(self.event_lines(), ["kael dev-channels 130", "kael trust-folder 121"])

    def test_threshold_option(self) -> None:
        self.screens(DEV_CHANNELS_CURSOR_ON_2)
        self.check(1000, "--threshold", "30")
        self.check(1031, "--threshold", "30")
        self.assertEqual(self.event_lines(), ["kael dev-channels-unrecognized 31"])

    def test_failed_alert_command_is_retried_next_run(self) -> None:
        self.screens(DEV_CHANNELS)
        self.check(1000)
        failed = self.check(1130, env={"STARTUP_ALERT_CMD": "exit 9"})
        self.assertNotEqual(failed.code, 0)
        self.check(1190)
        self.assertEqual(self.event_lines(), ["kael dev-channels 190"])

    def test_alert_command_also_gets_environment_variables(self) -> None:
        self.screens(DEV_CHANNELS)
        self.check(1000)
        self.check(
            1125,
            env={
                "STARTUP_ALERT_CMD": "printf '%s %s %s\\n' \"$STARTUP_ALERT_AGENT\" "
                f"\"$STARTUP_ALERT_KIND\" \"$STARTUP_ALERT_SECONDS\" >> '{self.events}'"
            },
        )
        self.assertEqual(self.event_lines(), ["kael dev-channels 125"])

    def test_agents_from_config_file_and_no_keys_ever(self) -> None:
        self.screens(DEV_CHANNELS)
        config = self.root / "agents.conf"
        config.write_text("# agent socket target\n\nkael -L channel-kael channel-kael\nsil -S /tmp/s.sock sil:0\n", encoding="utf-8")
        for now in (1000, 1200):
            result = self.run_script(
                CHECK, "--state-dir", str(self.state), "--config", str(config), env={"STARTUP_CHECK_NOW": str(now)}
            )
            self.assertEqual(result.code, 0, result.stderr)
        self.assertEqual(sorted(self.event_lines()), ["kael dev-channels 200", "sil dev-channels 200"])
        self.assertEqual(result.keys, [])
        self.assertIn("-S /tmp/s.sock display-message -p -t sil:0 #{pane_id}", result.calls)
        self.assertIn(f"-S /tmp/s.sock capture-pane -p -t {PANE_ID}", result.calls)

    def test_output_never_contains_pane_content(self) -> None:
        self.screens(TRUST_FOLDER_WITH_SECRET)
        first = self.check(1000)
        second = self.check(1200)
        for text in (first.stderr, first.stdout, second.stderr, second.stdout, "\n".join(self.event_lines())):
            self.assertNotIn(SECRET, text)

    def test_logged_out_session_raises_the_alert(self) -> None:
        self.screens(LOGGED_OUT)
        self.check(1000)
        self.check(1121)
        self.assertEqual(self.event_lines(), ["kael login 121"])

    def test_two_concurrent_runs_raise_exactly_one_alert(self) -> None:
        # B4: real processes, slow alert command; both start while alerted=0.
        self.screens(DEV_CHANNELS)
        self.check(1000)
        slow = f"sleep 1; printf '%s %s %s\\n' \"$1\" \"$2\" \"$3\" >> '{self.events}'"
        env = {"STARTUP_CHECK_NOW": "1200", "STARTUP_ALERT_CMD": slow}
        args = ("--state-dir", str(self.state), "kael -L channel-kael channel-kael")
        first = self.spawn(CHECK, *args, env=env)
        second = self.spawn(CHECK, *args, env=env)
        codes = (first.wait(timeout=30), second.wait(timeout=30))
        self.assertEqual(codes, (0, 0))
        self.assertEqual(self.event_lines(), ["kael dev-channels 200"])
        # The delivered alert was persisted: a later run stays silent.
        self.check(1300)
        self.assertEqual(self.event_lines(), ["kael dev-channels 200"])
        self.assertEqual([p.name for p in self.state.iterdir()], ["kael.startup-screen"])

    def test_run_that_finds_the_agent_locked_skips_it_without_alert(self) -> None:
        self.screens(DEV_CHANNELS)
        self.check(1000)
        lock = self.state / "kael.lock"
        self.write_lock(lock, os.getpid(), self.process_identity(os.getpid()))
        result = self.check(1200)
        self.assertEqual(result.code, 0, result.stderr)
        self.assertIn("reason=locked", result.stderr)
        self.assertEqual(self.event_lines(), [])
        # A lock whose owner is gone is abandoned: the next run takes it over and alerts.
        self.write_lock(lock, dead_pid(), "ps:Thu_Jan__1_00:00:00_1970")
        result = self.check(1200)
        self.assertEqual(result.code, 0, result.stderr)
        self.assertEqual(self.event_lines(), ["kael dev-channels 200"])
        self.assertFalse(lock.exists())

    # ── Lock ownership: identity, not age ────────────────────────────────────

    def test_live_run_with_an_old_lock_is_not_robbed_and_alerts_once(self) -> None:
        # Review B2 with real processes: the first run is inside its (slow) alert
        # command and its lock looks two hours old.
        self.screens(DEV_CHANNELS)
        self.check(1000)
        slow = f"sleep 3; printf '%s %s %s\\n' \"$1\" \"$2\" \"$3\" >> '{self.events}'"
        env = {"STARTUP_CHECK_NOW": "1200", "STARTUP_ALERT_CMD": slow}
        args = ("--state-dir", str(self.state), "kael -L channel-kael channel-kael")
        lock = self.state / "kael.lock"
        first = self.spawn(CHECK, *args, env=env)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline and not (lock.is_dir() and any(lock.iterdir())):
            time.sleep(0.02)
        self.assertTrue(lock.is_dir() and any(lock.iterdir()), "the first run took no lock")
        age_tree(lock, 7200)
        second = self.check(1200, env={"STARTUP_ALERT_CMD": slow})
        self.assertIsNone(first.poll(), "the first run must still be inside its alert command")
        self.assertIn("action=skip", second.stderr)
        self.assertEqual(first.wait(timeout=30), 0)
        self.assertEqual(self.event_lines(), ["kael dev-channels 200"])
        # A lock that old is reported (exit 1), never taken.
        self.assertEqual(second.code, 1, second.stderr)
        self.assertIn("reason=lock-held-too-long", second.stderr)

    def test_old_record_of_a_live_process_is_not_robbed(self) -> None:
        self.screens(DEV_CHANNELS)
        self.check(1000)
        lock = self.state / "kael.lock"
        self.write_lock(lock, os.getpid(), self.process_identity(os.getpid()), legacy_pid=True)
        age_tree(lock, 7200)
        result = self.check(1200)
        self.assertIn("action=skip", result.stderr)
        self.assertEqual(self.event_lines(), [])
        self.assertTrue((lock / "held").exists())

    def test_lock_of_a_reused_pid_is_recovered(self) -> None:
        self.screens(DEV_CHANNELS)
        self.check(1000)
        lock = self.state / "kael.lock"
        self.write_lock(lock, os.getpid(), self.process_identity(os.getpid()) + "0", legacy_pid=True)
        result = self.check(1200)
        self.assertEqual(result.code, 0, result.stderr)
        self.assertEqual(self.event_lines(), ["kael dev-channels 200"])
        self.assertFalse((lock / "held").exists())

    def test_runs_recovering_one_abandoned_lock_at_once_raise_one_alert(self) -> None:
        self.screens(DEV_CHANNELS)
        self.check(1000)
        self.write_lock(self.state / "kael.lock", dead_pid(), "ps:Thu_Jan__1_00:00:00_1970")
        slow = f"sleep 1; printf '%s %s %s\\n' \"$1\" \"$2\" \"$3\" >> '{self.events}'"
        env = {"STARTUP_CHECK_NOW": "1200", "STARTUP_ALERT_CMD": slow}
        args = ("--state-dir", str(self.state), "kael -L channel-kael channel-kael")
        procs = [self.spawn(CHECK, *args, env=env) for _ in range(6)]
        codes = [proc.wait(timeout=60) for proc in procs]
        self.assertEqual(codes, [0] * 6)
        self.assertEqual(self.event_lines(), ["kael dev-channels 200"])
        self.assertEqual([p.name for p in self.state.iterdir()], ["kael.startup-screen"])

    # ── Bounded steps: a live owner cannot hold the lock forever ─────────────

    def test_hanging_alert_command_is_killed_and_retried_next_run(self) -> None:
        self.screens(DEV_CHANNELS)
        self.check(1000)
        child = self.root / "alert-child.pid"
        hanging = f"sleep 300 & echo $! > '{child}'; wait"
        started = time.monotonic()
        result = self.check(1200, env={"STARTUP_ALERT_CMD": hanging, "STARTUP_ALERT_TIMEOUT": "1"})
        self.assertLess(time.monotonic() - started, 15)
        self.assertEqual(result.code, 1, result.stderr)
        self.assertIn("delivered=no", result.stderr)
        self.assertIn("reason=alert-timeout", result.stderr)
        # No job-control chatter of the shell next to the log lines.
        for line in result.stderr.splitlines():
            self.assertIn(" check-startup-screen ", line)
        # The whole command tree is gone, the lock is released, the alert is still owed.
        time.sleep(0.3)
        with self.assertRaises(ProcessLookupError):
            os.kill(int(child.read_text(encoding="utf-8")), 0)
        self.assertFalse((self.state / "kael.lock").exists())
        self.assertEqual((self.state / "kael.startup-screen").read_text(encoding="utf-8"), "1000 dev-channels 0\n")
        self.assertEqual(self.event_lines(), [])
        self.check(1260)
        self.assertEqual(self.event_lines(), ["kael dev-channels 260"])

    def test_alert_command_does_not_read_the_agent_list(self) -> None:
        # The alert command gets an empty stdin, not the rest of the agent list.
        self.screens(DEV_CHANNELS)
        both = ("--state-dir", str(self.state), "kael -L channel-kael channel-kael", "sil -L channel-sil channel-sil")
        self.run_script(CHECK, *both, env={"STARTUP_CHECK_NOW": "1000"})
        eater = f"cat > /dev/null; printf '%s %s %s\\n' \"$1\" \"$2\" \"$3\" >> '{self.events}'"
        result = self.run_script(CHECK, *both, env={"STARTUP_CHECK_NOW": "1200", "STARTUP_ALERT_CMD": eater})
        self.assertEqual(result.code, 0, result.stderr)
        self.assertEqual(sorted(self.event_lines()), ["kael dev-channels 200", "sil dev-channels 200"])

    def test_hung_tmux_look_is_cut_off_and_keeps_the_state(self) -> None:
        self.screens(DEV_CHANNELS)
        self.check(1000)
        (self.fake / "hang").write_text("", encoding="utf-8")
        started = time.monotonic()
        result = self.check(1200, env={"STARTUP_CHECK_CLASSIFY_TIMEOUT": "1"})
        self.assertLess(time.monotonic() - started, 15)
        self.assertEqual(result.code, 1, result.stderr)
        self.assertIn("reason=classify-timeout", result.stderr)
        self.assertEqual(self.event_lines(), [])
        self.assertFalse((self.state / "kael.lock").exists())
        self.assertEqual((self.state / "kael.startup-screen").read_text(encoding="utf-8"), "1000 dev-channels 0\n")

    def test_bad_time_limits_are_usage_errors(self) -> None:
        self.screens(DEV_CHANNELS)
        for name in ("STARTUP_ALERT_TIMEOUT", "STARTUP_CHECK_CLASSIFY_TIMEOUT", "STARTUP_LOCK_WARN_MIN"):
            for value in ("soon", "0", ""):
                with self.subTest(f"{name}={value!r}"):
                    result = self.check(1000, env={name: value})
                    self.assertEqual(result.code, 2 if value else 0, result.stderr)

    def test_malformed_timestamp_in_state_resets_the_incident(self) -> None:
        self.screens(DEV_CHANNELS)
        self.state.mkdir()
        state_file = self.state / "kael.startup-screen"
        for bad in ("08", "0900", "12x", "99999999999999999999", "5000"):
            with self.subTest(bad):
                state_file.write_text(f"{bad} dev-channels 1\n", encoding="utf-8")
                result = self.check(1200)
                self.assertEqual(result.code, 0, result.stderr)
                self.assertNotIn("value too great", result.stderr)
                self.assertIn("action=state-reset", result.stderr)
                self.assertEqual(state_file.read_text(encoding="utf-8"), "1200 dev-channels 0\n")
        self.assertEqual(self.event_lines(), [])
        # From the reset on, the incident is timed and alerted as usual.
        self.check(1330)
        self.assertEqual(self.event_lines(), ["kael dev-channels 130"])

    def test_failed_state_write_makes_the_run_exit_non_zero(self) -> None:
        self.screens(DEV_CHANNELS)
        self.check(1000)
        state_file = self.state / "kael.startup-screen"
        self.addCleanup(self.state.chmod, 0o755)
        # The alert is delivered, then the state can no longer be replaced.
        breaking = (
            f"printf '%s %s %s\\n' \"$1\" \"$2\" \"$3\" >> '{self.events}'; "
            f"chmod 444 '{state_file}'; chmod 555 '{self.state}'"
        )
        result = self.check(1200, env={"STARTUP_ALERT_CMD": breaking})
        self.assertEqual(self.event_lines(), ["kael dev-channels 200"])
        self.assertNotEqual(result.code, 0, result.stderr)
        self.assertIn("action=state-write-failed", result.stderr)

    def test_missing_tmux_binary_is_reported_and_keeps_the_state(self) -> None:
        self.screens(DEV_CHANNELS)
        self.check(1000)
        result = self.check(1200, env={"TMUX_BIN": str(self.root / "no-such-dir" / "tmux")})
        self.assertEqual(result.code, 3, result.stderr)
        self.assertIn("reason=tmux-not-found", result.stderr)
        self.assertEqual(self.event_lines(), [])
        self.assertTrue((self.state / "kael.startup-screen").exists())


class WrapperTemplateAndExamplesTest(unittest.TestCase):
    """Static guards: the template sends no blind key; examples are well-formed."""

    WRAPPER = REPO_ROOT / "examples" / "launchd-wrapper.sh.example"

    def _code_lines(self) -> list[str]:
        lines = self.WRAPPER.read_text(encoding="utf-8").splitlines()
        return [line for line in lines if not line.strip().startswith("#")]

    def test_wrapper_sends_only_its_own_start_command(self) -> None:
        sends = [line.strip() for line in self._code_lines() if "send-keys" in line]
        self.assertEqual(len(sends), 2, sends)
        self.assertIn('-l "exec ${CLAUDE_CMD}"', sends[0])
        self.assertIn("C-m", sends[1])
        self.assertFalse(any("Enter" in line for line in sends), sends)

    def test_wrapper_starts_a_shell_and_calls_the_confirm_script(self) -> None:
        code = "\n".join(self._code_lines())
        self.assertRegex(code, r'new-session -d -s "\$TMUX_SESSION" -c "\$WORKSPACE" /bin/bash')
        self.assertIn('"$CONFIRM_SCRIPT" "$TMUX_SESSION" &', code)
        self.assertNotIn("sleep 6", code)
        self.assertIn("Never send blind input", self.WRAPPER.read_text(encoding="utf-8"))

    def test_check_plist_example_is_valid_and_periodic(self) -> None:
        with (REPO_ROOT / "examples" / "startup-screen-check.plist.example").open("rb") as handle:
            data = plistlib.load(handle)
        self.assertEqual(data["StartInterval"], 60)
        self.assertTrue(data["ProgramArguments"][1].endswith("scripts/check-startup-screen.sh"))
        self.assertIn("STARTUP_ALERT_CMD", data["EnvironmentVariables"])
        # launchd gives jobs a bare PATH without Homebrew: tmux is named explicitly.
        self.assertIn("/opt/homebrew/bin", data["EnvironmentVariables"]["PATH"])
        self.assertTrue(data["EnvironmentVariables"]["TMUX_BIN"].endswith("tmux"))

    def test_wrapper_hands_its_absolute_tmux_to_the_confirm_script(self) -> None:
        code = "\n".join(self._code_lines())
        self.assertIn('TMUX_BIN="$TMUX_BIN" /bin/bash "$CONFIRM_SCRIPT"', code)
        self.assertIn("TMUX_BIN", self.WRAPPER.read_text(encoding="utf-8").split("Startup dialogs.")[1])

    def test_docs_and_readmes_do_not_call_exit_zero_proof_of_readiness(self) -> None:
        for name in ("README.md", "README.ru.md"):
            text = (REPO_ROOT / name).read_text(encoding="utf-8")
            self.assertNotIn("exit code equals real readiness", text)
            self.assertNotIn("код выхода равен реальной готовности", text)
        doc = (REPO_ROOT / "docs" / "07-startup-screen-confirm.md").read_text(encoding="utf-8")
        for needle in ("TMUX_BIN", "/opt/homebrew/bin", "| 8 |", "| 9 |"):
            self.assertIn(needle, doc)

    def test_systemd_timer_example_runs_the_check(self) -> None:
        service = (REPO_ROOT / "examples" / "startup-screen-check.service.example").read_text(encoding="utf-8")
        timer = (REPO_ROOT / "examples" / "startup-screen-check.timer.example").read_text(encoding="utf-8")
        self.assertIn("Type=oneshot", service)
        self.assertIn("scripts/check-startup-screen.sh", service)
        self.assertIn("OnUnitActiveSec=", timer)

    def test_alert_example_writes_outbox_line_without_network(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            outbox = Path(tmp) / "alerts.log"
            proc = subprocess.run(
                ["/bin/bash", str(REPO_ROOT / "examples" / "startup-alert.sh.example"), "kael", "dev-channels", "130"],
                env={"PATH": "/usr/bin:/bin", "HOME": tmp, "STARTUP_ALERT_OUTBOX": str(outbox)},
                capture_output=True,
                text=True,
                timeout=30,
                check=False,
            )
            self.assertEqual(proc.returncode, 0, proc.stderr)
            line = outbox.read_text(encoding="utf-8")
            self.assertIn("to=arthas agent=kael kind=dev-channels seconds=130", line)

    def test_no_secrets_or_urls_baked_into_shipped_files(self) -> None:
        for name in ("scripts/confirm-startup-screen.sh", "scripts/check-startup-screen.sh", "examples/startup-alert.sh.example"):
            text = (REPO_ROOT / name).read_text(encoding="utf-8")
            self.assertNotRegex(text, r"https?://", name)


if __name__ == "__main__":
    unittest.main()
