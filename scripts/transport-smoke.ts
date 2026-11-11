#!/usr/bin/env bun
/** Real-browser transport regressions. Only fixture-owned daemons/PTYs are used. */
import assert from "node:assert/strict";
import { chromium, type Browser } from "playwright";
import { startTestDaemon } from "./fixtures/daemon";

function submissions(text:string, marker:string):number {
  return text.split("\n").filter(Boolean).map(line=>JSON.parse(line))
    .filter(entry=>entry.message?.role==="user"&&entry.message.content===marker).length;
}

async function until<T>(read: () => Promise<T>, matches: (value:T) => boolean, label:string):Promise<T> {
  const deadline=Date.now()+20_000;
  let value:T;
  do { value=await read(); if(matches(value)) return value; await Bun.sleep(50); } while(Date.now()<deadline);
  throw new Error(`Timed out: ${label}; last=${JSON.stringify(value!)}`);
}

async function uncertainRequest(browser:Browser, mode:"503"|"invalid"|"network") {
  const daemon=await startTestDaemon();
  const context=await browser.newContext();
  try {
    const page=await context.newPage();
    let requests=0; let admittedFile="";
    const marker=`review-before-retry-${mode}`;
    await page.route("**/api/sessions/request",async route=>{
      requests++;
      // Admit on the actual fixture host, then inject a lost/unusable reply.
      const response=await route.fetch();
      assert.equal(response.status(),200,await response.text());
      admittedFile=(await response.json()).runtime.sessionFile;
      if(mode==="503") await route.fulfill({status:503,contentType:"text/plain",body:"request acknowledgement unavailable; it may have been queued. Check the session before sending again."});
      else if(mode==="invalid") await route.fulfill({status:200,contentType:"application/json",body:"{}"});
      else await route.abort("failed");
    });
    await page.goto(daemon.base);
    const input=page.locator('.cold-composer textarea[aria-label="Message this session"]').first();
    await input.waitFor({state:"visible"});
    await until(()=>input.evaluate(el=>!el.closest("[inert]")),Boolean,"application input ready");
    await input.fill(marker); await input.press("Enter");
    const message=await until(()=>page.locator(".cold-composer-status").first().textContent(),v=>Boolean(v&&/preserved/i.test(v)),`${mode} acknowledgement warning`);
    assert.match(message!,/check the session|review/i);
    assert.doesNotMatch(message!,/submit again to retry/i,"uncertain admission must not instruct blind resubmission");
    assert.equal(await input.inputValue(),marker);
    const transcript=await Bun.file(admittedFile).text();
    assert.equal(submissions(transcript,marker),1,"fixture must actually admit the original request once");
    await until(async()=>{
      const payload=await fetch(`${daemon.base}/api/state`).then(r=>r.json());
      return JSON.stringify(payload.state?.layout??null);
    },v=>v.includes(marker),"preserved unconfirmed draft in durable workspace");
    await page.reload();
    await input.waitFor({state:"visible"});
    assert.equal(await input.inputValue(),marker);
    assert.equal(requests,1,"reload must not resubmit an unconfirmed prompt");
    assert.equal(submissions(await Bun.file(admittedFile).text(),marker),1);
    console.log(`ok - ${mode}: real admitted request keeps its draft, advises review, and is not automatically resent`);
  } finally { await context.close(); await daemon.stop(); }
}

async function successfulReconnects(browser:Browser) {
  const daemon=await startTestDaemon();
  const context=await browser.newContext();
  let attachment:WebSocket|undefined;
  try {
    const runtime=(await fetch(`${daemon.base}/api/runtimes`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({cwd:daemon.root})}).then(r=>r.json())).runtime;
    attachment=new WebSocket(`ws://127.0.0.1:${daemon.port}/ws/term?runtime=${runtime.id}`);
    const live=await until(async()=>(await fetch(`${daemon.base}/api/runtimes`).then(r=>r.json())).runtimes.find((r:any)=>r.id===runtime.id),r=>Boolean(r?.alive&&r.sessionFile&&r.status!=="starting"),"fixture runtime ready");
    attachment.close(); attachment=undefined;
    const draft="RECONNECT-REVIEW-ONLY-DRAFT";
    const layout={spaces:[{id:"transport-space",layout:{tree:{kind:"leaf",pane:"transport-pane"},panes:{"transport-pane":{runtimeId:live.id,sessionFile:live.sessionFile,cwd:live.cwd,drafts:{[live.sessionFile]:draft}}},focused:"transport-pane"}}],activeSpaceId:"transport-space"};
    const seeded=await fetch(`${daemon.base}/api/state`,{method:"PUT",headers:{"content-type":"application/json","X-OMP-Generation":daemon.generation},body:JSON.stringify({version:2,savedAt:new Date().toISOString(),layout,pins:[],cellSize:13.33,sidebar:null})});
    assert.equal(seeded.status,200,await seeded.text());
    const page=await context.newPage();
    await page.addInitScript(()=>{
      const Native=window.WebSocket;
      (window as any).transportSockets=[];
      (window as any).WebSocket=class extends Native {
        constructor(url:string|URL,protocols?:string|string[]) {super(url,protocols);if(String(url).includes("/ws/term"))(window as any).transportSockets.push(this);}
      };
    });
    await page.goto(daemon.base);
    const pane=page.locator('.pane[data-pane="transport-pane"]');
    await pane.waitFor();
    await until(()=>pane.locator(".term-host").evaluate(el=>!el.hasAttribute("inert")),Boolean,"initial renderer ready");
    for(let loss=0;loss<6;loss++) {
      const previous=await page.evaluate(()=>{
        const sockets=(window as any).transportSockets as WebSocket[];
        const count=sockets.length; sockets.at(-1)!.close();return count;
      });
      await until(()=>page.evaluate(()=>{
        const sockets=(window as any).transportSockets as WebSocket[];
        const pane=document.querySelector('.pane[data-pane="transport-pane"]');
        return {count:sockets.length,open:sockets.at(-1)?.readyState===1,ready:Boolean(pane?.querySelector('.term-host:not([inert])'))};
      }),v=>v.count>previous&&v.open&&v.ready,`successful automatic reconnect ${loss+1}`);
    }
    const current=(await fetch(`${daemon.base}/api/runtimes`).then(r=>r.json())).runtimes.find((r:any)=>r.id===live.id);
    assert.equal(current.pid,live.pid); assert.equal(current.alive,true);
    const state=(await fetch(`${daemon.base}/api/state`).then(r=>r.json())).state.layout;
    assert.equal(state.spaces[0].layout.panes["transport-pane"].drafts[live.sessionFile],draft);
    assert(!(await Bun.file(live.sessionFile).text()).includes(draft),"reconnection must never submit the retained draft");
    console.log("ok - six successful automatic reconnects preserve the same runtime/PID and unsent draft without submitting it");
  } finally { attachment?.close();await context.close();await daemon.stop(); }
}

const browser=await chromium.launch({headless:true,executablePath:chromium.executablePath()});
try {
  if(!process.argv.includes("--reconnect-only")) for(const mode of ["503","invalid","network"] as const) await uncertainRequest(browser,mode);
  if(!process.argv.includes("--ack-only")) await successfulReconnects(browser);
  console.log("TRANSPORT SMOKE PASSED");
} finally {await browser.close();}
