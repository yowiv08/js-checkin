import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPlugin } from "./tools/build.mjs";

test("发行包仅清单、单个 ESM、自包含页面，静态构建不调用签到 hook",async()=>{
  const root=path.dirname(fileURLToPath(import.meta.url));
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),"js-checkin-build-"));
  try{
    const output=await buildPlugin(root,path.join(temp,"js-checkin"));
    assert.deepEqual((await fs.readdir(output)).sort(),["plugin.json","server","ui"]);
    assert.deepEqual(await fs.readdir(path.join(output,"server")),["plugin.mjs"]);
    assert.deepEqual(await fs.readdir(path.join(output,"ui")),["index.html"]);
    const manifest=JSON.parse(await fs.readFile(path.join(output,"plugin.json"),"utf8"));
    assert.equal(manifest.entry,"server/plugin.mjs");assert.equal(manifest.runtime,"jint");
    assert.equal(manifest.jobs[0].handler,"checkInJob");assert.equal(manifest.tasks[0].cron,"0 10 10 * * *");
    assert.ok(manifest.endpoints.some(e=>e.path==="balance/start"));
    assert.ok(manifest.endpoints.some(e=>e.path==="schedule/preview"));
    assert.ok(manifest.endpoints.every(e=>e.auth==="AdminSession"));
    const code=await fs.readFile(path.join(output,manifest.entry),"utf8");
    assert.doesNotMatch(code,/\b(?:import|require)\s*\(|from\s*["']|node:|process\.|globalThis\.fetch/);
    assert.match(await fs.readFile(path.join(output,"ui/index.html"),"utf8"),/JSON/);
    await assert.rejects(buildPlugin(root,root),/overwrite/);
  }finally{
    const resolved=path.resolve(temp);
    if(!resolved.startsWith(path.resolve(os.tmpdir())+path.sep)||!path.basename(resolved).startsWith("js-checkin-build-"))throw Error("Unsafe temporary cleanup");
    await fs.rm(resolved,{recursive:true,force:true});
  }
});
