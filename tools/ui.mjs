import { build } from "esbuild";
import fs from "node:fs/promises";
import path from "node:path";

export async function renderPage(root,source=null) {
  root=path.resolve(root);
  const html=source??await fs.readFile(path.join(root,"ui/index.html"),"utf8");
  const marker="<!-- TOKEN_MODULE -->";
  if(html.split(marker).length!==2)throw Error("Missing unique token UI entry.");
  const bundled=await build({
    entryPoints:[path.join(root,"ui/tokens.mjs")],bundle:true,write:false,format:"iife",
    globalName:"CheckinTokens",platform:"browser",target:"es2022",charset:"utf8",
    metafile:true,logLevel:"silent",legalComments:"none"
  });
  const actualRoot=await fs.realpath(root);
  for(const name of Object.keys(bundled.metafile.inputs)){
    const relative=path.relative(actualRoot,await fs.realpath(path.resolve(name)));
    if(relative===".."||relative.startsWith(".."+path.sep)||path.isAbsolute(relative))throw Error("UI import escapes project.");
  }
  if(Object.values(bundled.metafile.outputs).some(output=>output.imports.length))throw Error("UI cannot have runtime imports.");
  const result=html.replace(marker,()=>"<script>\n"+bundled.outputFiles[0].text.replace(/<\/script/gi,"<\\/script")+"\n</script>");
  if(Buffer.byteLength(result)>1024*1024)throw Error("UI exceeds 1 MiB.");
  return result;
}
