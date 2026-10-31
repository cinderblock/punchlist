/**
 * Post-build step: stamp the service worker with this build.
 *
 * The worker must change whenever the app does — browsers only install a new
 * worker when its bytes differ — and it needs the list of files to keep for
 * offline use. Both come from the built asset names, which Vite already
 * content-hashes.
 *
 *   bun scripts/finalize-build.ts          (run by `bun run build`)
 */
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";

const CLIENT = "build/client";
const SOURCE_MAPS = "build/sourcemaps";
const PLACEHOLDER = "self.__PL_PRECACHE__";

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
}

const toUrl = (file: string) => `/${relative(CLIENT, file).split(sep).join("/")}`;

const files = (await walk(CLIENT))
  .map(toUrl)
  .filter((url) => url.startsWith("/assets/") || url.startsWith("/icons/"))
  // Source maps are for developers, not for offline use.
  .filter((url) => !url.endsWith(".map"))
  .sort();

if (!files.some((f) => f.startsWith("/assets/"))) {
  throw new Error(`No built assets under ${CLIENT}/assets — run the React Router build first.`);
}

const buildId = createHash("sha256").update(files.join("\n")).digest("hex").slice(0, 16);

const swPath = join(CLIENT, "sw.js");
const source = await readFile(swPath, "utf8");
if (!source.includes(PLACEHOLDER)) {
  throw new Error(`${swPath} has no ${PLACEHOLDER} placeholder (already stamped?).`);
}
await writeFile(swPath, source.replace(PLACEHOLDER, JSON.stringify({ buildId, urls: files })));


// Maps turn a minified stack from a browser back into source (src/source-maps.ts). The
// server reads them; nothing needs to fetch them.
const maps = (await walk(CLIENT)).filter((file) => file.endsWith(".map"));
await mkdir(SOURCE_MAPS, { recursive: true });
for (const map of maps) await rename(map, join(SOURCE_MAPS, basename(map)));

console.log(`Service worker stamped: build ${buildId}, ${files.length} files to keep offline, ${maps.length} source maps set aside.`);
