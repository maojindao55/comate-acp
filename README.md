# comate-acp

Agent Client Protocol (ACP) adapter that exposes the Baidu Comate (Zulu) CLI as
an ACP agent, so any ACP client — Zed, `ab ACP`, or FreeBuddy — can drive it.

```bash
npm install -g comate-acp
comate-acp            # serves ACP over stdio
comate-acp --login    # hands the terminal to `comatecli login`
comate-acp --version
```

## Why this exists

`comatecli` has no ACP mode. It does have a headless mode:

```bash
comatecli run -q "prompt" --cwd /repo -d event-stream
```

This package translates that event stream into ACP, and translates ACP
permission requests back into `comatecli pending` / `--approve` / `--reject`.

## Headless contract (all verified against comatecli 2.0.0)

| need | flag |
| --- | --- |
| headless one-shot prompt | `run -q <prompt> --cwd <dir>` |
| machine-readable stream | `-d event-stream` |
| continue a conversation | `-c <conversationId>` |
| work mode | `--mode Agent｜Plan｜Goal` |
| model / reasoning effort | `-m <model>`, `--effort <level>` |
| let the client decide permissions | `--disable-auto-approve` |
| observable suspend | `--on-requires-action suspend --requires-action-exit-code 75` |
| resume a parked tool | `run -c <id> --approve｜--reject --resume-tool-result <json>` |
| read the parked tool | `pending --json <conversationId>` |

## Design decisions

**The exit code is the only trustworthy turn terminator.** `comatecli` emits
`conversation-status: Completed` even when the turn is merely parked on a pending
approval, and `event-stream` deliberately writes no final frame. So the adapter
waits for process close and maps `75 → needs permission`, `0 → end_turn`,
anything else → error (with the stderr tail attached).

**Suspend arrives twice.** The first `requires_action` frame is a conversation
snapshot with no `toolId`; the second carries it. The adapter merges them and
only stops early once it can name the tool. If the richer frame never comes, the
exit code closes the turn and `comatecli pending --json` fills in the details.

**Dedupe bookkeeping outlives a single turn.** `event-stream` is not a pure
delta feed — `conversation-messages` and `partial-message-data` repeat full
snapshots. Each parser keeps how much of every element was already forwarded and
only emits the suffix; that state is shared across turns of one session, so a
resumed conversation does not re-send what the client already has. `tokenUsage`
is likewise only reported when it changes.

**`~/.comate/bin/comate` is not the CLI.** It is the Comate IDE (VS Code fork)
launcher script, and it exits 0 silently when handed CLI arguments — which would
look like an empty successful turn. The resolver therefore only probes
`comatecli`.

**comatecli ships as a native binary or a JS launcher.** A `.mjs` launcher has
to be spawned through the current Node binary; `spawnComate` handles both.

## Layout

- `src/index.ts` — ACP methods, event → `session/update` mapping, turn lifecycle
- `src/comateArgs.ts` — ACP session state → `comatecli run` argv
- `src/eventParser.ts` — snapshot/delta reducer with dedupe
- `src/pending.ts` — reads parked interactions for permission prompts
- `src/comateExecutable.ts` — resolves the `comatecli` binary
- `src/sessionStore.ts` — persists ACP session → conversation id
- `src/spawn.ts` — binary-vs-JS-launcher spawn helper

## Testing

```bash
npm test
```

Unit tests run the parser against captured real `event-stream` fixtures. The
e2e test drives the built adapter over stdio with a stub CLI. For a manual run
against the real thing:

```bash
node test/client.mjs "your prompt"
```