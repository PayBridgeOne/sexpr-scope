import { promises as fs } from "fs";
import * as path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { WorkspaceIndex } from "../indexer/workspace-index";

/** File extensions SexprScope reads statically (never evaluates). */
export const SOURCE_EXTENSIONS = new Set([".lisp", ".cl", ".lsp", ".asd"]);

/** Directories never worth scanning for Lisp source. */
export const IGNORED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  "out",
  "build",
]);

export function isSourcePath(name: string): boolean {
  return SOURCE_EXTENSIONS.has(path.extname(name).toLowerCase());
}

export function isSourceUri(uri: string): boolean {
  const fsPath = uriToFsPath(uri);
  return fsPath ? isSourcePath(fsPath) : false;
}

/**
 * Decodes a `file:` URI into a local filesystem path, or undefined.
 *
 * Delegates to Node's `fileURLToPath`, which correctly handles percent-encoding
 * (spaces, Unicode), Windows drive letters (`file:///C:/…`) and UNC authorities
 * (`file://host/share`). Only `file:` URIs are accepted.
 */
export function uriToFsPath(uri: string): string | undefined {
  try {
    const u = new URL(uri);
    if (u.protocol !== "file:") return undefined;
    return fileURLToPath(u);
  } catch {
    return undefined;
  }
}

/**
 * Encodes a local filesystem path as a `file:` URI.
 *
 * Delegates to Node's `pathToFileURL`, which performs the correct per-segment
 * percent-encoding and platform-specific handling (drive letters, UNC paths,
 * separators) that a hand-rolled encoder tends to get wrong.
 */
export function fsPathToUri(fsPath: string): string {
  return pathToFileURL(path.resolve(fsPath)).href;
}

/**
 * Recursively discovers and statically indexes every Lisp source file under
 * `roots`.
 *
 * Files are only READ as text — never evaluated. A URI already present in the
 * index (e.g. an open editor buffer) is left untouched so unsaved edits are
 * never clobbered by the on-disk copy.
 */
export async function scanRoots(
  roots: readonly string[],
  index: WorkspaceIndex,
  isOpen: (uri: string) => boolean,
): Promise<void> {
  for (const root of roots) {
    await scanDirectory(root, index, isOpen);
  }
}

async function scanDirectory(
  dir: string,
  index: WorkspaceIndex,
  isOpen: (uri: string) => boolean,
): Promise<void> {
  let entries: import("fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(entry.name)) continue;
      await scanDirectory(full, index, isOpen);
    } else if (entry.isFile() && isSourcePath(entry.name)) {
      const uri = fsPathToUri(full);
      if (isOpen(uri) || index.hasDocument(uri)) continue;
      try {
        const text = await fs.readFile(full, "utf8");
        index.setDocument(uri, text);
      } catch {
        // Unreadable file: skip silently, stay tolerant.
      }
    }
  }
}

/**
 * Re-indexes a single document from its on-disk content, or drops it from the
 * index if it can no longer be read. Used for incremental file-change events.
 */
export async function reindexUriFromDisk(
  uri: string,
  index: WorkspaceIndex,
): Promise<void> {
  const fsPath = uriToFsPath(uri);
  if (!fsPath) return;
  try {
    const text = await fs.readFile(fsPath, "utf8");
    index.setDocument(uri, text);
  } catch {
    index.removeDocument(uri);
  }
}
