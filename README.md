# TtySage

**An interactive terminal layer that lets AI coding agents use interactive CLIs the way a careful developer would.**

Agents can run shell commands, but many tools stop and ask something: `drizzle-kit push`, `prisma migrate dev`,
`terraform apply`, `npm init`, `git rebase -i`, `npm create vite`, `ssh`, `sudo`, and so on. TtySage runs the command in a
real PTY, renders the screen with a terminal emulator, works out what is being asked, and then decides:

* **AUTO**: low risk, high confidence, and an answer it doesn't have to invent (the program's default, or the option the
  agent's intent names). TtySage answers.
* **ASK_HUMAN**: anything with consequences (data loss, deletion, infrastructure, credentials, deployment...), anything
  uncertain, and anything that looks like prompt injection. The process stays alive and the human decides; the answer
  is sent as keystrokes to the same PTY.
* **DENY**: a human is needed but none is available. TtySage sends Ctrl+C rather than guess.

No config files and no per-CLI adapters. TtySage works from screen structure (cursor, alignment, glyphs, styles, the
alternate screen) and generic consequence language.

```
╭─ TtySage ──────────────────────────────────────────────────────────────────────────────╮
│ ⚠ Human approval required   risk: CRITICAL                                             │
│ Command: npx drizzle-kit push                                                          │
│ Agent intent: Add an email column to users                                             │
│ The program asks:                                                                      │
│   Do you still want to push changes?                                                   │
│ What the program said: (untrusted program output)                                      │
│   • · You're about to delete legacy_email column in users table with 3 items           │
│   • THIS ACTION WILL CAUSE DATA LOSS AND CANNOT BE REVERTED                            │
│ Why TtySage stopped:                                                                   │
│   CRITICAL risk. The prompt implies destructive effects the agent intent did not ask   │
│   for. Risk signals: data-loss ("DATA LOSS"), deletion ("remove"). Destructive         │
│   operations are never auto-approved.                                                  │
│ ❯ No, abort  (program default)                                                         │
│   Yes, I want to remove 1 column  ⚠                                                    │
│   Take over — answer in the terminal myself                                            │
│   Cancel the command (Ctrl+C)                                                          │
╰────────────────────────────────────────────────────────────────────────────────────────╯
```
*(Captured from a real `npx drizzle-kit push` run, trimmed.)*

## Quick setup: let Claude Code use interactive CLIs

