# TtySage Architecture

## 1. Starting point (inspection, 2026-10-08)

* Repository: empty — greenfield.
* Runtime: Node 22.19, pnpm 9.12, macOS arm64. `terraform`, `git`, `vim`, `nano` installed.
* Libraries chosen (verified current on npm):

| Concern | Choice | Why |
|---|---|---|
| PTY | `node-pty@1.1.0` | The maintained PTY binding (used by VS Code). Ships prebuilds for darwin/win32; Linux builds via node-gyp. |
| Terminal emulator | `@xterm/headless@6.0.0` | xterm.js core without DOM: full VT parser, alternate buffer, cursor, scrollback, cell attributes, modes (`applicationCursorKeysMode`). Same emulator VS Code uses, so behaviour matches what humans see. |
| MCP | `@modelcontextprotocol/sdk@1.32` | Official SDK; `McpServer` + stdio transport; supports elicitation (server → client → human). |
| Validation | `zod@4` | Validates LLM output, MCP inputs, executor actions. |
| LLM (optional) | `@anthropic-ai/sdk` with `messages.parse` + `zodOutputFormat` | Structured output; loaded lazily, only when `TTYSAGE_LLM=anthropic`. |
| Tests | `vitest@5` | |
| Build | `tsup@8` (bundles workspace packages into the two apps) | |
| Types | `typescript@7` (native `tsc`), `strict` | |

Known library risk discovered during the spike: under pnpm, node-pty's prebuilt
`spawn-helper` loses its exec bit → `posix_spawnp failed`. `@ttysage/pty` repairs it
at runtime (`ensureSpawnHelperExecutable`).

## 2. Pipeline

```
 PTY bytes ──► HeadlessTerminal (xterm) ──► ScreenSnapshot (rows, styles, cursor, alt-screen, modes)
                                                 │  (only after output quiescence; never per frame)
                                                 ▼
                                   detector: Detection {interactive, confidence, inputMode, candidate}
                                                 ▼
                       prompt-understanding: PromptModel {type, question, options, default, context}
                                                 ▼
                 decision-engine (+ safety lexicon, injection scan, optional LLM veto/explainer)
                                                 ▼
                    Decision {AUTO | ASK_HUMAN | DENY, kind, risk, confidence, reason, action}
                    │                         │
            AUTO: executor             ASK_HUMAN: HumanChannel (TTY dialog / MCP agent /
            (validated, verified        MCP elicitation / file approval queue)
             key sequences)                   │
                    └──────────► executor ◄───┘ ──► keys into the SAME PTY
                                                 ▼
                                             audit (JSONL, redacted)
```

Package map (`packages/*`, each exports `src/index.ts`):

* `pty` — node-pty wrapper, key allowlist (`KEYS`), signal/exit-code mapping.
* `terminal` — xterm headless wrapper; `snapshot()`, scrollback text, cursor visibility (DECTCEM tracking).
* `detector` — pure function `detect(snapshot, timing)`; finds arrow lists, checkbox lists,
  highlight-only lists, inline radios, numbered menus, `(y/N)` prompts, text/password fields,
  editors and TUIs. No CLI names anywhere.
* `prompt-understanding` — `understand()` → `PromptModel`; `SemanticInterpreter` interface
  (`NullInterpreter`, `AnthropicInterpreter`).
* `safety` — risk lexicon (generic consequence vocabulary), prompt-injection scan, secret redaction,
  action schema + `validateAction()`.
