import {test,before,after} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {fileURLToPath} from "node:url";
import {createHash} from "node:crypto";
import {execFileSync,spawnSync} from "node:child_process";
import {buildPlugin} from "./tools/build.mjs";

const root=path.dirname(fileURLToPath(import.meta.url));
const script=path.join(root,"package-release.ps1");
const pwsh=process.env.PWSH_PATH||"pwsh";
const hash=data=>createHash("sha256").update(data).digest("hex");
let temp,input,manifest,serial=0;
const output=()=>path.join(temp,`output-${++serial}`);
function invoke(destination,tag="v0.1.0",source=input,tool=script){
  const args=["-NoProfile","-NonInteractive","-File",tool,"-InputDirectory",source,"-OutputDirectory",destination];
  if(tag!==null)args.push("-Tag",tag);
  return spawnSync(pwsh,args,{encoding:"utf8",windowsHide:true,maxBuffer:4*1024*1024,timeout:60000});
}
function succeeded(result){assert.ifError(result.error);assert.equal(result.status,0,result.stderr||result.stdout)}
function rejected(result,pattern){assert.ifError(result.error);assert.notEqual(result.status,0);assert.match(result.stderr+result.stdout,pattern)}
const readIndex=async directory=>JSON.parse(await fs.readFile(path.join(directory,"release-index.json"),"utf8"));
async function copyPackage(){
  const directory=path.join(temp,`copy-${++serial}`,"js-checkin");
  await fs.cp(input,directory,{recursive:true});return directory;
}
before(async()=>{
  execFileSync(pwsh,["-NoProfile","-NonInteractive","-Command","if ($PSVersionTable.PSVersion.Major -lt 7) { exit 1 }"],{windowsHide:true});
  temp=await fs.mkdtemp(path.join(os.tmpdir(),"js-checkin-release-"));
  input=await buildPlugin(root,path.join(temp,"built","js-checkin"));
  manifest=JSON.parse(await fs.readFile(path.join(input,"plugin.json"),"utf8"));
});
after(async()=>{
  if(!temp)return;
  const resolved=path.resolve(temp);
  if(!resolved.startsWith(path.resolve(os.tmpdir())+path.sep)||!path.basename(resolved).startsWith("js-checkin-release-"))
    throw Error("Unsafe temporary cleanup");
  await fs.rm(resolved,{recursive:true,force:true});
});