Requires Node ≥ 20, pnpm, and [Claude Code](https://claude.com/claude-code).

**1. Install**

```bash
git clone https://github.com/masihmoloodian/ttysage.git ~/ttysage
cd ~/ttysage && pnpm install && pnpm build
cd apps/cli && npm link            # puts `ttysage` on your PATH
```

**2. Connect it to Claude Code**

```bash
claude mcp add ttysage -- node ~/ttysage/apps/mcp/dist/main.js
```

Optionally, add this to your project's `CLAUDE.md` so Claude reaches for it on its own:

```markdown
For commands that may prompt interactively (migrations, scaffolders, deploys, `terraform apply`,
`git rebase -i`, logins), run them with the ttysage `interactive_shell` tool instead of Bash.
Never try to approve prompts that TtySage marks `awaiting_human`; ask me to run `ttysage approvals`.
```

**3. Use it**

Ask Claude Code something like:

> Run `npm init` in ./demo with ttysage. Use "my demo" as the description.

TtySage accepts the safe defaults, and Claude types the fields only it can know. Then try a risky one:

> Run `npx drizzle-kit push` with ttysage.

When TtySage reaches a prompt that could lose data, Claude **can't** answer it. You decide, either in Claude Code's
approval popup or in a second terminal:

```bash
ttysage approvals
```

Pick an answer with ↑/↓ and Enter. TtySage types it into the same running process, and Claude carries on.

**Without Claude Code**, use the CLI directly in your own terminal:

```bash
ttysage run "npm init"
```

```bash
cd examples/drizzle && npm install && node reset.mjs && ttysage run "npx drizzle-kit push"
```

`ttysage audit` shows what was asked, what was decided, and who answered.

### CLI

```
ttysage run [--intent "<what the agent wants>"] [--no-auto] [--cwd DIR] [--llm] [--json] "<command>"
ttysage approvals                 # approve/reject requests from MCP / non-TTY runs (interactive)
ttysage approve <id> --choice N | --text T | --reject
ttysage audit [--limit N] [--json]
ttysage mcp                       # MCP server on stdio
```

* **In a real terminal**, output passes straight through and you can always type. Ordinary input (names, free text,
  editors, TUIs) is left to you. Approvals open in a dialog on the alternate screen, so the program's own screen isn't
  disturbed. The original exit code is returned.
* **Without a TTY** (for example an agent's Bash tool or CI), TtySage prints the *rendered* screen as plain text with one
  `[ttysage]` line per prompt. Approvals queue up for a human to handle with `ttysage approvals` in another terminal;
  `--approval-timeout 0` denies them instead.

### MCP (first agent integration)

```bash
claude mcp add ttysage -- node /path/to/tty-sage/apps/mcp/dist/main.js
```

| Tool | Purpose |
|---|---|
| `interactive_shell {command, cwd?, intent?, waitMs?}` | Start a command and wait until it completes or needs attention |
| `interactive_respond {sessionId, action}` | Answer a `needs_input` prompt with a validated action |
| `interactive_status {sessionId, waitMs?}` | Wait for progress, including while a human decides |
| `interactive_screen {sessionId}` | Current rendered screen |
| `interactive_cancel {sessionId}` | Ctrl+C, then terminate |

Status values are `completed`, `running`, `needs_input` (the agent may answer), `awaiting_human` (the agent **cannot**
answer; TtySage uses MCP elicitation if the client supports it, otherwise the `ttysage approvals` queue), and `blocked`
(a secret is required; agents never type secrets).

Actions form a closed set: `ACCEPT_DEFAULT`, `SELECT_OPTION`, `SELECT_OPTIONS`, `CONFIRM`, `TEXT`, `KEYS` (allowlisted key
names only), and `CANCEL`. The executor checks every action against the current screen before sending keys. For example,
it moves one arrow key at a time, re-reads the screen, and only presses Enter on the option it has confirmed is selected.

### Approval modes (who may answer risky prompts)

By default you approve every risky prompt. If you want the agent to work without stopping, choose a mode when you
add the server. This works like Claude Code's own permission modes.

| Mode | The agent may answer | Still waits for you |
|---|---|---|
| `human` (default) | ordinary input only | every risky prompt |
| `ask-user` | only what you pick: when your client shows no approval dialog (e.g. Claude Code in bypass-permissions mode declines it unseen), the agent asks you in its own UI and relays your exact choice | every risky prompt, decided by you in the agent's UI |
| `agent-high` | HIGH-risk prompts (schema changes, deploys, new SSH host keys…) | CRITICAL prompts (data loss, destroy, irreversible) and prompt-injection attempts |
| `bypass` | everything | nothing, except passwords and secrets, which an agent can never type |

```bash
claude mcp add ttysage -e TTYSAGE_APPROVAL_MODE=agent-high -- node ~/ttysage/apps/mcp/dist/main.js
```

- **Only you can set it.** The mode is read from the server's start-up environment. No tool call can change it, and a
  misspelled value falls back to `human`.
- **The agent knows.** Delegated prompts arrive as `needs_input` with `pending.delegatedApproval: true`, and every tool
  result shows `approvalMode`.
- **It's recorded.** Each answer the agent gives is logged in `ttysage audit` with `resolvedBy: agent`, the mode, and
  the risk level.
- **`ask-user` relies on the agent.** TtySage can't check that the agent really asked you, so use it with agents you
  trust. With `human`, TtySage asks you itself.
- **Silent clients.** If a client "declines" TtySage's dialog instantly (in under 1.5 s), TtySage assumes no dialog was
  shown, falls back to `ttysage approvals` (or, in `ask-user`, to the agent), and stops using that client's dialog.
- **TtySage still never guesses.** The modes only change *who* may answer. TtySage's own automatic answers stay limited
  to low-risk defaults.

Use `bypass` only in disposable environments (containers, scratch databases, CI sandboxes), as you would Claude Code's
bypass mode.

## How it works

```
PTY (node-pty) → headless xterm (@xterm/headless) → screen snapshot
  → detector (interactive? which input mode? confidence)    — pure, structural, no CLI names
  → prompt-understanding (question, options, default, context since last answer)
  → decision-engine (deterministic risk floor + optional LLM that can only add caution)
  → AUTO | ASK_HUMAN | DENY → validated executor → keys into the same PTY → audit (JSONL, redacted)
```

Details, the full safety boundary, and the risk analysis are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

**Safety in one paragraph.** Automatic answers need *all* of these: confident detection (≥ 0.85); a confirmation, selection,
or text mode; no risk signal anywhere in the command, the question, the options, or the output since the last answer; no
injection markers; an answer that is the program's default or named by the agent's intent; no recent human keystrokes;
and, if an LLM is configured, its agreement. Passwords are never typed by automation. Terminal output is treated as
untrusted throughout: when it is passed to an LLM it goes in a delimited data block, and it never changes the policy.

One narrow exception: when a risky question offers exactly one answer that explicitly *declines* the danger (e.g.
"No, add the constraint **without truncating** the table"), TtySage may pick that answer, but only if your intent
forbids the action or it is the program's own default. An answer that *performs* a destructive action is never picked
automatically. Full rules: [docs/ARCHITECTURE.md §3](docs/ARCHITECTURE.md).

**Optional LLM.** `--llm` (or `TTYSAGE_LLM=claude`) adds a Claude second opinion through your local `claude` CLI login,
so no API key is needed. `TTYSAGE_LLM=anthropic` uses the API SDK instead. The default model is `claude-opus-5-5`
(`TTYSAGE_LLM_MODEL`). It is called at most once per prompt, and only when it can help: to confirm an automatic answer, to map
an intent onto an option, or to explain consequences to the human. It can veto or raise risk but can never approve
something the deterministic layer flagged. If it fails, TtySage asks a human. It is off by default, so terminal content
never leaves the machine unless you enable it.

## Results

| | |
|---|---|
| Unit + integration tests (real PTYs; inquirer, prompts, clack, enquirer, bash `select`, a hand-rolled raw-mode CLI) | `pnpm test` |
| Real tools: Terraform, Drizzle, Prisma, npm init, git rebase -i, git add -p, npm create vite, ssh, aws configure, sudo | `pnpm test:real` |
| Benchmark: 78 scenarios + 18 held-out, plus an adversarial-LLM run | `pnpm bench` → [docs/BENCHMARK.md](docs/BENCHMARK.md) |

Benchmark: **0 unsafe auto-answers** in every run: deterministic, with an adversarial "always approve" LLM, with real Claude
(Opus 5.5 via `claude -p`, $1.11 for 96 scenarios), and on the held-out set after one fix. The held-out set's first run, before any fix, had 1 unsafe auto-answer out of 18; it is reported verbatim
in the benchmark doc. The main set was used during development, so its 100% accuracy figures are optimistic. The
held-out numbers are the fairer estimate.

## Layout

```
apps/cli            ttysage CLI                     apps/mcp           MCP server (adapter over a transport-agnostic manager)
packages/pty        node-pty wrapper, key allowlist packages/terminal  headless xterm screen model
packages/detector   interactive-state detection     packages/prompt-understanding  PromptModel + LLM interpreter
packages/safety     risk lexicon, injection, redaction
packages/decision-engine  policy + action schema    packages/approval  TTY dialog + approval queue
packages/audit      JSONL audit log                 packages/core      Session orchestrator + executor
tests/              terminal, prompts, decisions, integration, real-tools, benchmark
examples/           drizzle, prisma, terraform demo projects
```

Audit logs are written to `~/.ttysage/audit/audit-YYYY-MM-DD.jsonl` (mode 0600, secrets redacted). `TTYSAGE_HOME`
changes the location and `TTYSAGE_AUDIT=off` disables logging.

## Known limitations (MVP)

* Detecting "waiting for input" is heuristic (output quiescence plus screen structure); low-confidence states are never
  answered automatically, only reported.
* The risk lexicon is English and errs on the side of asking. Negations ("no data will be lost") still count; only explicit
  zero counts ("0 to destroy") are ignored.
* While a TUI or editor uses the alternate screen, a TTY user drives it directly (no overlay dialog). Over MCP the agent
  drives it with validated keys.
* Password prompts over MCP are `blocked`; the user has to run the command in their own terminal.
* Tested on macOS (node-pty prebuilds); Linux needs a node-pty build toolchain. Windows (ConPTY) is untested.
* The LLM second opinion roughly halves automation on the main set (20.5% → 12.8% auto-answers) and adds about 6 s per
  consulted prompt. It is a caution layer, not a speed-up.

## License

MIT — see [LICENSE](LICENSE). © 2026 Masih Moloodian (masihmoloodian@gmail.com).

Questions or feedback: open an issue or email masihmoloodian@gmail.com.
