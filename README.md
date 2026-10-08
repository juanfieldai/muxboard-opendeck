# Muxboard for Orca + OpenDeck

A Linux/OpenDeck fork of [mrshu/muxboard](https://github.com/mrshu/muxboard), adapted for the **Mars Gaming MSD NEO / Mirabox N1**: 15 LCD keys in a 5-row × 3-column grid, two screenless buttons, one rotary knob, and a full-width **450×85 LCD**.

Every live Orca agent pane gets its own tile—even when several agents share a repository. Supports Orca-hosted **OMP, Claude Code, OpenCode, Codex, and Pi**, with unknown agent types rendered neutrally. The Actions page launches installed OMP/Claude/OpenCode agents in the selected Orca workspace; standalone sessions outside Orca are not monitored.

## Install from source

Requirements:

- Native Linux [OpenDeck](https://github.com/nekename/OpenDeck), verified with 2.14.0.
- Running [Orca](https://onorca.dev) with worktree/terminal inventory, terminal switch/create, and file open-changed CLI support.
- Node.js 22 or newer and npm.
- The [full-LCD Mirabox N1 hardware plugin fork](https://github.com/juanfieldai/opendeck-mirabox-n1) installed and your device already visible in OpenDeck. It supports MSD NEO USB **0b00:1004**, firmware `V3.MSD-NEO.02.011`, and exposes two Keypad auxiliary buttons, one Encoder, and one native Infobar. The original three-encoder backend is not compatible with this profile.

Close OpenDeck before installation:

```sh
git clone https://github.com/juanfieldai/muxboard.git
cd muxboard
npm ci
npm run install:opendeck
node scripts/opendeck-profile.mjs n1-YOUR_DEVICE_SERIAL
```

Find the `n1-…` device identifier among the existing directories in `${XDG_CONFIG_HOME:-$HOME/.config}/opendeck/profiles/`. Start OpenDeck and select the **Muxboard** profile. The profile generator refuses to overwrite an existing Muxboard profile and leaves your other layouts unchanged.

Alternatively, place **Agent Slot** on the 15 LCD keys, **Agent Controls** on Button A, Button B, and the sole encoder, and **Agent LCD** on the native Infobar between the two touchpoints in OpenDeck's editor.

The installer uses `${XDG_CONFIG_HOME:-$HOME/.config}/opendeck/plugins/com.juanfieldai.muxboard.sdPlugin` and pins the Node executable used to install it. This works when Node comes from nvm but OpenDeck starts from the desktop. Reinstall if that Node executable is removed or moved.

### Migrating an older profile

Keep the `n1-…` device identifier and the first 15 Agent Slot entries unchanged. Move the old Button A action from `Encoder.0.0` to `Keypad.15.0` (row 5, column 0), and Button B from `Encoder.1.0` to `Keypad.16.0` (row 5, column 1). Move the old knob action from `Encoder.2.0` to `Encoder.0.0`; remove the obsolete encoder entries. Add **Agent LCD** (`com.juanfieldai.muxboard.lcd`) at `Infobar.0.0`. The resulting profile has 17 keys, one slider, and one infobar—not three LCD tiles. The generator creates this layout for new profiles only; it never migrates or overwrites an active profile.

## Controls

| Physical control | Action |
| --- | --- |
| Agent key: press | Select and focus the exact Orca terminal shown when the key went down |
| Agent key: hold ≥600 ms | Snooze that agent locally for five minutes; does not interrupt it |
| Button A / Keypad 15 | Select and focus the next agent needing input, blocked, or failed |
| Button B / Keypad 16: press | Toggle All / Needs |
| Button B: hold ≥600 ms | Switch Agents / Actions without also changing the filter |
| Knob / Encoder 0: turn | Move the highlighted agent or action; never changes focus by itself |
| Knob: press | Focus the selected agent or run the selected action |
| Action key: press | Run that action for the agent selected when Actions was opened |
| Action key: hold ≥600 ms | Do not execute; release and tap deliberately |
| Bottom-right key with overflow | Page forward; HOME returns to the first page |

An overflowing queue uses 14 agent slots and a pager. Without overflow, all 15 keys are available. Selection follows the same agent across polling/reordering, and paging keeps the highlight visible.

**Typical workflow:** press an agent key, hold Button B, then press **Shell**, **OMP**, **Claude**, **OpenCode**, or **Show changes**. New terminals open in that agent's workspace—not whichever workspace happens to be active in Orca. **Focus selected**, **Refresh**, and **Back** are also available. Only installed agent launchers appear; floating terminals have no workspace, so their page offers focus/refresh/back only. No action sends prompts, approves permissions, interrupts, or closes an existing agent.

The top LCD is **one continuous 450×85 status banner**, showing the selected agent/task, its state and queue position, and the knob's current action. The Actions page keeps its target visible. Only **Agent LCD** on **Infobar 0** renders this surface; Button A, Button B, and the knob are screenless inputs and never send LCD images.

The N1 driver keeps the first and last ten columns black on every strip image, so Muxboard draws the banner for the remaining 430×85 area. OpenDeck 2.14.0 rasterizes its Infobar at 248×58, which cannot be sharp once enlarged, so Muxboard **draws the banner directly** through the N1 driver's strip socket (`$XDG_RUNTIME_DIR/opendeck-mirabox-n1/strip.sock`). The driver renders the SVG at the native 430×85 on unmodified OpenDeck. Muxboard still sends the same SVG through OpenDeck's `setImage`, for the editor preview and as the fallback: if the driver has no socket or Muxboard stops, the driver shows OpenDeck's Infobar image again.

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
- **No agents:** verify `orca-ide terminal list --json`; only connected agent terminals appear. Tap Button B to return from Needs to All.
- **OFF / source offline:** check that Orca is running and the selected CLI can reach its runtime.
- **Plugin missing:** restart OpenDeck after installation and inspect `${XDG_DATA_HOME:-$HOME/.local/share}/opendeck/logs/plugins/com.juanfieldai.muxboard.sdPlugin.log`.
- **Images present but physical controls wrong:** install the full-LCD driver fork and migrate the profile: Button A=Keypad 15, Button B=Keypad 16, knob=Encoder 0, LCD=Infobar 0. The first 15 agent keys remain Keypad 0–14.

## Fork changes and verification

Added a native Linux/OpenDeck host and N1 profile generator, device-sized pagination, OpenCode identity/filtering, exact per-agent Orca discovery/focus, stable knob selection, and a workspace Actions page. CI builds both bundles and packages the native archive; release workflows can attach both host packages.

The native-Infobar migration passed TypeScript checking, all Muxboard tests (271, including the strip-socket client), and the OpenDeck build. The hardware fork passed its Rust tests, example checks, and release build.

Installed integration was exercised on Linux with unmodified OpenDeck 2.14.0 and MSD NEO `0b00:1004`: the editor showed one encoder, two auxiliary touchpoints, and one Agent LCD Infobar; driver logs recorded Muxboard drawing the banner directly through the strip socket at 450×85 at wire index 16, and, when Muxboard was stopped, the driver falling back to OpenDeck's 248×58 Infobar image. The 450×85 direct-device calibration was physically confirmed by the user. Native control behavior has regression coverage; physical button operation after migration and the final dashboard pixels have not been independently observed through a camera or framebuffer readback.

## License

MIT. Original Muxboard code and artwork remain credited to the upstream project; see [LICENSE](LICENSE).
