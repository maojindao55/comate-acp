# comate-acp

Agent Client Protocol (ACP) adapter that exposes the Baidu Comate (Zulu) CLI as
an ACP agent, so any ACP client — Zed, `ab ACP`, or FreeBuddy — can drive it.

```bash
npm install -g comate-acp @comate/comatecli
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

**Images.** ACP sends `{ type: "image", mimeType, data }` base64 blocks with no
path, while comatecli only takes `--attach-image <path>`. Blocks are written to a
content-addressed cache under `~/.comate-acp/attachments/`, so the same image
sent again on a later turn reuses one file.

**The exit code is the only trustworthy turn terminator.** `comatecli` emits
`conversation-status: Completed` even when the turn is merely parked on a pending
approval, and `event-stream` deliberately writes no final frame. So the adapter
waits for process close and maps `75 → needs permission`, `0 → end_turn`,
anything else → error (with the stderr tail attached).

**Suspend arrives twice.** The first `requires_action` frame is a conversation
snapshot with no `toolId`; the second carries it. The adapter merges them and
waits for process close before requesting permission and starting a resume.
If the richer frame never comes, `comatecli pending --json` fills in the details.

**Dedupe bookkeeping spans every approval restart of one prompt.**
`event-stream` is not a pure delta feed — `conversation-messages` and
`partial-message-data` repeat full
snapshots. Each parser keeps how much of every element was already forwarded and
only emits the suffix. Comate temporarily marks the current assistant message
`success` or `cancelled` while waiting for approval, then appends to that same
message on resume, so these statuses must not discard subsequent content.
Each new user prompt starts fresh bookkeeping and suppresses loaded history,
including after an ACP reconnect and when older pages expand in later snapshots.
The prompt's user message remains the history boundary across approval restarts,
so historical text never contributes to the output-token estimate. `tokenUsage` is likewise only
reported when it changes. Command status follows the result's execution state;
waiting for approval is pending, and output updates are forwarded even when
the status stays the same.

**`~/.comate/bin/comate` is not the CLI.** It is the Comate IDE (VS Code fork)
launcher script, and it exits 0 silently when handed CLI arguments — which would
look like an empty successful turn. The resolver therefore only probes
`comatecli`.

**comatecli ships as a native binary or a JS launcher.** A `.mjs` launcher has
to be spawned through the current Node binary; `spawnComate` handles both.

**Client MCP servers.** `session/new` and `session/load` accept stdio, HTTP and
SSE MCP servers from the ACP host, including FreeBuddy's browser, skills and
user-selected servers. Each CLI invocation receives a private snapshot of
`.comate/mcp.local.json`, merged with the workspace's existing JSONC settings.
The snapshot takes priority for injected server names. A Node preload redirects
only configuration reads in that CLI process and its workers; it never writes
to workspace or global MCP files. Concurrent sessions have separate snapshots,
which are removed when their CLI process closes. MCP endpoints and credentials
are not stored in `sessions.json`; loading a session replaces the previous host
server list, including when the new list is empty.

Comate 2.0 emits legacy `pending-approvals` for MCP calls without suspending
the CLI. The adapter forwards these to ACP permission requests, then uses
Comate's JSON stdin router to approve or reject the tool in the running process.
This router requires `ZULU_MOBILE_MODE=1` for injected turns; Comate labels these
native history entries as `Mobile`. Command approvals continue to use the
existing suspend/resume protocol.

Client MCP injection requires the **npm Node.js distribution** of Comate
(`npm install -g @comate/comatecli`). Native standalone binaries cannot load the
Node preload and return an explicit error when client MCP servers are supplied.
If needed, set `COMATE_ACP_CMD` to the npm package's `bin/zulu-tui.mjs` launcher.

On Windows, the adapter resolves npm's `comatecli.cmd`, PowerShell and shell
shims to the package's declared Node.js entry. It runs that entry directly with
Node for model discovery, login and prompts, including MCP injection. The npm
user prefix (`%APPDATA%\npm`) is also searched when the desktop PATH is stale;
`COMATE_ACP_CMD` remains available for custom installations.

## Layout

- `src/index.ts` — ACP methods, event → `session/update` mapping, turn lifecycle
- `src/comateArgs.ts` — ACP session state → `comatecli run` argv
- `src/eventParser.ts` — snapshot/delta reducer with dedupe
- `src/attachments.ts` — materialises ACP image blocks for `--attach-image`
- `src/pending.ts` — reads parked interactions for permission prompts
- `src/comateExecutable.ts` — resolves the `comatecli` binary
- `src/sessionStore.ts` — persists ACP session → conversation id
- `src/spawn.ts` — binary-vs-JS-launcher spawn helper
- `src/mcp.ts`, `src/mcpPreload.cts` — session MCP configuration and process-scoped reads
- `src/liveApproval.ts` — ACP decisions for Comate's live MCP approval channel

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

## Release

Pushing a `v*` tag triggers `.github/workflows/publish.yml`: GitHub Release →
`npm ci && npm run build && npm publish --access public` → npmmirror sync. The
`NPM_TOKEN` secret must be set on the repository.

For a one-shot local release (typecheck → test → build → version bump → commit
and tag → optional push → optional publish → npmmirror sync):

```bash
npm run release          # 交互式选择 patch/minor/major/自定义
npm run release:patch
```
