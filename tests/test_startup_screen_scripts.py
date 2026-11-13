"""Behaviour tests for scripts/confirm-startup-screen.sh and
scripts/check-startup-screen.sh.

Both scripts talk to tmux only through the `tmux` executable, so the tests put
a fake `tmux` on PATH. The fake prints a canned pane (chosen by how many keys
were sent so far) and records every `send-keys` call. No real tmux server is
ever contacted.

The pane texts below are RECONSTRUCTED from the phrases quoted in the docs of
this repository; they are not captures of a real Claude Code screen. When a
real capture is available, adjust the pattern list at the top of
scripts/confirm-startup-screen.sh and these fixtures together.
"""

from __future__ import annotations

import os
import stat
import subprocess
import tempfile
import unittest
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
CONFIRM = REPO_ROOT / "scripts" / "confirm-startup-screen.sh"
CHECK = REPO_ROOT / "scripts" / "check-startup-screen.sh"

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
  capture-pane)
    [ -e "$d/gone" ] && exit 1
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

DEV_CHANNELS = """\
$ exec claude --dangerously-load-development-channels server:dashi-channel

 WARNING: Loading development channels

 --dangerously-load-development-channels is for local development only. Do not
 use this option to run channels you have downloaded off the internet.

 Please use --channels to run a list of approved channels.

 Channels: server:dashi-channel

 ❯ 1. I am using this for local development
   2. Exit

 Enter to confirm · Esc to cancel
"""

DEV_CHANNELS_CURSOR_ON_2 = DEV_CHANNELS.replace(
    " ❯ 1. I am using", "   1. I am using"
).replace("   2. Exit", " ❯ 2. Exit")

DEV_CHANNELS_EXTRA_OPTION = DEV_CHANNELS.replace(
    "   2. Exit", "   2. Exit\n   3. Always allow these channels"
)

DEV_CHANNELS_OTHER_OPTION_1 = DEV_CHANNELS.replace(
    "1. I am using this for local development", "1. Yes, load everything"
)

DEV_CHANNELS_TEXT_BELOW = DEV_CHANNELS + "\n Type your answer and press Enter\n"

ESC = "\x1b"
DEV_CHANNELS_WRAPPED_ANSI = (
    f"{ESC}[1m╭──────────────────────────────────────╮{ESC}[0m\n"
    f"│ {ESC}[33mWARNING: Loading development{ESC}[0m         │\n"
    f"│ {ESC}[33mchannels{ESC}[0m                             │\n"
    "│                                      │\n"
    "│ --dangerously-load-development-      │\n"
    "│ channels is for local development    │\n"
    "│ only.                                │\n"
    "│                                      │\n"
    f"│ {ESC}[36m❯{ESC}[0m 1. I am using this for local      │\n"
    "│      development                     │\n"
    "│   2. Exit                            │\n"
    "│                                      │\n"
    f"│ {ESC}[2mEnter to confirm · Esc to{ESC}[0m            │\n"
    f"│ {ESC}[2mcancel{ESC}[0m                               │\n"
    "╰──────────────────────────────────────╯\n"
)

READY = f"""\
 ▐▛███▜▌   Claude Code
   {SECRET}

 Listening for channel messages from: server:dashi-channel

╭──────────────────────────────────────────────╮
│ ❯                                            │
╰──────────────────────────────────────────────╯
  ⏵⏵ bypass permissions on (shift+tab to cycle)
"""

# A live session whose conversation quotes the whole dialog.
READY_QUOTING_DIALOG = DEV_CHANNELS + "\n" + READY

TRUST_FOLDER = f"""\
 Do you trust the files in this folder?

 /srv/agents/{SECRET}

 ❯ 1. Yes, proceed
   2. No, exit

 Enter to confirm · Esc to cancel
"""

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

    def run_script(self, script: Path, *args: str, env: dict[str, str] | None = None) -> Result:
        merged = dict(self.env)
        merged.update(env or {})
        proc = subprocess.run(
            ["/bin/bash", str(script), *args],
            env=merged,
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
        return Result(proc.returncode, proc.stdout, proc.stderr, self._lines("keys.log"), self._lines("calls.log"))


class ConfirmStartupScreenTest(FakeTmuxCase):
    FAST = ("--timeout", "1", "--interval", "0.05", "--press-pause", "0.05")

    def confirm(self, *args: str, env: dict[str, str] | None = None) -> Result:
        return self.run_script(CONFIRM, *self.FAST, *args, "-L", "channel-test", "channel-test", env=env)

    def test_dev_channels_screen_gets_exactly_one_enter(self) -> None:
        self.screens(DEV_CHANNELS, READY)
        result = self.confirm()
        self.assertEqual(result.code, 0, result.stderr)
        self.assertEqual(result.keys, ["Enter"])
        sends = [call for call in result.calls if "send-keys" in call]
        self.assertEqual(sends, ["-L channel-test send-keys -t channel-test Enter"])

    def test_socket_path_flag_is_passed_through(self) -> None:
        self.screens(DEV_CHANNELS, READY)
        result = self.run_script(CONFIRM, *self.FAST, "-S", "/tmp/some.sock", "sess:0.0")
        self.assertEqual(result.code, 0, result.stderr)
        self.assertIn("-S /tmp/some.sock send-keys -t sess:0.0 Enter", result.calls)

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
            "bypass-permissions": BYPASS,
            "other-dialog": OTHER_DIALOG,
        }
        for kind, text in dialogs.items():
            with self.subTest(kind):
                self.screens(text)
                result = self.confirm()
                self.assertEqual(result.keys, [])
                self.assertEqual(result.code, 5, result.stderr)
                self.assertIn(f"kind={kind}", result.stderr)

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
        self.screens(DEV_CHANNELS.replace("Channels: server:dashi-channel", SECRET), READY)
        result = self.confirm("--log", str(log))
        self.assertEqual(result.code, 0, result.stderr)
        logged = log.read_text(encoding="utf-8")
        self.assertEqual(logged.count("action=press"), 1)
        self.assertIn("kind=dev-channels", logged)
        for text in (logged, result.stderr, result.stdout):
            self.assertNotIn(SECRET, text)
            self.assertNotIn("Exit", text)

    def test_patterns_are_overridable_by_env(self) -> None:
        text = DEV_CHANNELS.replace("I am using this for local development", "Yes, this is my own channel")
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
        self.assertIn("-S /tmp/s.sock capture-pane -p -t sil:0", result.calls)

    def test_output_never_contains_pane_content(self) -> None:
        self.screens(TRUST_FOLDER)
        first = self.check(1000)
        second = self.check(1200)
        for text in (first.stderr, first.stdout, second.stderr, second.stdout, "\n".join(self.event_lines())):
            self.assertNotIn(SECRET, text)


if __name__ == "__main__":
    unittest.main()
