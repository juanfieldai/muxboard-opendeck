#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const device = process.argv[2];
if (!device || !/^n1-[A-Za-z0-9_-]+$/.test(device) || process.argv.length !== 3) {
  console.error("Usage: node scripts/opendeck-profile.mjs n1-DEVICE_SERIAL\nClose OpenDeck first; this creates a new Muxboard profile without changing your current layout.");
  process.exit(2);
}
const plugin = "com.juanfieldai.muxboard.sdPlugin";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(join(root, plugin, "manifest.json"), "utf8"));
const profileDir = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opendeck", "profiles", device);

function instance(controller, position) {
  const source = manifest.Actions.find(action => action.Controllers.includes(controller));
  if (!source) throw new Error(`Manifest has no ${controller} action`);
  const action = structuredClone(source);
  action.plugin = plugin;
  action.Icon = `plugins/${plugin}/${source.Icon}.png`;
  action.States = source.States.map(state => ({ ...state, Image: `plugins/${plugin}/${state.Image}.png` }));
  if (action.Encoder?.Icon) action.Encoder.Icon = `plugins/${plugin}/${action.Encoder.Icon}.png`;
  return {
    action,
    context: `${controller}.${position}.0`,
    states: action.States,
    current_state: 0,
    settings: {},
    children: null,
  };
}

await mkdir(profileDir, { recursive: true });
const path = join(profileDir, "Muxboard.json");
await writeFile(path, JSON.stringify({
  keys: Array.from({ length: 15 }, (_, position) => instance("Keypad", position)),
  sliders: Array.from({ length: 3 }, (_, position) => instance("Encoder", position)),
  infobars: [],
}, null, 2) + "\n", { flag: "wx" });
console.log(`Created ${path}\nStart OpenDeck and select the Muxboard profile. Existing profiles were left unchanged.`);
