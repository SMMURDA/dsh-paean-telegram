# DSH Paean Telegram

A native **Telegram bridge for DeepSeek Harness (DSH)**. It lets you talk to your Harness
agent, and drive the whole harness, from your phone: send a message and the agent answers in
the chat; everything else — sessions, models, workspaces, goals, skills, plugins, host files —
is one tap away on a persistent button bar.

There is **no server to run**: the plugin mounts inside the Harness Host process and talks to
the Telegram Bot API directly over long polling.

| | |
|---|---|
| Package name | `dsh-telegram` (kept unchanged: profile installs reference it) |
| Version | `0.4.0` |
| Requires | Node.js >= 22, a DSH profile (tested on Harness `0.1.0-rc.21` with `@deepseek-ai/*` `0.2.1-alpha.1`) |
| Runtime dependency | `grammy` |
| License | MIT (see [LICENSE](LICENSE)) |

> **This repository is a fork.** It is based on
> [xqicxx/dsh-telegram](https://github.com/xqicxx/dsh-telegram) (MIT) and keeps the original
> license and copyright notice. This build adds **runtime-compatibility work for the dsh 0.2.x
> host APIs** — see [Local changes in this build](#local-changes-in-this-build).

---

## Table of contents

- [What you get](#what-you-get)
- [Quick start](#quick-start)
- [Install into a DSH profile](#install-into-a-dsh-profile)
- [Bot token](#bot-token)
- [Configuration](#configuration)
- [Chat roster (who may talk to the bot)](#chat-roster-who-may-talk-to-the-bot)
- [Commands](#commands)
- [Button bar](#button-bar)
- [Cards](#cards)
- [Agent tools](#agent-tools)
- [Media and attachments](#media-and-attachments)
- [Approvals and questions](#approvals-and-questions)
- [Auto-compaction and long-task notifications](#auto-compaction-and-long-task-notifications)
- [Security model](#security-model)
- [Runtime compatibility](#runtime-compatibility)
- [Development](#development)
- [Troubleshooting](#troubleshooting)
- [Local changes in this build](#local-changes-in-this-build)
- [Credits and license](#credits-and-license)

---

## What you get

- **Chat with the agent**: any text you send becomes a turn for that chat's bound session.
  Streaming reasoning and tool calls appear in one message edited in place.
- **Full harness control from the phone**: sessions (list / resume / fork / rename / archive),
  models and reasoning effort, workspaces and the active project folder, goals, todos, the
  agent inbox queue, skills, subagents, agent presets, installed plugins, credentials
  (descriptions only), host settings, background jobs, host file browsing, session history.
- **Turn receipts and live status**: a one-line receipt after each turn (turns, steps, tool
  calls, tokens, cache-hit rate) and a status card that keeps refreshing while work runs.
- **Agent tools**: the agent can send you messages and files back through the same bridge.

## Quick start

```bash
# 1. get the code
git clone https://github.com/SMMURDA/dsh-paean-telegram.git
cd dsh-paean-telegram

# 2. OPTIONAL rebuild — dist/ is committed, so this is only needed after source edits
npm ci && npm run build

# 3. install it into your DSH profile (see the next section)
# 4. create <workspace>/.pi/telegram.json with your chat id (see Configuration)
# 5. export the bot token, restart the harness, then send /start to your bot
```

## Install into a DSH profile

A DSH **profile** decides which plugins a Harness process loads. Pick either path.

### Path A — `plugin_manager` (recommended)

1. Clone this repository somewhere permanent.
2. Optionally `npm ci && npm run build` (the committed `dist/` already runs).
3. In a DSH session, install the bundle from the **absolute** directory:

   ```
   plugin_manager(action: "install_bundle", target: "/abs/path/to/dsh-paean-telegram")
   ```

   The bundle patch shipped at [cordis.patch.yml](cordis.patch.yml) mounts the plugin:

   ```yaml
   - insert:
       - id: telegram
         name: dsh-telegram
   ```

4. Restart the harness if your profile is a startup profile.

### Path B — manual profile wiring

Used by this deployment, and handy when you want to hack on the source in place.

1. Make the profile depend on the directory (a symlink install, so edits are live after a
   harness restart):

   ```jsonc
   // ~/.dsh/profiles/<profile>/package.json
   {
     "dependencies": {
       "dsh-telegram": "link:/abs/path/to/dsh-paean-telegram"
     }
   }
   ```

   If the harness enforces plugin/runtime version compatibility, it records the allowed pair in
   `~/.dsh/profiles/<profile>/compatibility.json`, for example:

   ```json
   { "dsh-telegram@0.4.0": ["0.2.1-alpha.1"] }
   ```

   **Keep the package version unchanged** when you install this way: the exemption key contains
   the version, and a mismatch can make the harness refuse the plugin at load time.

2. Add the plugin row to the profile patch (`~/.dsh/profiles/<profile>/cordis.patch.yml`):

   ```yaml
   - insert:
       - id: telegram
         name: dsh-telegram
   ```

   If you keep another Telegram bridge around, disable it — two pollers on the same bot token
   fight over `getUpdates`. A disabled row looks like:

   ```yaml
   - id: other-telegram-bridge
     name: "@local/some-other-bridge"
     disabled: true
   ```

3. Restart the harness process so the Host loads the plugin.

## Bot token

Create a bot with [@BotFather](https://t.me/BotFather) and copy its token. The plugin never
writes the token anywhere; it only reads it, in this order:

1. `TELEGRAM_BOT_TOKEN` in the harness process environment.
2. A file named by `TELEGRAM_BOT_TOKEN_FILE`.
3. `.telegram-token` next to the package (git-ignored, `chmod 600`) — handy for local checkouts
   that must survive restarts without shell wiring.

```bash
# environment (for a manually started harness)
export TELEGRAM_BOT_TOKEN='<token from BotFather>'

# or a checkout-local file
printf '%s' '<token from BotFather>' > /abs/path/to/dsh-paean-telegram/.telegram-token
chmod 600 /abs/path/to/dsh-paean-telegram/.telegram-token
```

## Configuration

Configuration lives in **`<workspace>/.pi/telegram.json`** (one file per workspace root). Every
key is optional; missing keys fall back to the defaults below. The file is validated on load and
can be changed live from the chat with `/config get <path>` and `/config set <path> <value>`.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `security.allowedChatIds` | `number[]` | `[]` | Chat-id whitelist for inbound traffic. **Empty means every inbound chat is rejected.** |
| `security.browseRoots` | `string[]` | absent | Optional absolute-path whitelist confining host/workspace browsing (`/ls`, `/mkdir`, `/open`, workspace create). Absent = unconstrained. |
| `security.selfAllow` | `boolean` | enabled (absent) | Kill switch for the self-service bootstrap: the "Allow this chat" button on the unauthorized prompt. `false` makes that tap answer with the refusal text and never touch the roster. |
| `watch.autoStart` | `boolean` | `false` | Start long polling automatically when the plugin mounts. |
| `inbound.defaultMode` | `"auto-handle"` \| `"queue-only"` \| `"muted"` | `"auto-handle"` | How inbound chat text is treated before it reaches the agent. |
| `inbound.rules` | `{chatId?, pattern?, mode}[]` | `[]` | Ordered rules; the first match wins, otherwise `inbound.defaultMode`. `pattern` is a case-insensitive substring. |
| `outbound.parseMode` | `"HTML"` | `"HTML"` | Telegram parse mode for assistant output. Model Markdown is normalized to valid Telegram HTML first; cards are always HTML. |
| `outbound.disableNotification` | `boolean` | `false` | Send silently. |
| `outbound.maxRetries` | `number` | `3` | Per-message retries on 429 / network errors. |
| `outbound.sendRatePerSecond` | `number` | `20` | Global send budget (the Bot API safe bound is 30). |
| `outbound.maxMessageLength` | `number` | `4096` | Hard cap for one payload; longer text is split into parts. |
| `outbound.liveFeed` | `boolean` | `true` | One message edited in place while a turn streams (thinking + tool-call visibility). Can be toggled without a restart. |
| `compact.threshold` | `number` | `0.8` | Compact when the latest request uses more than this fraction of the context window. |
| `compact.policy` | `"auto"` \| `"ask"` \| `"never"` | `"ask"` | Compact automatically, ask first, or stay quiet. |
| `compact.cooldownMs` | `number` | `300000` | Minimum interval between two triggers for one session. |
| `workspace.activePath` | `string` | absent (boot dir) | Active project folder; new sessions are created under it. Set it from the chat with `/project`. |
| `mode.name` | `string` | `""` | Optional display label for the status card. |
| `model.provider` / `model.model` | `string` | profile default | Telegram-owned default model, so the bot can run a different model than the web keeps. |
| `reasoning.effort` | `"minimal"` \| `"low"` \| `"medium"` \| `"high"` \| `"max"` | `medium` | Per-chat reasoning effort; a directive is prepended to inbound messages. |
| `media.transcribe.baseUrl` | `string` | provider default | OpenAI-compatible transcription endpoint for voice notes. |
| `media.transcribe.apiKey` | `string` | absent | Missing key = transcription disabled, with guidance instead of a silent drop. |
| `media.transcribe.model` | `string` | package default | Transcription model name. |
| `interactive.userQuestions` | `"both"` \| `"telegram"` \| `"web"` \| `"auto"` | `"both"` | Which UI owns `ask_user_question` and approval cards. `both` mirrors them to Telegram and the web; whichever side answers first settles the other. |
| `interactive.allowByTool` | `string[]` | `[]` | Tool names permanently auto-allowed after "Allow forever (by tool)". Revoke with `/config set interactive.allowByTool []`. |
| `notify.onComplete` | `boolean` | `true` | Send a fresh receipt (with sound) when a goal turn finishes. |
| `notify.onLongTask` | `boolean` | `true` | Edit the progress card every 30 s so elapsed time keeps moving. |

Minimal working file:

```json
{
  "security": { "allowedChatIds": [123456789] },
  "watch": { "autoStart": true }
}
```

## Chat roster (who may talk to the bot)

The chat-id whitelist is the plugin's only inbound authorization boundary, and **an empty
whitelist rejects everyone**. To bootstrap safely:

1. Put your own chat id in `security.allowedChatIds`. Not sure of the id? Send `/start` to the
   bot — the refusal message names the chat id it saw.
2. Or leave the whitelist empty and press **"Allow this chat"** on that refusal: a one-tap
   bootstrap that appends the chat to the roster (disable it with `security.selfAllow: false`).
3. The `telegram_status` agent tool reports the chats the bridge knows about.

Only whitelisted chats receive cards, commands, or pending interactive input. Everything else
is answered with the refusal text and nothing else.

## Commands

Type `/help` in the chat for this list; `/start` also registers the BotFather command menu.

| Command | Purpose |
|---|---|
| `/start` | Welcome + persistent button bar |
| `/menu` | Core menu card |
| `/new` | Fresh session in the workspace |
| `/compact` | Compact the current session |
| `/abort` | Abort the current turn |
| `/stop` | Close this chat's session |
| `/status` | Live status card |
| `/queue` | Inspect or edit the agent inbox |
| `/todo` | Show the current session todo list |
| `/sessions` | Sessions list (grouped by project) |
| `/history [sessionId] [turns]` | Session trajectory, turn-grouped |
| `/rename <title>` | Rename the current session |
| `/fork [atSeq]` | Fork the current session |
| `/use <sessionId>` | Switch to a session (resumes it when cold) |
| `/archive <sessionId>` | Archive a session |
| `/workspaces`, `/workspacecreate` | Workspaces list / create |
| `/project [path]`, `/pickdir` | Pick the active project folder |
| `/models` | Browse providers and models |
| `/goals`, `/goal <objective> [maxRounds]`, `/goalcreate`, `/goalclear` | Goals |
| `/presets` | Agent presets (select while the session is blank; a mid-session switch forks) |
| `/skills`, `/subagents`, `/plugins`, `/jobs` | Inventories |
| `/hostsettings`, `/settingsreplace`, `/settingsmutate` | Host settings |
| `/credentials` | Credential list (descriptions only, never values) |
| `/host`, `/ls [path]`, `/mkdir <path>`, `/openpath <path>` | Host details and file browsing |
| `/attachment <id>` | Send a saved photo attachment back |
| `/pluginadd` | Install your own dynamic plugin (JSON) |
| `/bar` | Show or hide the button bar |
| `/capabilities` | Profile capability matrix (which seams this profile provides) |
| `/menucheck` | Self-check every menu data source |
| `/answer <id> <text>` | Answer a free-text question by id |
| `/config get\|set <path> [value]` | Read or change bridge config live |
| `/help` | All commands |

Text that is not a command is a normal agent prompt for the bound session.

## Button bar

The bar rides along with the welcome card and every reply, so the phone never needs the command
menu: `☰ Menu`, `✨ New`, `🧹 Compact`, `🧩 Models`, `🔌 Plugins`, `🎭 Mode`, `🧭 Sessions`,
`📊 Status`, `⌛ Queue · N`, `🎯 Goal`, `📋 Todos · N`, `🧠 Reasoning`, `🧠 Thinking`,
`🎭 Presets`, `⏹ Abort`, `⏹ Stop`, plus a collapse/return pair that tucks the bar behind a small
carrier message.

## Cards

Cards are in-place edited messages; `Back`/`Close` and switching cards clean up after themselves.
Available cards: about, allowed-chats, capabilities, credentials, dynamic plugins, feedback list,
goals, history, host, host directory, host settings, jobs, mode, model thinking, models, provider
models, providers, new session, presets, preset detail, plugins, project, queue, search, session
detail, session projects, sessions, settings, settings namespace, skills, subagent detail,
subagents, todos, watch, workspace detail, workspaces.

## Agent tools

The agent gets seven tools through this bridge:

| Tool | Purpose |
|---|---|
| `telegram_send` | Send an HTML message to one known chat |
| `telegram_reply` | Reply to the current inbound message (fails when none is pending) |
| `telegram_broadcast` | Send the same message to several chats |
| `telegram_attach` | Send 1–10 workspace files: images as photos, `.ogg`/`.opus` as voice notes, other audio as audio, everything else as documents |
| `telegram_send_file` | Alias of `telegram_attach` |
| `telegram_status` | Bridge state: bot connectivity, agent status, queue, known chats |
| `telegram_mark_no_reply` | Mark the current inbound message as intentionally unanswered |

`telegram_send`, `telegram_broadcast` and `telegram_attach` accept only chats on the roster and
files under the workspace root.

## Media and attachments

- **Photos/images** become part of the turn for a vision-capable model.
- **Voice notes** are transcribed through an OpenAI-compatible endpoint when
  `media.transcribe.apiKey` is set; otherwise the file is saved and the agent is told where it
  is.
- **Documents / video** are saved to the same attachments directory with a read hint injected
  for the agent.
- **Outbound files**: 1–10 files, ≤ 50 MB each, paths resolving inside the workspace root.
- Long assistant answers are split at Telegram's 4096-character payload cap.

## Approvals and questions

`ask_user_question` and approval requests render as inline cards with **Allow once / for this
session / forever (by tool)** (high-risk tools are marked) plus **Deny**. With
`interactive.userQuestions: "both"`, the same request is mirrored to the web UI when the host
api-proxy is mounted, and whichever side answers first settles the other side.

## Auto-compaction and long-task notifications

- With `compact.policy: "auto"` the bridge compacts when a request exceeds `compact.threshold`
  of the context window; `"ask"` shows a one-shot approval card first. A successful compaction is
  announced with its summary.
- Goal turns and long silent tool calls get a 30-second heartbeat on the progress card, and goal
  completion pushes a fresh receipt. Both are switchable through
  `notify.onComplete` / `notify.onLongTask`.

## Security model

- **Token**: read from the environment or a `chmod 600` file; never written by the plugin, never
  echoed into chats or logs.
- **Inbound**: chat-id roster only; an empty roster rejects all. Optional one-tap bootstrap,
  disabled with `security.selfAllow: false`.
- **Filesystem**: `/ls`, `/mkdir`, `/open` and workspace creation can be confined with
  `security.browseRoots`; attachment sending is confined to the workspace root.
- **Credentials**: only descriptions are ever listed — never secret values.

## Runtime compatibility

This build targets **dsh 0.2.x Host APIs** while still accepting the older 0.1.x shapes, so one
build runs on both. The seams that moved:

| Seam | 0.1.1-rc.2 (older) | 0.2.x (current) |
|---|---|---|
| Live session log | `session.events` (array) | `session.snapshotEvents()` (method) |
| Event timestamp | event `.at` | event `.time` |
| Persisted roster | `persistence.list()` → `{ id, cwd }` | `list()` → `{ header, revision }` |
| Reading a cold log | `persistence.readRaw(id)` | `open(id, "read").read()` |

Notes:

- On a 0.2.x host, reading `.events` yields the *method*, and iterating it throws
  `session.events is not iterable` — the failure this fork fixes. See
  [Troubleshooting](#troubleshooting).
- `snapshotEvents()` is marked deprecated by dsh ("new calls prohibited") and is used here as the
  only synchronous accessor; the long-term migration is an event-driven fold.
- When installing by `link:`, keep this package's version unchanged so a recorded compatibility
  exemption key keeps matching.
- Known gap: `/sessionlog` (session-log ZIP download) still points at the old
  `@deepseek-ai/dsh-host-apiproxy` seam. Where that package is gone, the command degrades to the
  "open the web UI" message instead of building the archive.

## Development

```bash
npm ci             # dev dependencies (TypeScript 5.8, @deepseek-ai/* types)
npm run build      # tsc -p tsconfig.json  -> dist/
npm run typecheck  # tsc --noEmit
npm test           # build + node --test test/*.test.mjs
npm run check      # build + typecheck + full suite
```

The suite is self-contained: no real Telegram token and no network access are required.
`test/runtime-compat.test.mjs` pins the 0.2.x host shapes (snapshot-only sessions, `time` stamps,
`open()`-based cold reads), while the older suites keep pinning the 0.1.x shapes.

Source layout:

```
src/
  index.ts                 plugin mount, token resolution, tool registration
  config.ts                config schema, defaults, validation, token resolution
  core/                    dispatch, commands, card registry, chat bindings, tools
  cards/                   one module per card (sessions, models, workspaces, …)
  telegram/                transport, keyboards, markdown->HTML, queue, status panel
  harness/adapters/        thin adapters over Host services (sessions, goals, llm, …)
  extensions/              harness feed, reasoning, openclaw projections
```

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `sessions roster load failed session.events is not iterable` | Old build on a 0.2.x host. Rebuild (`npm run build`) **and restart the harness** — a running Host keeps the previously imported `dist/`. Fixed in this fork. |
| `Telegram is not running: set TELEGRAM_BOT_TOKEN and send /telegram start.` | No token visible to the harness process. Export `TELEGRAM_BOT_TOKEN` (or write `.telegram-token` next to the package) and restart. |
| `Conflict: terminated by other getUpdates request` | Two pollers on the same bot token — another bridge instance, or this plugin in two profiles. Keep exactly one enabled. |
| `401 Unauthorized` from the Bot API | The token is wrong or was revoked in BotFather. |
| Bot answers, but no cards or commands | Your chat is not on `security.allowedChatIds` (an empty roster rejects everyone). |
| A source edit seems ignored | The Host imported the old module: restart the harness. Replacing `dist/` alone is not enough while it is cached. |
| A `compatibility` error after bumping the version | The profile's recorded exemption key no longer matches; restore the package version or add a new exemption. |

## Local changes in this build

Relative to upstream `xqicxx/dsh-telegram` at `main`:

1. **Host-API compatibility layer** in `src/harness/adapters/session-read.ts`:
   `sessionEvents()`, `hasEventLog()` and `eventTime()` read a session log through whichever
   shape the host exposes, plus `persistedRows()` and `readPersistedEvents()` for both
   persistence generations.
2. **Every session-log reader migrated** to those accessors: status panel, todos, presets
   (blank check, mid-session switch, fork boundary), fork, approval de-duplication, search,
   history and trajectory.
3. **Context-usage reading** now looks at `agent.session` and accepts the settled
   `assistant/message` usage in addition to legacy stream chunks.
4. **New regression suite** `test/runtime-compat.test.mjs` (9 tests) pinning the 0.2.x shapes;
   the full suite is 695 tests, all passing.
5. `dist/` is committed on purpose, so a clone can be mounted without a TypeScript toolchain;
   `npm run build` refreshes it.
6. Upstream's internal development logs (Chinese-language `TESTING.md`, `PLAN.md`, `progress.md`,
   `task_plan.md`, `findings.md`, `README.zh.md` and `docs/`) are not mirrored here; they remain
   available in the upstream repository.

The package version deliberately stays at `0.4.0` because profile compatibility exemptions key
off it.

## Credits and license

- Upstream project: [xqicxx/dsh-telegram](https://github.com/xqicxx/dsh-telegram) — MIT.
- This fork: maintained by [SMMURDA](https://github.com/SMMURDA).
- Licensed under the MIT License; the original copyright notice is retained in
  [LICENSE](LICENSE). If you redistribute this build, keep that notice and this attribution.
