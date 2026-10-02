/**
 * Process/protocol E2E: runs the built plugin and real Elgato SDK against a
 * local Stream Deck WebSocket peer, executable CLI fixtures and fixture HTTP.
 * This does not use physical hardware, real Herdr sessions or SSH machines.
 * Run `npm run e2e:streamdeck`; fixtures, logs and app activation stay in /tmp.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { chmod, copyFile, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { WebSocketServer } = require("ws"); // Installed with @elgato/streamdeck.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundle = join(root, "com.mrshu.muxboard.sdPlugin/bin/plugin.cjs");
await readFile(bundle); // Require an existing build; the package script builds first.
const temporary = await mkdtemp(join(tmpdir(), "muxboard-streamdeck-e2e-"));
const statePath = join(temporary, "state.json");
const callsPath = join(temporary, "calls.jsonl");
let child: ChildProcess | undefined;
let peer: any;
let scenarios = 0;
let assertions = 0;
let output = "";
let protocolError: unknown;
const messages: any[] = [];
const keySvg = new Map<string, string>();
const dialSvg = new Map<string, string>();
const providers = ["codex", "claude", "minimax", "kimi", "perplexity"];
let httpRequests = 0;
let httpFailure = false;

type Agent = { terminal_id: string; pane_id: string; workspace_id: string; tab_id: string;
  agent_status: string; agent: string; title: string; state_change_seq: number; completion_seq?: number };
type Machine = { label: string; session: string; enabled: boolean; agents: Agent[] };
type State = { sessions: Record<string, Agent[]>; machines: Record<string, Machine>;
  modes: Record<string, string>; focusError: boolean; serverVersion?: string; tabWideSeen?: boolean; hostKind?: "zellij" | "direct" | "tmux" | "cmux"; hostMissing?: boolean; hostActivationError?: boolean; hostReadbackError?: boolean; hostMembershipError?: boolean; hostClientReplaced?: boolean; tabFocusError?: boolean; hostPidOffset?: number; hostFocused?: Record<string, string> };
const agent = (index: number, status = "blocked", title = `agent${String(index).padStart(2, "0")}`): Agent => ({
  terminal_id: `terminal${String(index).padStart(2, "0")}`, pane_id: `pane${String(index).padStart(2, "0")}`,
  workspace_id: "same-workspace", tab_id: "same-tab", agent_status: status,
  agent: index % 2 ? "claude" : "codex", title, state_change_seq: 1,
});
let state: State = {
  sessions: { alpha: Array.from({ length: 12 }, (_, i) => agent(i, i === 11 ? "working" : "blocked")),
    beta: [agent(0, "unknown", "betaAgent")], ignored: [agent(0, "blocked", "IGNORED")] },
  machines: {}, modes: {}, focusError: false,
};
async function save() {
  await writeFile(`${statePath}.next`, JSON.stringify(state));
  await rename(`${statePath}.next`, statePath);
}
async function calls(): Promise<any[]> {
  return (await readFile(callsPath, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
}
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(label: string, condition: () => boolean | Promise<boolean>, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (protocolError) throw protocolError;
    if (await condition()) return;
    if (child?.exitCode !== null && child?.exitCode !== undefined) throw new Error(`Plugin exited during ${label}: ${child.exitCode}`);
    await pause(20);
  }
  throw new Error(`Timed out: ${label}`);
}
function expect(condition: unknown, explanation: string) {
  assertions++;
  assert.ok(condition, explanation);
}
async function scenario(label: string, run: () => Promise<void>) {
  await run();
  scenarios++;
  console.log(`PASS ${scenarios}. ${label}`);
}
const image = (context: string) => keySvg.get(context) ?? "";
const lcd = (column: number) => dialSvg.get(`dial${column}`) ?? "";
function send(event: string, context: string, extra: Record<string, unknown> = {}) {
  const dial = context.startsWith("dial");
  const index = Number(context.replace(dial ? "dial" : "key", ""));
  peer.send(JSON.stringify({ event, context, device: "e2e-device",
    action: `com.mrshu.muxboard.${dial ? "dial" : "attention"}`,
    payload: { settings: {}, controller: dial ? "Encoder" : "Keypad", state: 0,
      coordinates: { column: dial ? index : index % 4, row: dial ? 0 : Math.floor(index / 4) }, ...extra } }));
}
async function tap(context: string) {
  const dial = context.startsWith("dial");
  send(dial ? "dialDown" : "keyDown", context);
  send(dial ? "dialUp" : "keyUp", context);
}
function rotate(column: number, ticks: number) { send("dialRotate", `dial${column}`, { ticks, pressed: false }); }
function decode(uri: string): string {
  assert.match(uri, /^data:image\/svg\+xml;base64,/);
  const svg = Buffer.from(uri.split(",")[1], "base64").toString("utf8");
  assert.match(svg, /^<svg/);
  return svg;
}

const http = createServer((req, res) => {
  httpRequests++;
  if (httpFailure) { res.writeHead(503).end("fixture unavailable"); return; }
  const url = new URL(req.url!, "http://fixture");
  const usage = (provider: string) => ({ provider, primary: { usedPercent: 25,
    resetsAt: new Date(Date.now() + 150 * 60_000).toISOString(), windowMinutes: 300 } });
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(url.pathname === "/cost" ? [] : url.searchParams.has("provider")
    ? [usage(url.searchParams.get("provider")!)] : providers.map(usage)));
});
const ws = new WebSocketServer({ host: "127.0.0.1", port: 0 });
try {
  await save();
  await writeFile(callsPath, "");
  await copyFile(join(root, "com.mrshu.muxboard.sdPlugin/manifest.json"), join(temporary, "manifest.json"));
  const fixture = `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const file = process.env.MUXBOARD_E2E_STATE;
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
fs.appendFileSync(process.env.MUXBOARD_E2E_CALLS, JSON.stringify({kind:'herdr', args, pid:process.pid})+'\\n');
const emit = value => process.stdout.write(JSON.stringify(value));
if (args[0] === 'session' && args[1] === 'list') {
  emit({sessions:Object.keys(state.sessions).map(name => ({name, socket_path:'/fixture/'+name, running:true}))});
} else if (args[0] === 'machine' && args[1] === 'list') {
  emit(Object.entries(state.machines).map(([id,m]) => ({id,label:m.label,session:m.session,enabled:m.enabled,target:id+'.fixture.invalid'})));
} else {
  const session = args[args.indexOf('--session')+1];
  const machine = args.includes('--machine') ? args[args.indexOf('--machine')+1] : undefined;
  const agents = machine ? (state.machines[machine]?.agents || []) : (state.sessions[session] || []);
  if (args.includes('snapshot')) {
    const mode = state.modes[session];
    if (mode === 'malformed') process.stdout.write('{bad-json');
    else if (mode === 'error') emit({error:{code:'fixture_failure',message:'simulated outage'}});
    else emit({result:{type:'session_snapshot',snapshot:{version:state.serverVersion||'0.9.0',protocol:1,agents,workspaces:[{workspace_id:'same-workspace',label:'fixture-workspace'}]}}});
  } else if (args.includes('tab') && args.includes('focus')) {
    if (state.tabFocusError) emit({error:{code:'fixture_tab_failure',message:'legacy projection unavailable'}});
    else {
      emit({result:{type:'tab_info',tab:{tab_id:args[args.length-1],workspace_id:'same-workspace',label:'fixture-tab'}}});
      if(state.tabWideSeen){for(const a of agents)if(a.tab_id===args[args.length-1]&&a.agent_status==='done')a.agent_status='idle';fs.writeFileSync(file,JSON.stringify(state));}
    }
  } else if (args.includes('focus')) {
    if (state.focusError) emit({error:{code:'fixture_focus_failure',message:'pane moved'}});
    else {
      const target = agents.find(a => a.pane_id === args[args.length-1]);
      emit({result:{type:'agent_info',agent:target}});
      if (target && target.agent_status === 'done') {
        target.agent_status = 'idle';
        fs.writeFileSync(file, JSON.stringify(state));
      }
    }
  } else { process.stderr.write('unexpected fixture command '+JSON.stringify(args)); process.exitCode=1; }
}
`;
  const herdrBin = join(temporary, "herdr");
  const offlineBin = join(temporary, "offline");
  const openBin = join(temporary, "open");
  const hostFixture = join(temporary, "host-command");
  const preload = join(temporary, "host-preload.cjs");
  await writeFile(herdrBin, fixture);
  await writeFile(offlineBin, `#!${process.execPath}\nprocess.stderr.write('controlled offline fixture'); process.exitCode=1;\n`);
  await writeFile(openBin, `#!${process.execPath}\nrequire('node:fs').appendFileSync(process.env.MUXBOARD_E2E_CALLS, JSON.stringify({kind:'open',args:process.argv.slice(2)})+'\\n');\n`);
  const hostCommands = ["ps", "pgrep", "osascript", "zellij", "ssh", "tmux", "cmux"];
  await writeFile(hostFixture, `#!${process.execPath}
const fs=require('node:fs'), kind=process.argv[2], args=process.argv.slice(3), state=JSON.parse(fs.readFileSync(process.env.MUXBOARD_E2E_STATE,'utf8'));
fs.appendFileSync(process.env.MUXBOARD_E2E_CALLS,JSON.stringify({kind,args})+'\\n');
const local=Object.keys(state.sessions).map(session=>({session,zsession:'host-local-'+session,title:'fixture-workspace'}));
const remote=Object.entries(state.machines).filter(([,m])=>m.enabled).map(([id,m])=>({session:m.session,zsession:'host-'+id,remote:id+'.fixture.invalid',title:id+'.fixture.invalid: fixture-workspace'}));
const hosts=[...local,...remote].map((h,i)=>({...h,pid:51000+(state.hostPidOffset||0)+i*10,app:71000+(state.hostPidOffset||0)+i*10,front:61000+(state.hostPidOffset||0)+i*10,pane:'terminal_'+(40+i),socket:'/fixture/'+h.zsession+'.sock',tmuxPane:'%'+(40+i),sessionId:'$'+i,tmuxWindow:'@'+i,windowId:'33333333-3333-4333-8333-'+String(i).padStart(12,'0'),workspaceId:'11111111-1111-4111-8111-'+String(i).padStart(12,'0'),surfaceId:'22222222-2222-4222-8222-'+String(i).padStart(12,'0')}));
if(kind==='pgrep'){if(state.hostMissing)process.exit(1);process.stdout.write(hosts.map(h=>h.pid).join('\\n'));}
else if(kind==='ps'){
 if(args.includes('eww')&&args[0]!=='eww'){process.stderr.write('ps: illegal argument: mixed BSD eww syntax');process.exit(1)}
 if(args.includes('-axo'))process.stdout.write(hosts.map(h=>h.app+' 1 ?? /Applications/GenericTerminal.app/Contents/MacOS/GenericTerminal\\n'+(['direct','cmux'].includes(state.hostKind)?'':h.front+' '+h.app+' ttys11 /fixture/'+(state.hostKind==='tmux'?'tmux':'zellij')+'\\n')+h.pid+' '+(['direct','cmux'].includes(state.hostKind)?h.app:1)+' ttys22 /fixture/herdr').join('\\n'));
 else {const pid=Number(args[args.indexOf('-p')+1]),h=hosts.find(h=>h.pid===pid||h.front===pid);
  if(!h)process.exit(1);
  if(args.includes('eww'))process.stdout.write(state.hostKind==='direct'?'herdr':state.hostKind==='tmux'?'herdr TMUX='+h.socket+',100,0 TMUX_PANE='+h.tmuxPane:state.hostKind==='cmux'?'herdr CMUX_SOCKET_PATH='+h.socket+' CMUX_WORKSPACE_ID='+h.workspaceId+' CMUX_SURFACE_ID='+h.surfaceId:'herdr ZELLIJ_SESSION_NAME='+h.zsession+' ZELLIJ_PANE_ID='+h.pane.split('_')[1]);
  else if(pid===h.front)process.stdout.write('zellij --session '+h.zsession);
  else process.stdout.write('herdr '+(h.remote?'--remote '+h.remote+' ':'')+'--session '+h.session);
 }
}else if(kind==='osascript'){
 if(state.hostActivationError){process.stderr.write('controlled host activation failure');process.exit(1)}
 const readTitles=args.some(a=>a.includes('JSON.stringify(app.windows.name())'));
 const foregroundOnly=args.some(a=>a.includes("Number(argv[0])")&&!a.includes('windows'));
 const pid=Number(args[args.length-(readTitles||foregroundOnly?1:2)]),h=hosts.find(h=>h.app===pid);
 if(!h)throw Error('unexpected host PID '+pid);
 const title=state.hostKind==='tmux'?(state.hostFocused?.[h.zsession]?h.title:'other-'+h.zsession):h.title;
 process.stdout.write(JSON.stringify(readTitles?[title]:{pid,title:['direct','tmux'].includes(state.hostKind)?title:h.zsession}));
}else if(kind==='zellij'){
 const session=args[args.indexOf('--session')+1],h=hosts.find(h=>h.zsession===session);if(!h)process.exit(1);
 if(args.includes('list-panes'))process.stdout.write(JSON.stringify([{id:Number(h.pane.split('_')[1]),title:h.title,is_plugin:false,exited:false}]));
 else if(args.includes('focus-pane-id')){state.hostFocused={...state.hostFocused,[session]:args.at(-1)};fs.writeFileSync(process.env.MUXBOARD_E2E_STATE,JSON.stringify(state));}
 else if(args.includes('list-clients'))process.stdout.write('CLIENT_ID ZELLIJ_PANE_ID RUNNING_COMMAND\\n'+(state.hostClientReplaced&&state.hostFocused?.[session]?2:1)+' '+(state.hostReadbackError?'terminal_999':state.hostFocused?.[session]||'terminal_999')+' herdr\\n');
 else throw Error('unexpected zellij fixture command '+args.join(' '));
}else if(kind==='ssh'){
 process.stderr.write('controlled fixture forbids real SSH');process.exitCode=1;
}else if(kind==='tmux'){
 if(!args.includes('-N'))throw Error('fixture forbids starting tmux servers');
 const socket=args[args.indexOf('-S')+1],h=hosts.find(h=>h.socket===socket);if(!h)process.exit(1);
 const active=state.hostFocused?.[h.zsession],title=active?h.title:'other-'+h.zsession;
 if(args.includes('list-panes'))process.stdout.write([h.sessionId,h.tmuxWindow,h.tmuxPane,'/dev/ttys22',h.title].join('\\t')+'\\n');
 else if(args.includes('list-clients'))process.stdout.write([h.front,'/dev/ttys11',h.sessionId,active?h.tmuxPane:'%999',title,'0'].join('\\t')+'\\n');
 else if(args.includes('switch-client')){state.hostFocused={...state.hostFocused,[h.zsession]:args[args.indexOf('-t')+1]};fs.writeFileSync(process.env.MUXBOARD_E2E_STATE,JSON.stringify(state));}
 else if(args.includes('display-message'))process.stdout.write([h.front,'/dev/ttys11',h.sessionId,h.tmuxWindow,state.hostReadbackError?'%999':state.hostFocused?.[h.zsession]||'%999'].join('\\t')+'\\n');
 else throw Error('unexpected tmux fixture command '+args.join(' '));
}else if(kind==='cmux'){
 const socket=args[args.indexOf('--socket')+1],h=hosts.find(h=>h.socket===socket);if(!h)process.exit(1);
 const tree={windows:[{id:h.windowId,workspaces:[{id:h.workspaceId,panes:[{surfaces:[{id:h.surfaceId,type:'terminal',title:h.title,processes:[{pid:state.hostMembershipError?h.pid+999:h.pid}]}]}]}]}]};
 if(args.includes('identify'))process.stdout.write(JSON.stringify({socket_path:socket,app_executable_path:'/Applications/GenericTerminal.app/Contents/MacOS/GenericTerminal'}));
 else if(args.includes('tree')||args.includes('top'))process.stdout.write(JSON.stringify(args.includes('--workspace')&&args[args.indexOf('--workspace')+1]===h.workspaceId?tree:{windows:[]}));
 else if(args.includes('rpc')){
  const method=args[args.indexOf('rpc')+1];
  if(method==='system.identify')process.stdout.write(JSON.stringify({focused:{window_id:h.windowId,workspace_id:h.workspaceId,surface_id:state.hostReadbackError?'44444444-4444-4444-8444-444444444444':h.surfaceId,surface_type:'terminal'}}));
  else process.stdout.write('{}');
 }else throw Error('unexpected cmux fixture command '+args.join(' '));
}
`);
  // Explicitly substitute OS discovery helpers; configured source CLIs and the
  // built plugin/SDK remain real child processes. Absolute helper paths also
  // route here, preventing Homebrew discovery from reaching real Zellij/UI.
  await writeFile(preload, `const cp=require('node:child_process'), path=require('node:path'), original=cp.execFile;
cp.execFile=function(bin,args,...rest){const name=path.basename(bin);if(${JSON.stringify(hostCommands)}.includes(name))return original(${JSON.stringify(hostFixture)},[name,...args],...rest);return original(bin,args,...rest)};
cp.execFile[require('node:util').promisify.custom]=function(bin,args,options){return new Promise((resolve,reject)=>cp.execFile(bin,args,options||{},(error,stdout,stderr)=>{if(error){error.stdout=stdout;error.stderr=stderr;reject(error)}else resolve({stdout,stderr})}))};
`);
  await Promise.all([herdrBin, offlineBin, openBin, hostFixture].map(path => chmod(path, 0o755)));
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  if (!ws.address()) await once(ws, "listening");
  const port = (http.address() as { port: number }).port;
  const settings = { herdrBin, herdrPollMs: 500, enableHerdr: true,
    herdrSessions: ["alpha", "beta"], herdrIncludeMachines: true,
    herdrMachines: ["e2e-east", "e2e-west"], herdrMachinePollMs: 5000,
    cmuxBin: offlineBin, cmuxPollMs: 500, orcaBin: offlineBin, enableOrca: false,
    codexbarBaseUrl: `http://127.0.0.1:${port}`, codexbarPollMs: 5000 };
  ws.on("connection", (socket: any) => {
    peer = socket;
    socket.on("error", (error: unknown) => { protocolError = error; });
    socket.on("message", (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString());
        messages.push(message);
        if (message.event === "getGlobalSettings") socket.send(JSON.stringify({
          event: "didReceiveGlobalSettings", context: "e2e-plugin", payload: { settings } }));
        if (message.event === "setImage") keySvg.set(message.context, decode(message.payload.image));
        if (message.event === "setFeedback") dialSvg.set(message.context, decode(message.payload.full.value));
      } catch (error) { protocolError = error; }
    });
  });
  const launchPlugin = () => {
    child = spawn(process.execPath, ["--require", preload, bundle, "-port", String(ws.address().port), "-pluginUUID", "e2e-plugin",
      "-registerEvent", "registerPlugin", "-info", JSON.stringify({
        application: { version: "7.3.0", platform: "mac", language: "en", platformVersion: "15.0" },
        plugin: { uuid: "com.mrshu.muxboard", version: "0.1.0" },
        devices: [{ id: "e2e-device", type: 7, name: "Stream Deck + fixture", size: { columns: 4, rows: 2 } }],
        devicePixelRatio: 2, colors: {},
      })], { cwd: temporary, env: { ...process.env, PATH: `${temporary}:${process.env.PATH ?? ""}`,
        TMPDIR: temporary,
        MUXBOARD_E2E_STATE: statePath, MUXBOARD_E2E_CALLS: callsPath }, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout?.on("data", data => { output += data; });
    child.stderr?.on("data", data => { output += data; });
  };
  const restartPlugin = async () => {
    const registrations = messages.filter(m => m.event === "registerPlugin").length;
    if (child?.exitCode === null) { const stopped = once(child, "exit"); child.kill("SIGTERM"); await stopped; }
    keySvg.clear(); dialSvg.clear(); launchPlugin();
    await until("restarted plugin registration", () => messages.filter(m => m.event === "registerPlugin").length > registrations);
    for (let i = 0; i < 8; i++) send("willAppear", `key${i}`);
    for (let i = 0; i < 4; i++) send("willAppear", `dial${i}`);
  };
  launchPlugin();

  await scenario("built plugin registers with SDK and loads explicit global settings", async () => {
    await until("registration and configured poll", async () => messages.some(m => m.event === "registerPlugin") && (await calls()).some(c => c.args.includes("snapshot")));
    expect(messages.some(m => m.event === "registerPlugin" && m.uuid === "e2e-plugin"), "SDK registration UUID");
    expect(messages.filter(m => m.event === "getGlobalSettings").length === 1, "global settings requested once");
    expect(!(await calls()).some(c => c.args.includes("ignored")), "session allowlist applied after connect");
  });
  for (let i = 0; i < 8; i++) send("willAppear", `key${i}`);
  for (let i = 0; i < 4; i++) send("willAppear", `dial${i}`);
  await scenario("all eight keys and four dial strips emit decoded SVG images", async () => {
    await until("all displays", () => keySvg.size === 8 && dialSvg.size === 4 && image("key0").includes("agent00"));
    expect(keySvg.size === 8 && dialSvg.size === 4, "12 surfaces rendered");
    expect(messages.filter(m => m.event === "setFeedbackLayout").length === 4, "all dial layouts registered");
    expect(lcd(0).includes("CODEX"), "fixture HTTP provider rendered");
  });
  await scenario("same-workspace terminals and named sessions stay visible with honest age", async () => {
    expect(image("key0").includes("agent00") && image("key1").includes("agent01"), "independent same-workspace agent tiles");
    expect(image("key0").includes("#b38aef"), "Herdr badge");
    expect(/>\?</.test(image("key0")), "bootstrap age unknown");
    expect(image("key7").includes("+6"), "13 selected agents produce seven tiles + six overflow");
  });
  await scenario("tap focuses selected server/pane after outer terminal activation", async () => {
    await tap("key0");
    await until("focus", async () => (await calls()).some(c => c.args.includes("agent") && c.args.includes("focus")));
    const log = await calls();
    const focusIndex = log.findIndex(c => c.args.includes("agent") && c.args.includes("focus"));
    expect(log[focusIndex].args.join(" ") === "--session alpha agent focus pane00", "correct namespaced focus dispatch");
    expect(log.slice(0, focusIndex).some(c => c.kind === "osascript" && c.args.includes("71000")), "discovered dynamic host PID raised before acknowledgment");
    expect(log.slice(0, focusIndex).some(c => c.kind === "zellij" && c.args.join(" ") === "--session host-local-alpha action focus-pane-id terminal_40"), "existing hosting pane revealed before native agent focus");
    expect(!log.some(c => c.kind === "open"), "Herdr focus never launches a configured terminal application");
  });
  await scenario("long-press snoozes one terminal and release does not focus its neighbor", async () => {
    const before = (await calls()).filter(c => c.args.includes("agent") && c.args.includes("focus")).length;
    send("keyDown", "key0");
    await until("held key confirmation", () => messages.some(m => m.event === "showOk"));
    send("keyUp", "key0");
    await until("snoozed terminal removed", () => image("key0").includes("agent01"));
    await pause(120);
    expect((await calls()).filter(c => c.args.includes("agent") && c.args.includes("focus")).length === before, "release does not focus replacement tile");
    expect(image("key7").includes("+5"), "only one of 13 terminals snoozed");
  });
  await scenario("agent dial filter narrows terminals and push resets it", async () => {
    rotate(1, 1);
    await until("Claude filter", () => image("key0").includes("agent01") && !image("key7").includes("more"));
    expect(image("key1").includes("agent03"), "Claude-only results");
    await tap("dial1");
    await until("reset filter", () => image("key7").includes("+5"));
    expect(image("key0").includes("agent01"), "snooze survives filter reset");
  });
  await scenario("scroll dial renders absolute queue positions", async () => {
    rotate(0, 2);
    await until("scroll positions", () => image("key0").includes(">#3<"));
    expect(image("key0").includes("agent03"), "two-tick scroll moves two items");
  });
  await scenario("pager advances to final page and returns to queue top", async () => {
    await tap("key7");
    await until("last page", () => image("key7").includes("top"));
    expect([...keySvg.values()].some(svg => svg.includes("betaAgent")), "second named session remains a separate tile");
    await tap("key7");
    await until("pager home", () => image("key0").includes("agent01") && !/>#\d+</.test(image("key0")));
    expect(image("key7").includes("+5"), "home restored");
  });
  await scenario("quota number dial toggles to signed pace values", async () => {
    rotate(2, 1);
    await until("pace numbers", () => /\+25%/.test(lcd(0)));
    expect(!/>75%</.test(lcd(0)), "pace replaces remaining quota");
  });
  await scenario("provider dial rotates more than four discovered providers", async () => {
    rotate(3, 1);
    await until("provider rotation", () => lcd(0).includes("CLAUDE"));
    expect(lcd(3).includes("PPLX"), "fifth provider becomes visible");
  });
  await scenario("view push hides working terminals and touch restores full queue", async () => {
    await tap("dial2");
    await until("Decisions view", () => image("key0").includes("DEC"));
    expect(image("key7").includes("+3"), "working and unknown terminals hidden from decisions");
    send("touchTap", "dial2", { tapPos: { x: 50, y: 50 }, hold: false });
    await until("queue view", () => !image("key0").includes(">DEC<"));
    expect(image("key7").includes("+5"), "touch restores working terminal");
  });
  await scenario("held quota dial opens usage and release does not switch view", async () => {
    send("dialDown", "dial2");
    await until("usage activation", async () => (await calls()).some(c => c.kind === "open" && c.args.includes(`http://127.0.0.1:${port}/usage`)));
    send("dialUp", "dial2");
    await pause(80);
    expect(!image("key0").includes(">DEC<"), "hold release preserves view");
  });
  await scenario("force refresh reaches CLI attention and HTTP quota sources", async () => {
    const snapshots = (await calls()).filter(c => c.args.includes("snapshot")).length;
    const requests = httpRequests;
    await tap("dial3");
    await until("forced source polls", async () => httpRequests > requests && (await calls()).filter(c => c.args.includes("snapshot")).length > snapshots);
    expect(httpRequests > requests, "quota refresh issued immediately");
  });
  await scenario("disappear cancels hold and reappear redraws current item", async () => {
    send("keyDown", "key0");
    send("willDisappear", "key0");
    const confirmations = messages.filter(m => m.event === "showOk").length;
    await pause(650);
    expect(messages.filter(m => m.event === "showOk").length === confirmations, "disappear canceled pending hold");
    const paints = messages.filter(m => m.event === "setImage" && m.context === "key0").length;
    send("willAppear", "key0");
    await until("reappear render", () => messages.filter(m => m.event === "setImage" && m.context === "key0").length > paints);
    expect(image("key0").includes("agent01"), "current item repainted");
  });
  await scenario("malformed and semantic-error snapshots retain last-good displays", async () => {
    state.modes = { alpha: "malformed", beta: "error" }; await save();
    const snapshotCount = (await calls()).filter(c => c.args.includes("snapshot")).length;
    await until("two failed poll rounds", async () => (await calls()).filter(c => c.args.includes("snapshot")).length >= snapshotCount + 4);
    expect(image("key0").includes("agent01"), "cached item retained through JSON and envelope errors");
  });
  await scenario("snapshot recovery updates state age and drops disappeared sessions", async () => {
    state = { sessions: { alpha: [agent(50, "working", "recovered")] }, machines: {}, modes: {}, focusError: false }; await save();
    await until("recovered working tile", () => image("key0").includes("recovered"));
    expect(!image("key7").includes("more"), "gone agents and session removed");
    state.sessions.alpha[0].agent_status = "blocked"; state.sessions.alpha[0].state_change_seq++; await save();
    await until("observed transition", () => image("key0").includes("NEEDS YOU") && !/>\?</.test(image("key0")));
    expect(/>now</.test(image("key0")), "observed transition gets local age");
  });
  await scenario("focus re-resolves a moved terminal and SDK reports focus errors", async () => {
    state.sessions.alpha[0].pane_id = "moved-pane"; state.focusError = true; await save();
    await tap("key0");
    await until("focus failure alert", () => messages.some(m => m.event === "showAlert"));
    expect((await calls()).some(c => c.args.join(" ") === "--session alpha agent focus moved-pane"), "fresh pane selected by stable terminal identity");
    state.focusError = false; await save();
  });
  await scenario("focused completion is acknowledged and stays removed after polling", async () => {
    state.sessions.alpha[0].agent_status = "done"; state.sessions.alpha[0].state_change_seq++; state.sessions.alpha[0].completion_seq = 1; await save();
    await until("done tile", () => image("key0").includes("recovered") && !image("key0").includes("NEEDS YOU"));
    await tap("key0");
    await until("completion acknowledged", () => !image("key0").includes("recovered"));
    await pause(650);
    expect(!image("key0").includes("recovered"), "acknowledged output does not reappear");
  });
  await scenario("all-clear and all-active-sources offline states recover correctly", async () => {
    await tap("dial2");
    await until("all-clear", () => image("key0").includes("no decisions"));
    expect(!image("key0").includes("offline"), "healthy empty Herdr excludes false offline");
    state.modes.alpha = "error"; await save();
    await until("all sources offline", () => image("key0").includes("offline"));
    expect(image("key0").includes("cmux + herdr"), "inactive Orca omitted from outage label");
    state.modes = {}; await save();
    await until("offline recovery", () => image("key0").includes("no decisions"));
    expect(!image("key0").includes("offline"), "success restores healthy view");
  });
  await scenario("HTTP transport failures preserve last-good quota and recover", async () => {
    const previous = lcd(0);
    httpFailure = true;
    const requests = httpRequests;
    await tap("dial3");
    await until("HTTP outage request", () => httpRequests > requests);
    await pause(150);
    expect(lcd(0).includes("CLAUDE") && lcd(0).includes("<svg"), "retained provider SVG after transient HTTP outage");
    expect(previous.includes("CLAUDE"), "provider window maintained");
    httpFailure = false;
    const recovery = httpRequests;
    await tap("dial3");
    await until("HTTP recovery", () => httpRequests > recovery);
  });
  await scenario("identical-title terminals expose their named-session provenance", async () => {
    state = { sessions: { alpha: [agent(99, "blocked", "twinAgent")], beta: [agent(99, "blocked", "twinAgent")] },
      machines: {}, modes: {}, focusError: false }; await save();
    await tap("dial3");
    await until("same-title named sessions", () => image("key0").includes("twinAgent") && image("key1").includes("twinAgent"));
    const pair = [image("key0"), image("key1")];
    expect(pair.some(svg => svg.includes("alpha")) && pair.some(svg => svg.includes("beta")), "session names rendered beside identical titles");
    expect(pair[0] !== pair[1], "same-title session SVGs are distinguishable");
  });
  await scenario("identical-title saved-machine terminals expose machine and session provenance", async () => {
    state = { sessions: {}, machines: {
      "e2e-east": { label: "east", session: "default", enabled: true, agents: [agent(99, "blocked", "twinAgent")] },
      "e2e-west": { label: "west", session: "default", enabled: true, agents: [agent(99, "blocked", "twinAgent")] },
    }, modes: {}, focusError: false }; await save();
    await tap("dial3");
    await until("same-title machine provenance", () => [image("key0"), image("key1")].some(svg => svg.includes("east")) &&
      [image("key0"), image("key1")].some(svg => svg.includes("west")));
    const pair = [image("key0"), image("key1")];
    expect(pair.every(svg => svg.includes("twinAgent") && svg.includes("default")), "title and saved-session names rendered");
    expect(pair[0] !== pair[1], "same native IDs on different machines produce distinct visible tiles");
    const selectedMachine = image("key0").includes("east") ? "e2e-east" : "e2e-west";
    const before = (await calls()).filter(c => c.args.includes("agent") && c.args.includes("focus")).length;
    await tap("key0");
    await until("namespaced machine focus", async () => (await calls()).filter(c => c.args.includes("agent") && c.args.includes("focus")).length > before);
    expect((await calls()).filter(c => c.args.includes("agent") && c.args.includes("focus")).at(-1)?.args.join(" ") === `--machine ${selectedMachine} agent focus pane99`, "visible machine label matches dispatched machine ID");
  });
  await scenario("existing remote host is activated by discovered PID and hosting pane", async () => {
    const log = await calls();
    const focus = log.findLastIndex(c => c.kind === "herdr" && c.args.includes("agent") && c.args.includes("focus"));
    const machineId = log[focus].args[1];
    const machineIndex = Object.keys(state.machines).indexOf(machineId);
    expect(log.slice(0, focus).findLast(c => c.kind === "osascript")?.args.at(-2) === String(71000 + machineIndex * 10), "matching remote application's discovered PID activated");
    expect(log.slice(0, focus).findLast(c => c.kind === "zellij" && c.args.includes("focus-pane-id"))?.args.join(" ") === `--session host-${machineId} action focus-pane-id terminal_${40 + machineIndex}`, "matching saved-machine client hosting pane focused");
    expect(!log.some(c => c.kind === "herdr" && c.args.includes("attach")), "existing clients retained without direct terminal attachment");
  });
  await scenario("changed host PID is discovered afresh on subsequent clicks", async () => {
    const focusCount = (await calls()).filter(c => c.kind === "herdr" && c.args.includes("agent") && c.args.includes("focus")).length;
    state.hostPidOffset = 321; await save();
    await tap("key0");
    await until("changed application PID activation", async () => (await calls()).some(c => c.kind === "osascript" && c.args.includes("71321")));
    await until("changed-host native focus finishes", async () => (await calls()).filter(c => c.kind === "herdr" && c.args.includes("agent") && c.args.includes("focus")).length > focusCount);
    expect((await calls()).some(c => c.kind === "osascript" && c.args.includes("71321")), "activation uses current process ancestry instead of fixed app identity");
  });
  await scenario("missing existing host reports an alert without acknowledging completion", async () => {
    state = { sessions: { alpha: [{ ...agent(90, "done", "hostFailure"), completion_seq: 1 }] }, machines: {}, modes: {}, focusError: false, hostMissing: true }; await save();
    await tap("dial2"); // Restore queue view; completed turns are outside Decisions.
    await tap("dial3"); await until("pending host-failure completion", () => image("key0").includes("hostFailure"));
    const focusCount = (await calls()).filter(c => c.kind === "herdr" && c.args.includes("agent") && c.args.includes("focus")).length;
    const alerts = messages.filter(m => m.event === "showAlert").length;
    await tap("key0"); await until("missing host SDK alert", () => messages.filter(m => m.event === "showAlert").length > alerts);
    expect((await calls()).filter(c => c.kind === "herdr" && c.args.includes("agent") && c.args.includes("focus")).length === focusCount, "no native focus when host cannot be revealed");
    expect(image("key0").includes("hostFailure"), "unseen completion remains available");
  });
  await scenario("host activation errors preserve the pending completion", async () => {
    state.hostMissing = false; state.hostActivationError = true; await save();
    const focusCount = (await calls()).filter(c => c.kind === "herdr" && c.args.includes("agent") && c.args.includes("focus")).length;
    const alerts = messages.filter(m => m.event === "showAlert").length;
    await tap("key0"); await until("activation error SDK alert", () => messages.filter(m => m.event === "showAlert").length > alerts);
    expect((await calls()).filter(c => c.kind === "herdr" && c.args.includes("agent") && c.args.includes("focus")).length === focusCount, "failed foreground activation never acknowledges");
  });
  await scenario("incorrect Zellij focus readback prevents acknowledgment", async () => {
    state.hostActivationError = false; state.hostReadbackError = true; await save();
    const focusCount = (await calls()).filter(c => c.kind === "herdr" && c.args.includes("agent") && c.args.includes("focus")).length;
    const alerts = messages.filter(m => m.event === "showAlert").length;
    await tap("key0"); await until("wrong hosting pane SDK alert", () => messages.filter(m => m.event === "showAlert").length > alerts);
    expect((await calls()).filter(c => c.kind === "herdr" && c.args.includes("agent") && c.args.includes("focus")).length === focusCount, "hosting pane must be visibly focused before native focus");
  });
  await scenario("replaced Zellij frontend cannot acknowledge unseen completion", async () => {
    state.hostReadbackError = false; state.hostClientReplaced = true; state.hostFocused = {}; await save();
    const focusCount = (await calls()).filter(c => c.kind === "herdr" && c.args.includes("agent") && c.args.includes("focus")).length;
    const alerts = messages.filter(m => m.event === "showAlert").length;
    await tap("key0"); await until("replacement client SDK alert", () => messages.filter(m => m.event === "showAlert").length > alerts);
    expect((await calls()).filter(c => c.kind === "herdr" && c.args.includes("agent") && c.args.includes("focus")).length === focusCount, "focus readback must belong to originally discovered frontend");
  });
  await scenario("legacy tab projection failure preserves completion without agent acknowledgment", async () => {
    state.hostClientReplaced = false; state.tabFocusError = true; await save();
    const focusCount = (await calls()).filter(c => c.kind === "herdr" && c.args.includes("agent") && c.args.includes("focus")).length;
    const alerts = messages.filter(m => m.event === "showAlert").length;
    await tap("key0"); await until("legacy projection SDK alert", () => messages.filter(m => m.event === "showAlert").length > alerts);
    expect((await calls()).filter(c => c.kind === "herdr" && c.args.includes("agent") && c.args.includes("focus")).length === focusCount, "projection error never acknowledges via agent focus");
    expect(image("key0").includes("hostFailure"), "completion retained after old-server projection failure");
  });
  await scenario("host reveal recovery acknowledges completion after verified pane visibility", async () => {
    state.hostReadbackError = false; state.hostClientReplaced = false; state.tabFocusError = false; await save(); await tap("key0");
    await until("verified completion acknowledgment", () => !image("key0").includes("hostFailure"));
    expect((await calls()).some(c => c.kind === "herdr" && c.args.join(" ") === "--session alpha agent focus pane90"), "selected native agent focused after generic host recovery");
    expect(!(await calls()).some(c => c.kind === "herdr" && c.args.includes("attach")), "no replacement clients spawned during recovery");
    const log = await calls();
    const focus = log.findLastIndex(c => c.kind === "herdr" && c.args.join(" ") === "--session alpha agent focus pane90");
    expect(log.slice(0, focus).findLast(c => c.kind === "herdr" && c.args.includes("tab") && c.args.includes("focus"))?.args.join(" ") === "--session alpha tab focus same-tab", "legacy tab/workspace projection precedes final agent acknowledgment");
  });
  await scenario("direct terminal clients reveal their discovered existing application window", async () => {
    state = { sessions: { alpha: [agent(91, "blocked", "directHost")] }, machines: {}, modes: {}, focusError: false, hostKind: "direct" }; await save();
    await tap("dial3"); await until("direct host attention", () => image("key0").includes("directHost"));
    const offset = (await calls()).length;
    await tap("key0");
    await until("direct host native focus", async () => (await calls()).slice(offset).some(c => c.kind === "herdr" && c.args.join(" ") === "--session alpha agent focus pane91"));
    const log = (await calls()).slice(offset);
    expect(log.some(c => c.kind === "osascript" && c.args.some((a: string) => a.includes("JSON.stringify(app.windows.name())"))), "existing terminal window titles verified during discovery");
    expect(log.some(c => c.kind === "osascript" && c.args.at(-2) === "71000" && c.args.at(-1) === "fixture-workspace"), "exact matching window raised on discovered generic host PID");
    expect(!log.some(c => c.kind === "zellij" && c.args.includes("focus-pane-id")), "direct terminal reveal needs no multiplexer focus");
  });
  await scenario("tmux clients select the exact existing socket client and pane", async () => {
    state = { sessions: { alpha: [agent(92, "blocked", "tmuxHost")] }, machines: {}, modes: {}, focusError: false, hostKind: "tmux" }; await save();
    await tap("dial3"); await until("tmux host attention", () => image("key0").includes("tmuxHost"));
    const offset = (await calls()).length; await tap("key0");
    await until("tmux native focus", async () => (await calls()).slice(offset).some(c => c.kind === "herdr" && c.args.join(" ") === "--session alpha agent focus pane92"));
    const log = (await calls()).slice(offset);
    expect(log.some(c => c.kind === "tmux" && c.args.join(" ") === "-N -S /fixture/host-local-alpha.sock switch-client -c /dev/ttys11 -t %40"), "exact tmux socket, attached client TTY and hosting pane selected");
    expect(log.some(c => c.kind === "tmux" && c.args.includes("display-message")), "tmux client identity and selected pane read back");
    expect(log.some(c => c.kind === "osascript" && c.args.at(-1) === "other-host-local-alpha"), "current visible tmux pane title identifies native window before switching");
  });
  await scenario("wrong tmux pane readback preserves completion without native acknowledgment", async () => {
    state = { sessions: { alpha: [{ ...agent(93, "done", "tmuxFail"), completion_seq: 1 }] }, machines: {}, modes: {}, focusError: false, hostKind: "tmux", hostReadbackError: true }; await save();
    await tap("dial3"); await until("tmux completion", () => image("key0").includes("tmuxFail"));
    const offset = (await calls()).length, alerts = messages.filter(m => m.event === "showAlert").length;
    await tap("key0"); await until("tmux wrong-pane SDK alert", () => messages.filter(m => m.event === "showAlert").length > alerts);
    expect(!(await calls()).slice(offset).some(c => c.kind === "herdr" && c.args.includes("agent") && c.args.includes("focus")), "tmux focus readback error prevents agent acknowledgment");
    expect(image("key0").includes("tmuxFail"), "unseen tmux completion retained");
  });
  await scenario("tmux reveal recovery acknowledges the verified completion", async () => {
    state.hostReadbackError = false; await save(); await tap("key0");
    await until("tmux completion acknowledged", () => !image("key0").includes("tmuxFail"));
    expect((await calls()).some(c => c.kind === "herdr" && c.args.join(" ") === "--session alpha agent focus pane93"), "tmux recovery focuses selected native agent");
  });
  await scenario("cmux host verifies process membership and focuses exact window workspace and surface", async () => {
    state = { sessions: { alpha: [agent(94, "blocked", "cmuxHost")] }, machines: {}, modes: {}, focusError: false, hostKind: "cmux" }; await save();
    await tap("dial3"); await until("cmux host attention", () => image("key0").includes("cmuxHost"));
    const offset = (await calls()).length; await tap("key0");
    await until("cmux native focus", async () => (await calls()).slice(offset).some(c => c.kind === "herdr" && c.args.join(" ") === "--session alpha agent focus pane94"));
    const log = (await calls()).slice(offset);
    expect(log.some(c => c.kind === "cmux" && c.args.includes("top") && c.args.includes("--processes")), "Herdr PID membership verified on target terminal surface");
    expect(log.filter(c => c.kind === "cmux" && (c.args.includes("tree") || c.args.includes("top"))).every(c => c.args.includes("--workspace") && c.args[c.args.indexOf("--workspace") + 1] === "11111111-1111-4111-8111-000000000000"), "background cmux workspace explicitly scoped during discovery");
    expect(log.filter(c => c.kind === "cmux" && c.args.includes("rpc")).map(c => c.args[c.args.indexOf("rpc") + 1]).join(",") === "workspace.select,surface.focus,window.focus,system.identify", "cmux reveal orders workspace surface window selection then verifies visibility");
    expect(log.filter(c => c.kind === "cmux").every(c => c.args.includes("/fixture/host-local-alpha.sock")), "cmux operations use exact owned socket");
  });
  await scenario("cmux process membership mismatch rejects a stale surface without acknowledgment", async () => {
    state = { sessions: { alpha: [{ ...agent(95, "done", "cmuxFail"), completion_seq: 1 }] }, machines: {}, modes: {}, focusError: false, hostKind: "cmux", hostMembershipError: true }; await save();
    await tap("dial3"); await until("cmux completion", () => image("key0").includes("cmuxFail"));
    const offset = (await calls()).length, alerts = messages.filter(m => m.event === "showAlert").length;
    await tap("key0"); await until("stale cmux surface SDK alert", () => messages.filter(m => m.event === "showAlert").length > alerts);
    const log = (await calls()).slice(offset);
    expect(!log.some(c => c.kind === "cmux" && c.args.includes("rpc")), "unverified process membership causes no cmux focus mutation");
    expect(!log.some(c => c.kind === "herdr" && c.args.includes("agent") && c.args.includes("focus")), "stale surface cannot acknowledge work");
  });
  await scenario("wrong cmux focus readback preserves completion", async () => {
    state.hostMembershipError = false; state.hostReadbackError = true; await save();
    const offset = (await calls()).length, alerts = messages.filter(m => m.event === "showAlert").length;
    await tap("key0"); await until("wrong cmux surface SDK alert", () => messages.filter(m => m.event === "showAlert").length > alerts);
    expect(!(await calls()).slice(offset).some(c => c.kind === "herdr" && c.args.includes("agent") && c.args.includes("focus")), "cmux owning window workspace and terminal surface must match before native focus");
    expect(image("key0").includes("cmuxFail"), "unseen cmux completion remains available");
  });
  await scenario("cmux reveal recovery acknowledges completion after exact surface readback", async () => {
    state.hostReadbackError = false; await save(); await tap("key0");
    await until("cmux completion acknowledged", () => !image("key0").includes("cmuxFail"));
    expect((await calls()).some(c => c.kind === "herdr" && c.args.join(" ") === "--session alpha agent focus pane95"), "cmux recovery acknowledges selected agent after visibility proof");
  });
  await scenario("fresh plugin omits native idle agents with previously completed counters", async () => {
    state = { sessions: { alpha: [{ ...agent(100, "idle", "SeenIdle"), completion_seq: 7 },
      agent(101, "working", "LiveWork")] }, machines: {}, modes: {}, focusError: false, serverVersion: "0.9.3" }; await save();
    await restartPlugin();
    await until("modern bootstrap working tile", () => keySvg.size === 8 && dialSvg.size === 4 && image("key0").includes("LiveWork"));
    expect(![...keySvg.values()].some(svg => svg.includes("SeenIdle")), "positive completion counter alone is not unread at native-idle bootstrap");
    expect(image("key0").includes("working"), "working agent remains visible beside omitted seen idle agent");
  });
  await scenario("fresh native done with a positive counter renders unread completion", async () => {
    state = { sessions: { alpha: [{ ...agent(102, "done", "Unread"), completion_seq: 8 },
      agent(101, "working", "LiveWork")] }, machines: {}, modes: {}, focusError: false, serverVersion: "0.9.3" }; await save();
    await tap("dial3"); await until("fresh native done", () => image("key0").includes("Unread") && image("key0").includes("DONE"));
    expect(image("key1").includes("LiveWork"), "unread completion ranks before working sibling");
    expect(/>\?</.test(image("key0")), "historical completion age remains unknown at first observation");
  });
  await scenario("plugin restart does not resurrect a completion already acknowledged natively", async () => {
    await tap("key0"); await until("modern completion acknowledged", () => image("key0").includes("LiveWork") && ![...keySvg.values()].some(svg => svg.includes("Unread")));
    const native = JSON.parse(await readFile(statePath, "utf8")) as State;
    expect(native.sessions.alpha[0].agent_status === "idle" && native.sessions.alpha[0].completion_seq === 8, "native seen state retains its completion counter");
    await restartPlugin();
    await until("restarted modern working tile", () => keySvg.size === 8 && image("key0").includes("LiveWork"));
    expect(![...keySvg.values()].some(svg => svg.includes("Unread")), "fresh client baselines previously seen completion instead of replaying it");
  });
  await scenario("old 0.9.0 tab-wide native seen state preserves the unacknowledged sibling tile", async () => {
    state = { sessions: { alpha: [agent(104, "done", "Old A"), agent(105, "done", "Old B")] },
      machines: {}, modes: {}, focusError: false, serverVersion: "0.9.0", tabWideSeen: true }; await save();
    await tap("dial3"); await until("old unread sibling completions", () => ["Old A", "Old B"].every(title => [...keySvg.values()].some(svg => svg.includes(title) && svg.includes("DONE"))));
    const context = [...keySvg].find(([, svg]) => svg.includes("Old A"))![0];
    await tap(context);
    await until("selected old completion acknowledged", () => image("key0").includes("Old B") && image("key0").includes("DONE") && ![...keySvg.values()].some(svg => svg.includes("Old A")));
    await pause(650);
    const native = JSON.parse(await readFile(statePath, "utf8")) as State;
    expect(native.sessions.alpha.every(a => a.agent_status === "idle" && a.completion_seq === undefined), "real old schema has no completion counter and tab focus marks both agents seen");
    expect(image("key0").includes("Old B") && image("key0").includes("DONE"), "locally observed sibling completion remains unread despite tab-wide native idle");
    expect((await calls()).filter(c => c.kind === "herdr" && c.args.includes("agent") && c.args.includes("focus")).at(-1)?.args.join(" ") === "--session alpha agent focus pane104", "only selected stable terminal acknowledged");
  });
  if (protocolError) throw protocolError;
  console.log(`\n${scenarios} protocol/process E2E scenarios passed; ${assertions} explicit assertions; ${messages.filter(m => m.event === "setImage" || m.event === "setFeedback").length} SDK SVG messages decoded.`);
  console.log("Sources/hardware are controlled fixtures; this is not a physical-device or live Herdr/SSH test.");
} catch (error) {
  console.error(`E2E failed after ${scenarios} scenarios:`, error);
  console.error("Controlled fixture state:", await readFile(statePath, "utf8"));
  console.error("Recent fixture commands:", (await calls()).slice(-12));
  console.error("Last SVGs:", Object.fromEntries([...keySvg].map(([key, svg]) => [key, svg.match(/<text[^>]*>[^<]*<\/text>/g)])));
  if (output) console.error("Plugin output:", output);
  process.exitCode = 1;
} finally {
  if (child && child.exitCode === null) {
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    const forceKill = setTimeout(() => child?.kill("SIGKILL"), 3000);
    await exited;
    clearTimeout(forceKill);
  }
  for (const client of ws.clients) client.terminate();
  await new Promise<void>(resolve => ws.close(() => resolve()));
  await new Promise<void>(resolve => http.close(() => resolve()));
  await rm(temporary, { recursive: true, force: true });
}
