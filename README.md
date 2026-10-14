# conv-title — automatic conversation titles for pi-web-ui

A [pi-web-ui](https://github.com/xing-shuyin/pi-web-ui) plugin that titles your
conversations with a model, reusing the algorithm of
[pi-title](https://github.com/brettinternet/pi-extensions) (MIT — see the
attribution in `plugins/conv-title/title-core.mjs`):

- **Automatic**: when a new conversation round starts running, the plugin
  generates a concise title from the opening prompt (or, once the reply has
  landed, from the first completed exchange) and applies it as the pi-web-ui
  conversation title — the left sidebar updates.
- **Refresh cadence (optional)**: with `refreshTurns = N`, the title is
  regenerated from the recent transcript every N answered turns — the same
  semantics as pi-title's "every N" mode.
- **Manual**:
  - a **✨ Generate title** button in the chat header,
  - a **✨ Generate conversation title** entry in the session-row right-click
    menu (running *and* history rows),
  - a `/title [regenerate|status]` slash command.
- **Never clobbers you**: as soon as the title differs from the plugin's last
  automatic write (i.e. you renamed it), automatic titling pins off for that
  conversation. The last automatic title per session file is remembered in
  plugin storage, so a server restart does not resurrect automatic overwrites.
  An explicit ✨ click or `/title regenerate` lifts the pin.

## How it works (and the one non-obvious bit)

| Piece | Mechanism |
|---|---|
| Prompt/text/cleaning | pi-title's pure functions, ported verbatim (`title-core.mjs`) |
| Model call | `host.llm.complete()` — pi-web-ui's isolated one-shot completion: no conversation, no history, no tools |
| Trigger | `host.onRunEvent` → `run_start` (fires the moment a round starts streaming; carries the prompt text as `task`) |
| Title write-back (live) | `host.prompt(convId, "/name <title>")` → the host's native `/name` slash command, intercepted before the SDK: in-memory retitle + `session_info` entry in the transcript + broadcast to all clients + a host notice toast. It never lands in the conversation as a user message. |
| Title write-back (fallback / history) | direct `{"type":"session_info","name":...}` append to the session JSONL — pi's own rename mechanism; the history list picks it up on its next refresh |

Model chain (per generation): configured `provider/model` → current
conversation model; `auto` → first configured lightweight candidate
(`gpt-5-nano`, `gemini-2.5-flash-lite`, `claude-haiku-4-5` variants) → current
conversation model; empty → current conversation model. A title generation is
one small LLM call; it spends your own model quota.

### Plugin-authoring pitfalls (learned the hard way)

- **UI item `id`s must be unique per plugin across all slots.** The server's
  manifest/UI merge keys items by bare `id`, so two items sharing an id (e.g.
  a `chat.header` button and a `contextmenu.session` entry both called
  `generate`) silently collapse to one. Use prefixed ids such as
  `header-generate` / `menu-generate`.
- **`host.registerCommand` results are echoed only when they are strings.**
  Returning an array is silently discarded — join lines into one string.

## Requirements

- pi-web-ui ≥ 0.104.4 (developed and tested against the homebrew global
  install 0.104.4; APIs used: `run_start` events, `host.llm`, `host.prompt`,
  the `chat.header` / `contextmenu.session` UI slots, and `/plugins-api`
  routes — all present in 0.104.4).
- The standard **pi** engine (the DSH engine does not provide the LLM/chat
  host hooks; the plugin degrades to logged no-ops).

## Install

```sh
# from this repo:
./install.sh            # copies plugins/conv-title → <dataDir>/plugins/conv-title
```

`install.sh` honors `PI_WEB_DATA_DIR`; the default data dir is `~/.pi-web`.
Then restart the server (`pi-web-ui server restart`, or the in-app "restart
service"), and enable the plugin in Settings → Plugins (对话标题 / conv-title)
if it is not activated automatically.

To uninstall: remove `<dataDir>/plugins/conv-title/` (or disable it in the
settings panel) and restart.

## Settings (Settings panel → Plugins → 对话标题)

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | automatic titling on/off |
| `model` | `""` | `""` = current conversation model; `auto` = lightweight-first; or an explicit `provider/model` |
| `refreshTurns` | `0` | `0` = title once; `N` = retitle every N answered turns |
| `maxLength` | `60` | title length cap (8–200) |

## Known limitations

- The `/name` write-back goes through the host's **plugin client** (the
  browser tab with the most active conversations). With a single tab this is
  exact; with several tabs a title may be applied to another tab's active
  conversation, or fall back to the on-disk write (the live title then updates
  on the next reload). Fallbacks are logged in the plugin log (Settings →
  Plugins → 日志 / Logs).
- Each `/name` shows the host's own notice toast ("Renamed current session to
  …"). That is host behavior, not something the plugin suppresses — it doubles
  as confirmation for automatic titles.
- History rows: the title is written to the session file and becomes visible on
  the next history-list fetch (the panel refreshes automatically).
- Subagent conversations are not titled automatically.

## Files

```
plugins/conv-title/
├── manifest.json     # permissions, settings schema, UI slot contributions
├── index.mjs         # server entry (trigger, generation, write-back, /title)
├── title-core.mjs    # pi-title pure functions (MIT, vendored with attribution)
└── client/entry.mjs  # client entry (✨ buttons → POST /plugins-api/conv-title/generate)
```

## License

[MIT](./LICENSE) — with the pi-title algorithm vendored from
[brettinternet/pi-extensions](https://github.com/brettinternet/pi-extensions)
(MIT).
