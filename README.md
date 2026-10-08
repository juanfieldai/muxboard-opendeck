# Muxboard for Orca + OpenDeck

A Linux/OpenDeck fork of [mrshu/muxboard](https://github.com/mrshu/muxboard), adapted for the **Mars Gaming MSD NEO / Mirabox N1**: 15 LCD keys in a 5-row × 3-column grid, two buttons, and one rotary knob.

Every live Orca agent pane gets its own tile—even when several agents share a repository. Supports Orca-hosted **OMP, Claude Code, OpenCode, Codex, and Pi**, with unknown agent types rendered neutrally. It does not launch agents or monitor standalone sessions outside Orca.

## Install from source

Requirements:

- Native Linux [OpenDeck](https://github.com/nekename/OpenDeck), verified with 2.14.0.
- Running [Orca](https://onorca.dev) with `orca-ide worktree ps --json`, `terminal list --json`, and `terminal switch --terminal HANDLE --json` support.
- Node.js 22 or newer and npm.
- The [Mirabox N1 hardware plugin](https://github.com/pomeo/opendeck-mirabox-n1) installed and your device already visible in OpenDeck. For MSD NEO, ensure the driver and udev rules support USB **0b00:1004**; the device advertises firmware `V3.MSD-NEO.02.011`.

Close OpenDeck before installation:

```sh
git clone https://github.com/juanfieldai/muxboard.git
cd muxboard
npm ci
npm run install:opendeck
node scripts/opendeck-profile.mjs n1-YOUR_DEVICE_SERIAL
```

Find the `n1-…` device identifier among the existing directories in `${XDG_CONFIG_HOME:-$HOME/.config}/opendeck/profiles/`. Start OpenDeck and select the **Muxboard** profile. The profile generator refuses to overwrite an existing Muxboard profile and leaves your other layouts unchanged.

Alternatively, place **Agent Slot** on all 15 keys and **Agent Controls** on all three encoder positions through OpenDeck's editor.

The installer uses `${XDG_CONFIG_HOME:-$HOME/.config}/opendeck/plugins/com.juanfieldai.muxboard.sdPlugin` and pins the Node executable used to install it. This works when Node comes from nvm but OpenDeck starts from the desktop. Reinstall if that Node executable is removed or moved.

## Controls

| Physical control | Action |
| --- | --- |
| Agent key: press | Focus the exact Orca terminal shown when the key went down |
| Agent key: hold ≥600 ms | Snooze that agent locally for five minutes; does not interrupt it |
| Button A / Encoder 1 | Cycle agent filter: All → Claude → Codex → OMP → Pi → OpenCode |
| Button B / Encoder 2 | Toggle Decisions: only input requests, permission blocks, and failures |
| Knob / Encoder 3: turn | Scroll the queue |
| Knob: press | Reset filters, Decisions, and scroll to the full queue |
| Knob: hold ≥600 ms | Refresh Orca immediately |
| Bottom-right key with overflow | Page forward; HOME returns to the first page |

An overflowing queue uses 14 agent slots and a pager. Without overflow, all 15 keys are available.

## State and focus

The plugin polls Orca every 1.5 seconds. It joins lifecycle records from `worktree ps` to connected `terminal list` entries using **worktree ID + tab ID + leaf ID**, not whichever terminal last produced output.

- Working, waiting for input, blocked, completed, and interrupted agents are distinguished using Orca's lifecycle state.
- Historical agents without live terminals are removed.
- Floating terminals and live agents missing lifecycle records show **UNKNOWN**, with unknown state age. An ordinary shell is not shown as an agent.
- A closed or replaced pane produces an alert; the key never silently redirects to a neighboring agent.
- During an Orca outage, last-good tiles remain with an **OFF** badge. With no cached items, the first key shows the source-offline tile.

Focus uses Orca's `terminal switch`, not synthetic keyboard shortcuts, so it does not depend on X11/XTEST focus emulation under Wayland.

Linux defaults to `orca-ide` to avoid invoking GNOME's unrelated `/usr/bin/orca` screen reader. `ORCA_CLI_COMMAND` overrides it; `ORCA_DEV_REPO_ROOT` selects `orca-dev` when no explicit command is set. The native host also accepts OpenDeck global settings for `orcaBin`, `orcaPollMs`, and `enableOrca`. There is no settings editor in this fork; use environment overrides or source configuration when needed.

## Build and package

```sh
npm run typecheck
npm test
npm run build:opendeck
npm run pack:opendeck
```

`pack:opendeck` creates `out/muxboard-opendeck-<version>.tar.gz`. With OpenDeck closed, extract its `.sdPlugin` directory into OpenDeck's `plugins` directory. The portable launcher requires `node` on the desktop application's PATH, or an absolute `MUXBOARD_NODE` environment override. Source installation pins Node automatically and is recommended for nvm installations.

This native package uses a WebSocket client and the existing Muxboard queue/rendering core, not Elgato's macOS SDK runtime. The original macOS host remains separately buildable with `npm run build`; its setup and LCD/CodexBar features are documented [upstream](https://github.com/mrshu/muxboard). They are not enabled in the OpenDeck host. See [development notes](docs/development.md).

## Troubleshooting

- **No device:** fix the Mirabox hardware backend and USB permissions first; Muxboard is an action plugin, not a hardware driver.
- **No agents:** verify `orca-ide terminal list --json`; only connected agent terminals appear. Press the knob to clear filters/Decisions.
- **OFF / source offline:** check that Orca is running and the selected CLI can reach its runtime.
- **Plugin missing:** restart OpenDeck after installation and inspect `${XDG_DATA_HOME:-$HOME/.local/share}/opendeck/logs/plugins/com.juanfieldai.muxboard.sdPlugin.log`.
- **Images present but physical controls wrong:** this profile expects the N1 backend mapping Button A=0, Button B=1, knob=2; update the hardware backend if its mapping differs.

## Fork changes and verification

Added a native Linux/OpenDeck host and N1 profile generator, device-sized pagination, OpenCode identity/filtering, and exact per-agent Orca discovery/focus. CI builds both bundles and packages the native archive; release workflows can attach both host packages.

Verified on Linux with OpenDeck 2.14.0 and MSD NEO `0b00:1004`: native registration, selected 15-key/three-control profile, device image delivery, six live OMP panes, exact focus and return to the original session, and a native WebSocket/live-Orca smoke covering filter, Decisions, knob reset, snooze, and held-key focus after the queue changes. Typecheck, both builds, packaging, and 261 existing/updated tests pass.

Physical key/knob input and LCD appearance still require on-device confirmation. The desktop accessibility tree was inspected; its screenshot provider returned no image. Claude/OpenCode identities are covered by normalization/filter regression tests, not a live standalone-agent launch.

## License

MIT. Original Muxboard code and artwork remain credited to the upstream project; see [LICENSE](LICENSE).
