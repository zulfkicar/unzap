import { writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname, relative, isAbsolute } from "node:path";
import { gunzipSync } from "node:zlib";
import { compile } from "./migration.js";
import { bundle } from "./bundle.js";
function definitionFrom(analysis) {
  if (!analysis.compilable)
    throw Error("This workflow has unresolved conversion issues");
  return (
    analysis.definition || {
      name: "Imported workflow",
      source_hash: analysis.spec.source_hash,
      bindings: analysis.spec.bindings,
      steps: analysis.spec.steps.map((s) => ({
        ...s,
        source_action: s.action,
        source_app: s.app,
      })),
    }
  );
}
export function emitWorkflow(analysis) {
  return compile(definitionFrom(analysis));
}
export async function writeProject(analysis, directory) {
  const root = resolve(directory),
    archive = gunzipSync(await bundle(definitionFrom(analysis)));
  await mkdir(root, { recursive: true });
  // Only our own archive is unpacked here. Uploaded archives are never accepted.
  for (let i = 0; i < archive.length - 512;) {
    const header = archive.subarray(i, i + 512),
      name = header.subarray(0, 100).toString().split("\0")[0];
    if (!name) break;
    const size = parseInt(
        header.subarray(124, 136).toString().replaceAll("\0", "").trim(),
        8,
      ),
      path = resolve(root, name),
      rel = relative(root, path);
    if (
      rel.startsWith("..") ||
      isAbsolute(rel) ||
      !Number.isSafeInteger(size) ||
      size < 0
    )
      throw Error("Invalid generated archive entry.");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, archive.subarray(i + 512, i + 512 + size));
    i += 512 + Math.ceil(size / 512) * 512;
  }
  return root;
}
