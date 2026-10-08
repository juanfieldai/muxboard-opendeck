#!/usr/bin/env node
import { chmod, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pluginName = "com.juanfieldai.muxboard.sdPlugin";
const sourcePlugin = join(root, pluginName);
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const archiveName = `muxboard-opendeck-${packageJson.version}.tar.gz`;

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function launcher(nodeCommand) {
  const node = nodeCommand ? shellQuote(nodeCommand) : '"${MUXBOARD_NODE:-node}"';
  return `#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec ${node} "$SCRIPT_DIR/opendeck.cjs" "$@"
`;
}

async function writeLauncher(path, nodeCommand) {
  await writeFile(path, launcher(nodeCommand), { mode: 0o755 });
  await chmod(path, 0o755);
}

async function install() {
  const configHome = process.env.XDG_CONFIG_HOME || join(process.env.HOME || ".", ".config");
  const destination = join(configHome, "opendeck", "plugins", pluginName);
  await mkdir(dirname(destination), { recursive: true });
  await rm(destination, { recursive: true, force: true });
  await cp(sourcePlugin, destination, { recursive: true });
  await writeLauncher(join(destination, "bin", "opendeck"), process.execPath);
  console.log(`Installed ${pluginName} to ${destination}`);
}

async function pack() {
  const launcherPath = join(sourcePlugin, "bin", "opendeck");
  await writeLauncher(launcherPath);
  const outputDirectory = join(root, "out");
  await mkdir(outputDirectory, { recursive: true });
  const archivePath = join(outputDirectory, archiveName);
  await execFileAsync("tar", ["-czf", archivePath, "-C", root, pluginName]);
  console.log(`Packed ${archivePath}`);
}

const command = process.argv[2];
if (command === "install") await install();
else if (command === "pack") await pack();
else {
  console.error("Usage: node scripts/opendeck.mjs <install|pack>");
  process.exitCode = 2;
}
