# cmux integration

[Back to the README](../README.md)

## The cmux notification contract

The cmux source consumes notifications: agents make a pane "need
attention" by emitting one. cmux already does this for built-in agents; for
custom agents, emit a notification (e.g. from an agent hook) shaped like the
rows returned by `cmux list-notifications --json`:

```jsonc
{
  "id": "015D0B50-...",           // uuid; used as the focus/open key
  "title": "Claude Code",         // agent → claude | codex | omp | pi | unknown
  "subtitle": "",
  "body": "Claude is waiting for your input",   // status (see mapping)
  "is_read": true,
  "workspace_id": "6ECA42AE-...", // required
  "surface_id": "4F5A8945-...",   // focused on press
  "tab_title": "RCJ Scoreboard",  // shown as the repo/short name
  "created_at": "2026-06-20T11:59:46Z"  // sort key, newest-first
}
```

Agent is detected from the running process: Muxboard reads cmux's
`top --processes` `coding_agents` (matched to the workspace by PID), so a codex
CLI in a pane named `fieldtheory-cli` is still identified as codex. If the
process can't be resolved, it checks `agentAliases` against the title/tab name,
then built-in keywords (`claude`/`codex`/`omp`/`pi`), otherwise `unknown`.

The notification reason uses structured fields, strongest signal first:

| Reason | Signal | Appearance |
| --- | --- | --- |
| `failed` | `subtitle` contains error, fail, failed, crash, or crashed | Red failure border |
| `blocked` | `subtitle` contains permission or approval; or `body` uses a permission-request phrase such as “needs permission” or “awaiting approval” | Amber permission badge |
| `waiting` | Any other notification | Waiting; live activity may override it |

Free-form body text such as “fixed the error” does not imply failure, and
completion wording alone does not produce a `finished` cmux tile.

Notes:

- Rows missing `id` or `workspace_id` are dropped (never fatal).
- Read notifications stay on the board, demoted. cmux flips `is_read` when you
  merely *see* a notification — not when you resolve it — and muxboard's own
  `open-notification` marks it read too, so a read row can still need you.
  Dropping read rows would hide genuine attention, so instead a read
  `failed`/`blocked` is demoted to `waiting`: the key stays but loses the urgent
  badge and the front-pin. Live `Needs` status re-flags genuine attention.
  Notifications are collapsed to one per workspace (newest wins), so each repo
  occupies a single key showing its current state.
- An explicit "clear notifications" in cmux is honored live: the `cmux events`
  stream emits `notification.clear_requested` (carrying `--tab=<workspace>`), and
  any key that fired at or before that clear is dropped immediately, ahead of the
  next poll — even one that was still unread. A later prompt (a re-ask) survives,
  since its timestamp is past the clear.
- To emit one yourself: `cmux notify --title "Codex CLI" --body "Ready for your input"`
  (run inside the target workspace, or pass `--workspace`).

## How a pane's state is derived

A key shows a status (working, waiting, permission, or failed) and an age.
Neither comes from a single cmux field; cmux's notifications, title spinner, and
agent state each tell a partial, often-stale story. Muxboard fuses several
signals so a key reflects what is actually true, which in practice is frequently
more accurate than any one cmux surface on its own. Each signal is best-effort
and degrades to the next when unavailable.

1. Queue membership and the reason come from `cmux list-notifications`. A
   notification puts a pane on a key; its reason is `failed`, `blocked`, or
   `waiting` (see the table above). Failure detection uses the subtitle;
   permission detection also recognizes specific body phrases. cmux flips
   `is_read` when you see a notification,
   not when you resolve it, so a read (`is_read: true`) permission/failure is
   demoted to `waiting` — the key stays visible but loses its urgent badge —
   rather than dropped, which would hide things that still need you. An explicit
   "clear notifications" in cmux is honored live via the event stream
   (`notification.clear_requested`), removing the key at once.

2. Activity (working vs waiting) comes from the `cmux events` stream. Muxboard
   prefers cmux's own computed verdict (`set_status`: `Running`, `Idle`, `Needs`),
   the same state that drives cmux's UI. For workspaces cmux doesn't publish a
   status for, it derives state from raw agent hooks (`UserPromptSubmit` and
   `PreToolUse` → working; `Stop` and `SessionEnd` → idle; `Notification` and
   `AskUserQuestion` → needs). A working pane shows `● working` and sinks below
   the panes still waiting on you, since it no longer needs you. The title spinner
   glyph is the fallback when the stream is unavailable.

