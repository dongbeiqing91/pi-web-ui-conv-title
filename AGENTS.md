# AGENTS.md — working guide for this repository

Agent-facing instructions for anyone (human or AI) modifying this project.
The user-facing docs are in [README.md](./README.md).

## What this repo is

`conv-title` — a [pi-web-ui](https://github.com/xing-shuyin/pi-web-ui) plugin
that auto-generates conversation titles (porting the
[pi-title](https://github.com/brettinternet/pi-extensions) algorithm, MIT) and
exposes manual ✨ buttons + a `/title` slash command.

```
.
├── plugins/conv-title/     # the plugin (the only deployable artifact)
│   ├── manifest.json       # id, permissions, settings schema, UI slots
│   ├── index.mjs           # server entry: run_start trigger, LLM call,
│   │                       #   /name write-back, POST /generate route, /title cmd
│   ├── title-core.mjs      # vendored pi-title pure functions (do not rewrite)
│   └── client/entry.mjs    # browser entry: ✨ buttons → HTTP to the server
├── install.sh              # copies plugins/conv-title → <dataDir>/plugins/conv-title
├── README.md / LICENSE     # MIT; pi-title attribution must be kept
└── AGENTS.md               # this file
```

## Conventions

- All comments and docs in **English** (project rule).
- Manifest UI strings stay **bilingual** (Chinese primary + `*En` fallback) to
  match the official pi-web-ui plugins (e.g. notes, image-toolkit).
- Keep the plugin **dependency-free**: only Node builtins on the server, plain
  ESM on the client. No npm install step.
- `title-core.mjs` is a verbatim port of pi-title's pure functions. When
  upstream pi-title changes, port deliberately and keep the attribution header.
- Syntax-check after edits: `node --check` on every `.mjs` file.

## Local test loop (developer machine)

The dev machine runs pi-web-ui **0.104.4** (homebrew global) on port 8787,
data dir `~/.pi-web`. The agent itself usually runs *inside* pi-web-ui:

1. Edit under `plugins/conv-title/`, then `./install.sh` (copies the plugin).
2. `pi-web-ui server restart` — **this kills the running agent session**; the
   session is restored from disk. Do it as the last step of a change batch,
   and never re-run it blindly after an interrupted call (it may already have
   executed).
3. Verify in `/tmp/pi-web-ui.log`: look for
   `[plugin:conv-title] activated`, `llm.complete ok`, `title set (via …)`.
4. UI verification: drive a throwaway browser tab (e.g. `agent-browser`),
   reload the page, check the `.chat-header` ✨ button, session-row
   right-click menu, and the settings panel (Plugins → 对话标题).

### Host API facts (0.104.4) that shape this code

- **There is no rename API.** Title write-back goes through
  `host.prompt(convId, "/name <title>")`, which the host intercepts natively
  (never reaches the model, no user bubble). Fallback: append
  `{"type":"session_info","name":…}` to the session JSONL.
- `host.llm.complete({ prompt, system, model?, … })`: prompt ≤ 8000 chars,
  system ≤ 4000 chars. Keep the title system prompt inside that budget.
- `host.onRunEvent` `run_start` carries `conversationId` + `task` (the prompt
  text, truncated). Subagent runs must be skipped (`snap.isSubagent`).
- **UI item `id`s are keyed per plugin, across all slots** — the server merge
  (`mergeUiPluginUi`) dedupes by bare `id`. Two items in different slots with
  the same id collapse to one. Always use prefixed, unique ids
  (`header-generate`, `menu-generate`).
- **`host.registerCommand` handlers must return a string** to be echoed as a
  notice; array returns are silently discarded.
- `host.storage` keys are namespaced per plugin; this plugin stores
  `t:<sessionFile>` → last auto title (pin memory), pruned to 500 entries.

## Pin semantics (do not break)

Automatic titling must never overwrite a user-chosen title:

- In-process: current title ≠ plugin's last written title → pin, skip.
- Cross-restart: remembered title (storage) ≠ current title → pin, skip.
- Explicit actions (✨ click, `/title regenerate`) lift the pin.
- `refreshTurns = 0` (default) → exactly one automatic title per conversation.

If you change title application, re-verify all four bullet points.

## Publishing / git

- Public repo: `github.com/dongbeiqing91/pi-web-ui-conv-title` (SSH to
  github.com is blocked on the corp network; HTTPS via the stored
  `~/.git-credentials` entry works).
- No CI. Releasing = git tag; users install by copying the plugin dir
  (or `install.sh` from a checkout).
