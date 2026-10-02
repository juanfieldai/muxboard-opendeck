import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { HerdrReveal } from '../src/core/herdr/reveal.js';
import type { HerdrHost } from '../src/core/herdr/hosts.js';
const target = { session:'default', terminalId:'term_x',paneId:'w1:p1',socketPath:'/session.sock' };
const host: HerdrHost = { herdrPid:100,appPid:700,appExecutable:'/Applications/Any Terminal.app/Contents/MacOS/Terminal',tty:'ttys001',zellij:{session:'owned-session',paneId:'terminal_3',attachedClientsCount:1} };
function harness(overrides: Partial<HerdrHost> = {}) {
 const calls: Array<{bin:string,args:string[]}> = [];
 let afterPane='terminal_3', afterClient=1, focusError:Error|undefined, appError:Error|undefined;
 const reveal=new HerdrReveal({ discover:async()=>({...host,...overrides}), runner:async(bin,args)=>{
  calls.push({bin,args});
  if(bin==='osascript') {if(appError)throw appError;return {stdout:'{"pid":700,"title":"owned-session"}',stderr:''};}
  if(args.includes('focus-pane-id')&&focusError)throw focusError;
  return {stdout:args.includes('list-clients')?`CLIENT_ID ZELLIJ_PANE_ID RUNNING_COMMAND\n${afterClient} ${afterPane} herdr\n`:'',stderr:''};
 }});
 return {reveal,calls,failedFocus:(e:Error)=>focusError=e,failedApp:(e:Error)=>appError=e,wrongPane:()=>afterPane='terminal_99',changedClient:()=>afterClient=2};
}
test('existing-host reveal activates the discovered process and verifies the Zellij pane',async()=>{
 const f=harness();await f.reveal.show(target);
 assert.equal(f.calls[0].bin,'osascript');
 assert.deepEqual(f.calls[0].args.slice(-2),['700','owned-session']);
 assert.match(f.calls[0].args[3],/applicationProcesses\.whose\(\{unixId:pid\}\)/);
 assert.match(f.calls[0].args[3],/AXRaise/);
 assert.deepEqual(f.calls[1].args,['--session','owned-session','action','focus-pane-id','terminal_3']);
 assert.deepEqual(f.calls[2].args,['--session','owned-session','action','list-clients']);
 assert.ok(!f.calls.some(c=>c.bin==='open'||c.args.includes('attach')));
 assert.doesNotMatch(JSON.stringify(f.calls),/Alacritty/);
});
test('already-focused Zellij pane is a successful idempotent reveal',async()=>{
 const f=harness();f.failedFocus(new Error('Pane already focused'));await f.reveal.show(target);
 assert.equal(f.calls.length,3);
});
test('other Zellij failures remain errors',async()=>{
 const f=harness();f.failedFocus(new Error('Session unavailable'));
 await assert.rejects(f.reveal.show(target),/Session unavailable/);assert.equal(f.calls.length,2);
});
test('incorrect Zellij readback cannot claim successful focus',async()=>{
 const f=harness();f.wrongPane();await assert.rejects(f.reveal.show(target),/did not become visible/);
});
test('a replacement Zellij frontend cannot acknowledge a view raised in the old host',async()=>{
 const f=harness({zellij:{...host.zellij!,clientId:1}});f.changedClient();
 await assert.rejects(f.reveal.show(target),/did not become visible/);
});
test('multiple attached Zellij clients fail before host activation',async()=>{
 const f=harness({zellij:{...host.zellij!,attachedClientsCount:2}});
 await assert.rejects(f.reveal.show(target),/multiple attached clients/);assert.equal(f.calls.length,0);
});
test('an unavailable or ambiguous native window cannot change server focus',async()=>{
 const f=harness();f.failedApp(new Error('Cannot identify a unique window'));
 await assert.rejects(f.reveal.show(target),/unique window/);assert.equal(f.calls.length,1);
});
test('direct terminal hosts use their verified window title without spawning an app',async()=>{
 const f=harness({zellij:undefined,windowHint:{title:'own Herdr workspace'}});
 await f.reveal.show(target);assert.equal(f.calls.length,1);
 assert.deepEqual(f.calls[0].args.slice(-2),['700','own Herdr workspace']);
});
test('unmapped nested hosts cannot pretend that application activation is enough',async()=>{
 const f=harness({tmux:{socket:'/tmux.sock',paneId:'%1'}});
 await assert.rejects(f.reveal.show(target),/multiple nested host mappings/);assert.equal(f.calls.length,0);
});
test('native reveal cannot substitute the sole window when its session title does not match',async()=>{
 const f=harness();await f.reveal.show(target);
 const script=f.calls[0].args[3];
 let raised=false;
 const window={attributes:{byName:()=>({exists:()=>false})},actions:{byName:()=>({perform:()=>{raised=true;}})}};
 const app={exists:()=>true,windows:Object.assign([window],{name:()=>['another terminal tab']})};
 const context={Application:()=>({applicationProcesses:{whose:()=>[app]}})};
 const run=runInNewContext(`${script}; run`,context);
 assert.throws(()=>run(['700','owned-session']),/unique window/);
 assert.equal(raised,false);
});
test('tmux switches only the discovered attached client and verifies its complete pane route',async()=>{
 const calls:Array<{bin:string,args:string[]}>=[];
 const tmux={socket:'/owned.sock',paneId:'%7',sessionId:'$2',windowId:'@5',clientPid:123,clientTty:'/dev/ttys007'};
 let replacement=false;
 const reveal=new HerdrReveal({discover:async()=>({...host,zellij:undefined,tmux,windowHint:{title:'current tmux context'}}),runner:async(bin,args)=>{
  calls.push({bin,args});return {stdout:args.includes('display-message')?`${replacement?999:123}\t/dev/ttys007\t$2\t@5\t%7\n`:'',stderr:''};
 }});
 await reveal.show(target);
 assert.deepEqual(calls[1],{bin:'tmux',args:['-N','-S','/owned.sock','switch-client','-c','/dev/ttys007','-t','%7']});
 assert.ok(calls[2].args.includes('display-message'));
 assert.ok(!calls.some(c=>c.args.some(a=>/^(attach|new-session|new-window)$/.test(a))));
 replacement=true;await assert.rejects(reveal.show(target),/tmux pane did not become visible/);
});
test('tmux requires validated native window and client metadata before any activation',async()=>{
 const f=harness({zellij:undefined,tmux:{socket:'/owned.sock',paneId:'%7'}});
 await assert.rejects(f.reveal.show(target),/unmapped Herdr tmux/);assert.equal(f.calls.length,0);
});
test('cmux reveals exact inherited window/workspace/surface and verifies global focus',async()=>{
 const cmux={socketPath:'/owned-cmux.sock',windowId:'11111111-1111-1111-1111-111111111111',workspaceId:'22222222-2222-2222-2222-222222222222',surfaceId:'33333333-3333-3333-3333-333333333333'};
 const calls:Array<{bin:string,args:string[]}>=[];
 let wrong=false;
 const reveal=new HerdrReveal({discover:async()=>({...host,zellij:undefined,cmux}),runner:async(bin,args)=>{
  calls.push({bin,args});return {stdout:args.includes('system.identify')?JSON.stringify({focused:{window_id:cmux.windowId,workspace_id:cmux.workspaceId,surface_id:wrong?'other':cmux.surfaceId,surface_type:'terminal'}}):'{}',stderr:''};
 }});
 await reveal.show(target);
 assert.deepEqual(calls.filter(c=>c.args.includes('rpc')).map(c=>c.args[4]),['workspace.select','surface.focus','window.focus','system.identify']);
 assert.deepEqual(JSON.parse(calls[1].args[5]),{workspace_id:cmux.workspaceId,surface_id:cmux.surfaceId});
 assert.ok(calls.filter(c=>c.args.includes('rpc')).every(c=>c.args[1]==='/owned-cmux.sock'));
 assert.deepEqual(calls[3].args.slice(-1),['700']);
 wrong=true;await assert.rejects(reveal.show(target),/cmux surface did not become visible/);
});
test('cmux rejects incomplete inherited identity before mutating any host',async()=>{
 const f=harness({zellij:undefined,cmux:{workspaceId:'workspace:1',surfaceId:'surface:1'}});
 await assert.rejects(f.reveal.show(target),/Invalid Herdr cmux/);assert.equal(f.calls.length,0);
});