test("实际生成 ZIP、索引、SHA256 与功能介绍，符合 Router2API 发行协议",async()=>{
  const out=output();succeeded(invoke(out));
  assert.deepEqual((await fs.readdir(out)).sort(),["js-checkin.zip","js-checkin.zip.sha256","release-index.json","release-notes.md"]);
  const index=await readIndex(out);
  assert.equal(index.schemaVersion,1);assert.equal(index.tag,"v0.1.0");assert.equal(index.plugins.length,1);
  const entry=index.plugins[0],zip=await fs.readFile(path.join(out,"js-checkin.zip"));
  for(const key of ["id","name","description","version","runtime"])assert.equal(entry[key],manifest[key]);
  assert.equal(entry.asset,"js-checkin.zip");assert.equal(entry.sha256,hash(zip));assert.equal(entry.sizeBytes,zip.length);
  assert.equal((await fs.readFile(path.join(out,"js-checkin.zip.sha256"),"utf8")).trim(),`${entry.sha256}  js-checkin.zip`);
  const files=["plugin.json","server/plugin.mjs","ui/index.html"],content=[];
  for(const file of files)content.push(`${file} ${hash(await fs.readFile(path.join(input,file)))}`);
  assert.equal(entry.contentSha256,hash(content.join("\n")));
  assert.notEqual((await fs.readFile(path.join(out,"release-index.json"))).subarray(0,3).toString("hex"),"efbbbf");
  const notes=await fs.readFile(path.join(out,"release-notes.md"),"utf8");
  assert.match(notes,/中转站签到/);assert.ok(notes.includes(manifest.description));assert.doesNotMatch(notes,/[（(][^）)]*[）)]/);
  const readZip=`
    $ErrorActionPreference = 'Stop'
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead($env:TEST_RELEASE_ZIP)
    try {
      $files = @(foreach ($entry in $zip.Entries) {
        if (-not $entry.Name) { continue }
        $stream = $entry.Open(); $buffer = [IO.MemoryStream]::new()
        try { $stream.CopyTo($buffer); @{ name = $entry.FullName.Replace('\\','/'); content = [Convert]::ToBase64String($buffer.ToArray()) } }
        finally { $stream.Dispose(); $buffer.Dispose() }
      })
      ConvertTo-Json -InputObject $files -Compress
    } finally { $zip.Dispose() }
  `;
  const entries=JSON.parse(execFileSync(pwsh,["-NoProfile","-NonInteractive","-Command",readZip],{
    encoding:"utf8",windowsHide:true,maxBuffer:4*1024*1024,env:{...process.env,TEST_RELEASE_ZIP:path.join(out,"js-checkin.zip")}
  }));
  assert.deepEqual(entries.map(e=>e.name).sort(),files.map(f=>"js-checkin/"+f));
  for(const entry of entries)assert.deepEqual(Buffer.from(entry.content,"base64"),await fs.readFile(path.join(input,entry.name.slice(11))));
});
test("默认 tag 来自清单；显式 Release tag 与插件版本独立",async()=>{
  const a=output(),b=output();succeeded(invoke(a,null));succeeded(invoke(b,"v0.2.0"));
  assert.equal((await readIndex(a)).tag,`v${manifest.version}`);
  const index=await readIndex(b);assert.equal(index.tag,"v0.2.0");assert.equal(index.plugins[0].version,manifest.version);
});
test("contentSha256 不受文件时间戳和 Release tag 影响，文件内容变化则改变",async()=>{
  const source=await copyPackage(),a=output(),b=output(),c=output();
  succeeded(invoke(a,"v0.1.0",source));
  const file=path.join(source,"ui/index.html");await fs.utimes(file,new Date("2020-01-01"),new Date("2020-01-01"));
  succeeded(invoke(b,"v0.1.1",source));
  assert.equal((await readIndex(a)).plugins[0].contentSha256,(await readIndex(b)).plugins[0].contentSha256);
  await fs.appendFile(file,"\n<!-- changed -->\n");succeeded(invoke(c,"v0.1.2",source));
  assert.notEqual((await readIndex(a)).plugins[0].contentSha256,(await readIndex(c)).plugins[0].contentSha256);
});
test("拒绝无效 tag，不解释 tag 中的命令字符",async()=>{
  for(const tag of ["main","v0.1","v0.1.0-rc.1","../v0.1.0",'v0.1.0;Write-Output INJECTED']){
    const out=output();rejected(invoke(out,tag),/Tag 必须/);await assert.rejects(fs.access(out));
  }
});
test("默认构建目录缺失时失败；输出目录不允许包含输入或被输入包含",async()=>{
  rejected(invoke(output(),"v0.1.0",path.join(temp,"missing")) ,/未找到构建目录/);
  rejected(invoke(input),/不能相互包含/);
  rejected(invoke(path.join(input,"release")),/不能相互包含/);
  rejected(invoke(path.dirname(input)),/不能相互包含/);
});
test("输出目录非空时拒绝覆盖和清理",async()=>{
  const out=output();await fs.mkdir(out);await fs.writeFile(path.join(out,"keep.txt"),"keep");
  rejected(invoke(out),/输出目录不为空/);
  assert.deepEqual(await fs.readdir(out),["keep.txt"]);assert.equal(await fs.readFile(path.join(out,"keep.txt"),"utf8"),"keep");
});
test("缺少文件、额外文件和隐藏文件均不得打入发行包",async()=>{
  const missing=await copyPackage();await fs.unlink(path.join(missing,"ui/index.html"));
  rejected(invoke(output(),"v0.1.0",missing),/不完整/);
  for(const name of ["accounts.json",".env"]){
    const source=await copyPackage();await fs.writeFile(path.join(source,name),"DO_NOT_PACKAGE");
    const out=output();rejected(invoke(out,"v0.1.0",source),/额外文件/);await assert.rejects(fs.access(out));
  }
});
test("拒绝无效清单身份、运行时、入口与空描述",async()=>{
  for(const change of [{id:"other"},{runtime:"node"},{entry:"src/plugin.mjs"},{description:" "},{version:"bad"}]){
    const source=await copyPackage();await fs.writeFile(path.join(source,"plugin.json"),JSON.stringify({...manifest,...change}));
    const out=output();rejected(invoke(out,"v0.1.0",source),/清单|插件 ID/);await assert.rejects(fs.access(out));
  }
});
test("拒绝符号链接目录",async()=>{
  const parent=path.join(temp,"linked");await fs.mkdir(parent);
  const link=path.join(parent,"js-checkin");
  await fs.symlink(input,link,process.platform==="win32"?"junction":"dir");
  rejected(invoke(output(),"v0.1.0",link),/符号链接/);
});
test("支持按 tag 附加发布说明",async()=>{
  const project=path.join(temp,"notes-project"),notes=path.join(project,"release-notes");
  await fs.mkdir(notes,{recursive:true});await fs.copyFile(script,path.join(project,"package-release.ps1"));
  await fs.writeFile(path.join(notes,"v0.3.0.md"),"## 新增功能\n\nGitHub 自动打包\n");
  const out=output();succeeded(invoke(out,"v0.3.0",input,path.join(project,"package-release.ps1")));
  assert.match(await fs.readFile(path.join(out,"release-notes.md"),"utf8"),/## 新增功能\n\nGitHub 自动打包/);
});
test("工作流使用本项目构建，tag 发布、手动仅打包，发布权限分离",async()=>{
  const workflow=await fs.readFile(path.join(root,".github/workflows/release-plugins.yml"),"utf8");
  assert.match(workflow,/push:\s+tags: \['v\*'\]/);assert.match(workflow,/workflow_dispatch:/);
  assert.match(workflow,/node-version: '24'/);assert.match(workflow,/cache-dependency-path: package-lock\.json/);
  for(const command of ["npm ci","npm run check","npm test","npm run test:build","npm run test:release","npm run build","./package-release.ps1 -Tag $tag"])
    assert.ok(workflow.includes(command),command);
  assert.match(workflow,/permissions:\s+contents: read/);
  assert.match(workflow,/publish:\s+if: github\.event_name == 'push' && startsWith\(github\.ref, 'refs\/tags\/v'\)/);
  assert.match(workflow,/needs: build/);assert.match(workflow,/contents: write/);
  assert.match(workflow,/actions\/upload-artifact@v4/);assert.match(workflow,/actions\/download-artifact@v4/);
  assert.match(workflow,/gh release create "\$RELEASE_TAG"/);assert.match(workflow,/--verify-tag/);
  assert.match(workflow,/--notes-file artifacts\/release\/release-notes\.md --draft/);
  assert.match(workflow,/gh release edit "\$RELEASE_TAG" --draft=false/);
  assert.doesNotMatch(workflow,/pull_request_target|sdk\/js|plugins\/\*|--clobber|npm.*test:browser/);
});
