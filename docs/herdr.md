# Herdr integration

[Back to the README](../README.md)

Muxboard polls **all running local Herdr sessions**, including named sessions,
and enabled saved SSH machine profiles, merging their agent panes with cmux and
Orca. It polls saved machines through Herdr's noninteractive `--machine` API.
It does not start stopped sessions or complete interactive SSH authentication.
Each terminal needing attention or actively working gets its own key, so two
agents in one workspace and identically named panes in different sessions stay
independent. An **H** badge identifies Herdr, and the machine/session label
distinguishes otherwise identical keys.

## State, completions, and age

Herdr's structured status drives the key: `working` sinks to the end, `blocked`
shows **NEEDS YOU** (questions and approvals), and `done` shows an unseen
completion. Already-seen `idle` agents are omitted. While a terminal remains
completed, viewing another pane in its tab does not clear its completion
observed by Muxboard. Focusing its own key acknowledges it. Renewed activity or
removal can replace the item. `unknown` never implies completion. Known Claude,
Codex, Pi, and OMP agents retain their visuals. Other agent kinds use the neutral
theme. Muxboard does not scrape terminal output or resume native conversations.

On startup, native `idle` is accepted as already seen, including when a newer
server retains its last `completion_seq`. Native `done` still surfaces immediately.
Herdr marks every pane in a viewed tab seen. Muxboard retains unread sibling
completions it observed during this run. Older servers expose no completion
history for results marked seen before Muxboard started.

Herdr provides transition sequence numbers rather than historical timestamps.
Muxboard measures state age from transitions it observes while running. A pane
already present at startup shows an unknown age until a transition is observed.
Newer servers may also provide `completion_seq`. It is optional so older
compatible servers remain usable.

## Local session selection

Herdr is auto-detected by default. Global settings `herdrBin` and `herdrPollMs`
choose the CLI and cadence. `enableHerdr: true|false` forces the source on or off.
An empty `herdrSessions` allow-list includes all running local sessions. To limit
it, use exact session names, with `"default"` for the default session. See
[Configuration](../README.md#configuration) for how overrides are applied.

## Existing host focus

Pressing a Herdr key discovers an existing Herdr client and brings its owning
terminal application forward by process id. Zellij focus resolves the existing
session, pane, and containing tab. tmux focus resolves its attached client,
session, window, and pane. cmux focus resolves its existing workspace and terminal
surface. Direct terminal clients use process ancestry and a verified window
title to locate the owning application. A moved Herdr pane still resolves
through its stable terminal identity. Long-press snoozes only that terminal
locally for five minutes.

Focus does not start another Herdr client, terminal window, or coding agent.
If no attached host can be found, or several candidates cannot be distinguished,
the key shows an alert and keeps the item pending. Direct terminals, Zellij,
tmux, and cmux are supported. Discovery checks endpoint titles, live process
ownership, and the attached frontend or socket identities before changing
focus. Mixed nested multiplexers are rejected until their complete host route
can be verified.

## Saved SSH machines

Remote profiles use their saved session and are independent of
`herdrSessions`. Set `herdrIncludeMachines: false` for local-only polling, or
restrict `herdrMachines` to saved profile ids/labels. Prefer opaque profile ids
when labels are ambiguous. Remote snapshots refresh at `herdrMachinePollMs`
(default 15 seconds), with independent failure handling so an unavailable
machine does not hide agents on other machines. Authentication failures are
reported without prompting or falling back to the local session. Remote CLI
forwarding uses compatible Herdr installations when available. Older remotes
that explicitly reject machine API forwarding use a noninteractive SSH fallback
to the saved target and session, including the usual `~/.local/bin/herdr` install.
Partial failures retain cached tiles and produce deduplicated failure/recovery
messages in the plugin log.

Each tile shows its session and, for a saved remote, its machine label. Herdr's
API selects the target pane on its server. Revealing the existing terminal host
is a separate step. For remote work, the existing Herdr client must already be
attached to the matching saved machine. The API does not switch a client's
selected machine or attach a detached session.

## Server compatibility

For Herdr 0.9.0 servers, Muxboard focuses the agent's containing tab before its
pane so existing clients also follow API focus. Updating the CLI can leave
existing servers on their old version. This compatibility sequence does not require
restarting those sessions. The CLI/server end-to-end suite is exercised with
0.9.3.

## macOS focus permissions

Revealing an existing terminal uses System Events to inspect and raise its
window. If the plugin log reports an Automation or accessibility permission
error, allow the requested access in macOS System Settings → Privacy &
Security → Automation / Accessibility, then retry. Polling can still work
while window focus is denied.
