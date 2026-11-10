# Install with an agent

You are helping a user install the Telegram channel plugin on a Linux server. The user may be non-technical. Work one step at a time; explain each action in plain language and wait for the user when their input is required. The examples use the agent name `myagent`. Run server commands as the dedicated non-root account unless stated otherwise. For macOS, use the [macOS guide](docs/03-installation-macos.md).

## Safety first

- Never request, print, copy, capture or log passwords, OAuth codes, bot tokens, private keys or secret files. Do not ask the user to paste them into agent chat. The user enters them privately in their own terminal or browser. Do not use a terminal tool that records their input or session.
- Ask before each use of `sudo`; explain the action. Never run destructive commands. Never disable a firewall or permission gate unless the user explicitly asks.
- **Before installation:** `install.sh` generates an autonomous service using Claude's `--permission-mode bypassPermissions` and standard hooks, without enabling the permission gate. Claude can perform actions without its normal confirmations. Explain this and obtain explicit consent before running the installer or starting the service. If the user wants confirmations, stop and use the permission-gate guidance in [README](README.md) with their explicit choices; do not silently disable protections.
- Run installation and maintenance through SSH, not through the Telegram channel being changed. Do not display raw logs or terminal captures to the chat without checking for secrets first.

## 1. Choose a server

**Ask:** Do you already have an Ubuntu server, its public address and SSH access? If not, suggest a Linux VPS with Ubuntu 22.04 or 24.04, 2 vCPU and 2–4 GB RAM, in a region where Claude is supported, such as the Netherlands, Germany or Finland. Do not recommend Russia, China or another unsupported region. Check the current [supported countries](https://www.anthropic.com/supported-countries) before purchase. [VDSina](https://vdsina.com/?partner=6x47zemriu8q) is a partner/referral link; other providers are fine. The user purchases the server and keeps credentials private.

**Command:** None until the server exists. **Verify:** Ask for the server address, SSH username and port, not a password or private key. **On failure:** Use the provider's console or support to restore access; do not change firewall settings without the user's request.

## 2. Connect and use a non-root account

**Ask:** Can you connect with SSH, and is the login root? Have the user verify the host fingerprint with their provider. From the user's machine, run or give them this command, replacing the placeholders with their actual values:

```bash
ssh -p PORT USER@SERVER
```

If logged in as root and there is no suitable non-root account, ask before creating one. The root shell can run `useradd -m -s /bin/bash agentctl`; an existing non-root administrator would need permission to use `sudo useradd -m -s /bin/bash agentctl`. Arrange the provider's approved SSH access for that account with the user; do not copy private keys. Ensure an administrator can run the service registration commands later. Connect as that account or, with permission, use `sudo -iu agentctl` from an administrator account.

**Verify:** `id -un` must show the dedicated account, not `root`. **On failure:** Resolve SSH authentication or sudo access with the provider/user; do not proceed as root or weaken SSH security.

## 3. Install prerequisites

**Ask:** May I install missing tools? Ask separately before `sudo`. On Ubuntu, for missing Git or tmux:

```bash
sudo apt-get update
sudo apt-get install git tmux
```

As the non-root account, the installer suggests these official installation commands for missing Claude Code and Bun:

```bash
curl -fsSL https://claude.ai/install.sh | bash
curl -fsSL https://bun.sh/install | bash
```

**Verify:** Run `claude --version`, `bun --version`, `tmux -V`, and `git --version`. The installer requires Claude 2.1.0+ and Bun 1.3.9+; the README recommends Claude 2.1.80+ and the Linux guide Bun 1.3.14+. **On failure:** Read the error, open a fresh shell if PATH changed, and follow the installer's hints; stop if prerequisites remain unavailable.

## 4. Put the plugin on the server

**Ask:** Do you have the repository link or an archive? With Git, as the service user:

```bash
mkdir -p "$HOME/.claude-lab/myagent/.claude"
cd "$HOME/.claude-lab/myagent/.claude"
git clone https://github.com/qwwiwi/dashi-plugin-claude-code.git
cd dashi-plugin-claude-code
```

For an archive, ask the user to upload it using their provider's file-transfer tool or `scp` from their machine. Ask for its server path, inspect its file list first, and unpack only trusted files into the workspace above. For a trusted `.tar.gz` that contains one repository directory, the user can upload it from their own machine with `scp -P PORT /path/to/plugin.tar.gz USER@SERVER:~/plugin.tar.gz`. On the server, inspect `tar -tzf "$HOME/plugin.tar.gz"`, then run `tar -xzf "$HOME/plugin.tar.gz" -C "$HOME/.claude-lab/myagent/.claude"` and enter the extracted repository root. Confirm the listed paths stay inside the target directory and do not overwrite existing files. An archive without Git history cannot use `update.sh`; later use a clean Git clone and migrate with the user.

**Verify:** `test -f install.sh && test -f update.sh && test -d plugin` succeeds in the repository root. **On failure:** Check the upload, archive layout or clone error; do not continue with a partial checkout.

## 5. Sign in to Claude

**Ask:** Does the user have a Claude subscription eligible for Claude Code? The user runs `claude` themselves in their private SSH terminal as the service account and completes subscription OAuth in their browser. They must not share passwords, authorization codes or login links with the agent. Exit Claude after login.

**Verify:** Ask the user to confirm the login succeeded; do not inspect credential files. **On failure:** Have them follow the CLI's login instructions or their provider's support, then retry privately.

## 6. Create the Telegram bot

**Ask:** Have the user create a bot via [@BotFather](https://t.me/BotFather), keep the token private, and obtain their numeric Telegram user ID from [@userinfobot](https://t.me/userinfobot). Ask for the numeric ID and bot username only. The user will type the token into the installer's hidden prompt in their own terminal, never in agent chat or a recorded session.

**Command:** None. **Verify:** The ID is a positive integer; the user has the bot username and token. **On failure:** Repeat the BotFather or ID bot steps. If a token was exposed, have the user revoke and replace it through BotFather privately.

## 7. Install, start and test

**Ask:** Confirm the autonomous-permissions warning above, the agent name `myagent`, the absolute workspace path, and permission for service registration via sudo. The workspace example is `/home/USERNAME/.claude-lab/myagent/.claude`, with the actual account name substituted. Have the user run the following in their private interactive SSH terminal from the repository root:

```bash
./install.sh
```

They enter `myagent`, the absolute workspace path, their numeric Telegram ID, and finally the token at the hidden prompt. Do not use a token flag, environment assignment, chat, or a terminal recorder. The installer runs doctor and prints the exact Linux registration commands. After the user approves each sudo action, have them run those printed commands, then start the service from the separate SSH terminal:

```bash
sudo systemctl start channel-myagent.service
sudo systemctl status channel-myagent.service --no-pager -l
```

**Verify:** From the repository root run `bun skills/doctor-dashi-plugin/scripts/doctor.ts`; review the summary without sharing secrets. The user sends a direct test message to their bot and confirms a response. **On failure:** Follow doctor failures and check the service status and logs below; Claude may need a first-run prompt completed in `tmux attach -t channel-myagent` (detach with Ctrl-b then d). Do not paste terminal contents containing secrets. If installation fails, resolve the stated error and retry privately; existing config and env are preserved on rerun, so a new token will not automatically replace an existing one.

## 8. Maintain and stop

**Ask:** Does the user want an update or to stop the service? Updates require a clean Git clone and network access. `update.sh` backs up configuration, pulls, installs dependencies, runs tests and prints a restart command. Its failure rollback runs `git reset --hard`, a destructive command: under this guide's safety rule, you must not run the updater yourself. Tell the user this before they independently decide whether to run `./update.sh` from the repository root in a separate SSH terminal. For multiple installations use the installer's printed `--state-dir` command. After a successful update, the user can approve and run the printed restart command externally, then send another test message.

For stopping, ask before sudo and run from SSH:

```bash
sudo systemctl stop channel-myagent.service
sudo systemctl status channel-myagent.service --no-pager -l
```

**Verify:** Status shows inactive after stopping. Stopping does not disable boot startup. Logs are in the system journal: `journalctl -u channel-myagent.service -n 200 --no-pager`; access may require user-approved sudo. Logs may contain sensitive data. **On failure:** Check the service name and sanitized status/doctor output; do not share secrets. A failed update may have rolled back; inspect its sanitized output before deciding what to do next.