3. Age is the time since the current state began (the transition `occurred_at`),
   so a key reads "working for 2m" or "waiting since 09:31" rather than the age of
   a stale, lingering notification. It falls back to the notification `created_at`.

4. A busy command counts as working, from `cmux top`. An agent can finish its turn
   and return to waiting while a command it launched keeps running, so a workspace
   whose process CPU is at or above `busyCpuPercent` is treated as working even
   after the agent yields, with a short hysteresis window so a bursty command
   doesn't flicker. An explicit "needs you" still wins over busy, so permission
   prompts stay visible.

Grid priority, front to back: failed, then permission, then needs-input (cmux's
"Needs" status, shown as a prominent `◆ NEEDS YOU` badge), then stalled agents,
then other waiting/results, and actively-working last. Items are newest-first
within each priority band. Actively-working panes are
listed even without a notification; they land at the very end, so the panes that
need you always stay up front, and pressing one focuses its workspace.

Known limitation: a Claude agent waiting on its own background subagent does that
work in-process, where cmux reports no spinner, no `set_status`, and low CPU, so
the pane reads `waiting`. The only ground truth is the agent's own terminal
screen, which Muxboard deliberately does not scrape. That narrow case (an agent
blocked on its own background task) is the one state no cmux signal exposes.

## Why automation mode is required

cmux's control socket does an ancestry check: under the default
`socketControlMode: cmuxOnly` it only accepts processes spawned inside a cmux
session. The Stream Deck app launches plugins via launchd, outside any session,
so a direct `cmux` call is rejected with "broken pipe". Setting
`socketControlMode: automation` removes the ancestry check for local processes of
the same user, which is what lets the plugin spawn cmux directly. This is the
approach the [gonzaloserrano/streamdeck-cmux](https://github.com/gonzaloserrano/streamdeck-cmux)
plugin also uses. (Note: on some builds and macOS versions the mode reportedly
doesn't take effect; see upstream issues
[#1864](https://github.com/manaflow-ai/cmux/issues/1864) /
[#3282](https://github.com/manaflow-ai/cmux/issues/3282), and verify with
`cmux capabilities | grep access_mode`.)

## Troubleshooting agent hooks

### Claude panes show stale/wrong state (or don't appear), but codex works

This is almost always a PATH problem, and it's upstream of Muxboard: cmux's
[#5796](https://github.com/manaflow-ai/cmux/issues/5796). cmux injects Claude's
hooks through a `claude` wrapper shim on PATH. If Claude Code's own
`~/.local/bin/claude` (created/updated by its auto-installer) sits earlier on
PATH, it shadows the shim, so `claude` runs the real binary and no hooks fire.
Codex is unaffected because its hooks are a file (`~/.codex/hooks.json`), not a
PATH shim. Diagnose:

```bash
which claude        # if it's ~/.local/bin/claude (not a .../cmux-cli-shims/... path), the shim is shadowed
cmux events --limit 5   # codex emits agent.hook.* while working; Claude emits none
```

Fix: make cmux's shim win on PATH by re-prepending its shim dir after your PATH
setup runs, then start your Claude sessions in a fresh cmux terminal (pre-existing
sessions won't recover). Add to the end of your shell config:

```fish
# ~/.config/fish/config.fish
for d in $PATH
    if string match -q '*cmux-cli-shims*' -- $d
        set -gx PATH $d $PATH
        break
    end
end
```

```zsh
# ~/.zshrc
for __d in ${(s/:/)PATH}; do
  if [[ "$__d" == *cmux-cli-shims* ]]; then export PATH="$__d:$PATH"; break; fi
done
unset __d
```

After a fresh session, `which claude` should resolve to a `.../cmux-cli-shims/...`
path. Verify hooks with `cmux events --limit 5`: you should now see
`agent.hook.PreToolUse` while the agent works.

### A pane shows "working" but with a stale-looking age

Without the agent-hook stream, a busy command can still supply its observed
start time through `cmux top`. Age falls back to notification time when neither
live state nor a busy-start timestamp is available. Once hooks fire (see above),
age reflects live activity; an agent merely waiting on remote inference has no
local CPU signal.

### Why is an active cmux agent not on a key?

Muxboard lists actively-working panes at the end of the queue, but only once cmux
reports them as working (a live spinner / hook activity). A brand-new agent with
no notification and no live "working" signal yet won't appear until it either
needs you or cmux marks it working.
