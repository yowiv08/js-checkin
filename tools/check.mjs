import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";
import assert from "node:assert/strict";
import ts from "typescript";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const manifestText=await fs.readFile(path.join(root,"plugin.json"),"utf8");
const manifest=JSON.parse(manifestText);
const metadata=JSON.parse(await fs.readFile(path.join(root,"package.json"),"utf8"));
const lock=JSON.parse(await fs.readFile(path.join(root,"package-lock.json"),"utf8"));
assert.equal(metadata.version,manifest.version,"package.json 与插件版本不一致");
assert.equal(lock.version,manifest.version,"package-lock.json 与插件版本不一致");
assert.equal(lock.packages[""].version,manifest.version,"依赖锁根版本不一致");
const virtual=path.join(root,".manifest.check.ts");
const source=`import type { PluginManifest } from "./sdk/index";\nconst manifest: PluginManifest = ${manifestText};\nexport default manifest;`;
const options={noEmit:true,allowJs:true,checkJs:true,strict:false,target:ts.ScriptTarget.ES2022,
  module:ts.ModuleKind.ESNext,moduleResolution:ts.ModuleResolutionKind.Bundler,lib:["lib.es2022.d.ts"],types:[]};
const host=ts.createCompilerHost(options),original=host.getSourceFile.bind(host);
host.getSourceFile=(file,languageVersion,onError,fresh)=>path.resolve(file)===virtual
  ?ts.createSourceFile(file,source,languageVersion,true):original(file,languageVersion,onError,fresh);
const files=(await fs.readdir(path.join(root,"src"))).filter(n=>n.endsWith(".mjs")).map(n=>path.join(root,"src",n));
const program=ts.createProgram([...files,virtual],options,host);
const diagnostics=ts.getPreEmitDiagnostics(program);
if(diagnostics.length){console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics,{
  getCanonicalFileName:f=>f,getCurrentDirectory:()=>root,getNewLine:()=>"\n"}));process.exitCode=1;}
else{
  const checker=program.getTypeChecker(),entry=program.getSourceFile(path.join(root,manifest.entry));
  const exports=new Set(checker.getExportsOfModule(checker.getSymbolAtLocation(entry)).map(s=>s.name));
  const handlers=[...Object.values(manifest.hooks),...manifest.endpoints.map(e=>e.handler),...manifest.tasks.map(t=>t.handler),...manifest.jobs.map(j=>j.handler)];
  for(const name of handlers)assert.ok(exports.has(name),`清单导出缺失：${name}`);
  for(const file of files){
    const parsed=program.getSourceFile(file);
    function inspect(node){
      if(ts.isImportDeclaration(node))assert.ok(node.moduleSpecifier.text.startsWith("./"),"生产仅允许相对的纯 JS 模块依赖");
      if(ts.isIdentifier(node))assert.ok(!["fetch","process","require","window","document","eval","Function","setInterval","setTimeout"].includes(node.text),`生产代码禁止依赖 ${node.text}`);
      ts.forEachChild(node,inspect);
    }
    inspect(parsed);
  }
  const html=await fs.readFile(path.join(root,manifest.page.entry),"utf8");
  assert.ok(html.includes(`<span class="tag">v${manifest.version}</span>`),"页面与插件版本不一致");
  const scripts=[...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)];
  for(const [index,script]of scripts.entries())new Script(script[1],{filename:`ui/index.html#${index}`});
  for(const doc of ["README.md"]){
    const content=await fs.readFile(path.join(root,doc),"utf8");
    for(const match of content.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)){
      const href=match[1];if(/^[a-z][\w+.-]*:/i.test(href)||href.startsWith("#"))continue;
      await fs.access(path.resolve(root,href.split("#")[0]));
    }
  }
  console.log(`检查通过：${files.length} 个 JS 模块、Host API 类型、版本、清单导出、页面脚本及文档链接。`);
}
