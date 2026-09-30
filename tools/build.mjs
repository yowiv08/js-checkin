#!/usr/bin/env node
import { build } from "esbuild";
import * as fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { renderPage } from "./ui.mjs";

/** @param {string} root
 * @param {string} file
 * @returns {boolean} */
const within = (root, file) => {
  const relative = path.relative(root, file);
  return relative !== "" && !relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative);
};

/** @param {string} root
 * @param {string} relative
 * @param {number} maximum
 * @returns {Promise<{file: string, data: Buffer}>} */
async function asset(root, relative, maximum) {
  if (typeof relative !== "string" || path.isAbsolute(relative)) throw new Error("Assets must use relative paths.");
  const file = path.resolve(root, relative);
  if (!within(root, file) || !within(await fs.realpath(root), await fs.realpath(file))) throw new Error("Asset escapes the plugin project.");
  const data = await fs.readFile(file);
  if (data.length > maximum) throw new Error("Asset exceeds its package limit.");
  return { file, data };
}

/** @param {string} project
 * @param {string} [destination]
 * @returns {Promise<string>} */
export async function buildPlugin(project, destination) {
  const root = path.resolve(project);
  const manifest = JSON.parse((await asset(root, "plugin.json", 64 * 1024)).data.toString("utf8"));
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(manifest.id ?? "") || manifest.runtime !== "jint")
    throw new Error("A valid id and runtime=jint are required.");
  const output = path.resolve(destination ?? path.join(root, "dist", manifest.id));
  if (output === root || within(output, root)) throw new Error("Output cannot overwrite the source project or its ancestors.");
  const entry = await asset(root, manifest.entry, 2 * 1024 * 1024);
  const bundle = await build({
    entryPoints: [entry.file], bundle: true, write: false, format: "esm", platform: "neutral",
    target: "es2022", metafile: true, charset: "utf8", legalComments: "inline", mainFields: ["module", "main"], logLevel: "silent",
    plugins: [{
      name: "no-node-runtime",
      setup(builder) {
        builder.onResolve({ filter: /^node:/ }, args => ({ errors: [{ text: `Jint has no Node runtime: ${args.path}` }] }));
      }
    }]
  });
  const contents = bundle.outputFiles[0]?.contents;
  if (!contents || contents.length > 2 * 1024 * 1024) throw new Error("Bundle exceeds the 2 MiB host limit.");
  const outputs = Object.values(bundle.metafile.outputs);
  if (outputs.length !== 1 || outputs[0].imports.length) throw new Error("Runtime imports are not supported; produce one self-contained bundle.");
  const handlers = [
    ...Object.values(manifest.hooks ?? {}),
    ...(manifest.platforms ?? []).flatMap(p => Object.values(p.hooks ?? {})),
    ...(manifest.endpoints ?? []).map(e => e.handler),
    ...(manifest.tasks ?? []).map(t => t.handler),
    ...(manifest.jobs ?? []).map(j => j.handler),
    ...Object.values(manifest.streamMappers ?? {}).flatMap(m => [m.event, m.end, m.completion])
  ].filter(Boolean);
  for (const handler of handlers)
    if (!outputs[0].exports.includes(handler)) throw new Error(`Missing declared export: ${handler}`);
  const page = manifest.page?.entry ? await asset(root, manifest.page.entry, 1024 * 1024) : null;
  const pageHtml = page ? await renderPage(root,page.data.toString("utf8")) : null;
  const packaged = { ...manifest, schemaVersion: 1, hostApi: manifest.hostApi ?? "1", format: "esm-bundle", entry: "server/plugin.mjs" };
  if (page) packaged.page = { ...manifest.page, entry: "ui/index.html" };
  await fs.mkdir(path.join(output, "server"), { recursive: true });
  await fs.writeFile(path.join(output, "server", "plugin.mjs"), contents);
  if (page) {
    await fs.mkdir(path.join(output, "ui"), { recursive: true });
    await fs.writeFile(path.join(output, "ui", "index.html"), pageHtml);
  }
  await fs.writeFile(path.join(output, "plugin.json"), JSON.stringify(packaged, null, 2) + "\n");
  return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log(await buildPlugin(process.argv[2] ?? ".", process.argv[3])); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
