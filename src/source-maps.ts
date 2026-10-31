import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { TraceMap, originalPositionFor } from "@jridgewell/trace-mapping";

/**
 * Turn a minified browser stack back into source positions. The build keeps its maps
 * in build/sourcemaps (scripts/finalize-build.ts), out of what's served.
 *
 * This happens when a report arrives, not when it's read: the maps go away with the
 * release that made them, and the group a report joins depends on the real file names.
 * With no map, as in development or for a page left open across a release, the stack
 * stays as it came.
 */

const DEFAULT_DIR = join("build", "sourcemaps");
const FRAME = /(?:https?:\/\/[^\s/)]+)?\/assets\/([\w.-]+\.js):(\d+):(\d+)/g;
/** A handful of chunks is all a stack touches, and one map can run to megabytes. */
const MAPS_KEPT = 8;

const loaded = new Map<string, TraceMap | null>();

function mapFor(dir: string, file: string): TraceMap | null {
  const path = join(dir, `${file}.map`);
  const hit = loaded.get(path);
  if (hit !== undefined) {
    // Most recently used goes last, so the oldest is first out.
    loaded.delete(path);
    loaded.set(path, hit);
    return hit;
  }
  let map: TraceMap | null = null;
  try {
    if (existsSync(path)) map = new TraceMap(readFileSync(path, "utf8"));
  } catch {
    // A map that won't parse is the same as no map.
  }
  loaded.set(path, map);
  if (loaded.size > MAPS_KEPT) loaded.delete(loaded.keys().next().value!);
  return map;
}

/** Bundler paths climb out of the build first: "../../app/root.tsx". */
const cleanSource = (source: string) => source.replace(/^(?:\.\.?\/)+/, "");

export function mapStack(stack: string, dir: string = DEFAULT_DIR): string {
  return stack.replace(FRAME, (frame, file: string, line: string, column: string) => {
    const map = mapFor(dir, file);
    if (!map) return frame;
    // Browsers count columns from 1; source maps from 0.
    const at = originalPositionFor(map, { line: Number(line), column: Math.max(0, Number(column) - 1) });
    return at.source ? `${cleanSource(at.source)}:${at.line}:${at.column}` : frame;
  });
}