* `decision-engine` — the policy. Deterministic floor first, LLM second (can only make things safer).
* `approval` — TTY approval dialog (alternate screen, so the child's screen is untouched) and a
  file-based approval queue (for MCP / non-TTY callers).
* `audit` — JSONL logger with deep redaction.
* `core` — `Session` orchestrator + executor (navigation with screen verification).
* `apps/cli` — `ttysage run|approvals|approve|audit|mcp`.
* `apps/mcp` — MCP server (adapter only).

## 3. The auto-answer safety boundary (resolved)

TtySage sends keys **without a human** only when *every* condition holds:

1. Detection is `interactive: true` with confidence ≥ 0.85 (uncertain ⇒ never AUTO).
2. Input mode is `confirmation`, `selection`, or `text`. Never `password`, `multiline`, `editor`, `tui`, `unknown`.
3. Deterministic risk is **LOW**: no risk signal in command, question, options, or the
   output since the last interaction; no prompt-injection markers.
4. The answer is one TtySage does not have to *invent*:
   * the program's own default (Enter) for a confirmation / text prompt that shows a default, or
   * for a preference selection, an option that the agent's stated intent names uniquely.
   A confirmation with no default, a text field with no default, or a preference choice with no
   intent ⇒ not AUTO ("never guess").
5. The prompt was not already auto-answered at the same position (a re-asked prompt means the
   answer did not take effect ⇒ escalate).
6. The human has not typed into the terminal in the last 2 s (the human is driving).
7. If an LLM is configured it must independently agree (risk LOW, confidence ≥ 0.8, same action).
   The LLM can veto or raise risk, never lower it and never create an AUTO by itself.
8. The executor validates the action against the current screen state and verifies navigation
   (re-reads the screen after arrow keys) before pressing Enter.

Everything else is ASK_HUMAN with a `kind`:

* `approval` — risk ≥ MEDIUM confirmation/selection, or anything HIGH/CRITICAL. Only a human can answer.
  In MCP the agent **cannot** answer these; they go to MCP elicitation or the local approval queue.
* `input` — the program needs information (a name, a free-text field, an editor) and risk < HIGH.
  In a TTY the human just types (no dialog); in MCP the calling agent may answer with validated actions.

DENY: a human is required but no human channel exists (non-TTY with approval timeout, or the
human cancelled) ⇒ TtySage sends Ctrl+C instead of guessing. Password prompts are never answered by an
agent or LLM.

Terminal output is untrusted. It is scanned for injection markers (which raise risk), passed to an LLM
only inside a clearly delimited, redacted data block, and can never influence the policy table above.

## 4. Biggest technical risks

1. **"Is it waiting for input?"** has no OS-level answer on macOS/Linux without ptrace. Mitigation:
   quiescence + screen stability + structural evidence + mode-specific minimum idle times;
   low-confidence ⇒ uncertain ⇒ never auto.
2. **Heuristic prompt extraction across rendering libraries** (inquirer, prompts, clack, enquirer,
   readline, raw). Mitigation: structure-based detection (pointer glyph + sibling column alignment,
   style runs for highlight-only lists, bottom-anchoring) plus a 50+ scenario benchmark and real-library
   fixtures.
3. **Navigation correctness** (wrapping lists, scrolling lists). Mitigation: step one key at a time and
   re-read the screen; abort to human if the target is not reached.
4. **Repaint conflicts** between the approval UI and the child's own rendering. Mitigation: dialog
   in the alternate screen buffer; child TUIs that are already in the alternate screen are handed to
   the human directly (no overlay).
5. **False-negative risk classification** (missing a destructive consequence). Mitigation: broad
   generic lexicon over all context since the last interaction, defaults to ASK whenever any signal
   exists; zero-unsafe-auto gate in the benchmark.
6. node-pty native packaging (seen: exec bit). Mitigation: runtime self-repair, prebuilds.

## 5. Phase 1 acceptance tests (PTY)

`tests/integration/pty.test.ts` must pass:

* P1.1 `ttysage run "<cmd>"` spawns through `$SHELL -c` in a real PTY: child sees `isatty(0/1) == true`.
* P1.2 Dimensions propagate (`stty size` == configured rows/cols) and `resize()` updates them.
* P1.3 Interactive input round-trips: a `read` prompt receives typed text + Enter.
* P1.4 Allowlisted keys produce the right byte sequences (arrows normal & application mode, Ctrl+C/D, Esc, Tab, Backspace).
* P1.5 Ctrl+C reaches the foreground process (SIGINT) and the exit code is mapped (130).
* P1.6 Exit codes pass through (`exit 7` ⇒ 7).
* P1.7 No zombies: `kill()` terminates the process group; the session resolves.
* Manual: `ttysage run "npm init"` in a real terminal behaves exactly like `npm init`.

## 6. Phase log (2026-10-08)

| Phase | Result | Evidence |
|---|---|---|
| 1 PTY | real PTY, resize, keys, signals, exit codes, no orphans | `tests/integration/pty.test.ts` (P1.1–P1.7) |
| 2 Terminal state | xterm headless snapshot: rows, styles, cursor, DECTCEM, alt screen, scrollback | `tests/terminal` |
| 3–4 Detection + extraction | lists (pointer, radio, checkbox, highlight-only), inline choices, numbered, y/n, text, password, multiline, editor, TUI, shell | `tests/prompts`, benchmark |
| 5 Decision | AUTO / ASK_HUMAN / DENY; LLM can only add caution; injection scan | `tests/decisions` |
| 6 Human takeover | alt-screen dialog over the same PTY; takeover; approval queue | `tests/integration/cli-tty.test.ts` |
| 7 Audit | JSONL, 0600, deep-redacted, session start/interaction/end | cli-tty + definition-of-success test |
| 8 MCP | 5 tools; needs_input vs awaiting_human; elicitation → queue fallback | `tests/integration/mcp.test.ts` |
| 9 Benchmark | 78 + 18 held-out scenarios, adversarial-LLM run, 0 unsafe | `docs/BENCHMARK.md` |

Bugs found by running real tools (all fixed, with regression tests):
* `prompts`-style confirms submit on the keypress itself; a trailing Enter silently answered the *next* prompt.
  The executor now re-reads the screen and only presses Enter when the same prompt instance is still waiting.
* Answered-prompt markers (`✔`) were treated as checkboxes; stale lists above a new input line were re-detected.
* Editor buffers (git's rebase help comments) drove risk; editors are now judged by their command.
* "0 to destroy" was read as destruction; explicit zero counts are ignored (other negations still count).
