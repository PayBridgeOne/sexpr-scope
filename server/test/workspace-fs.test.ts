import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { WorkspaceIndex } from "../src/indexer/workspace-index";
import {
  fsPathToUri,
  isSourcePath,
  isSourceUri,
  reindexUriFromDisk,
  scanRoots,
  uriToFsPath,
} from "../src/lsp/workspace-fs";

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "sexpr-scope-"));
}

async function write(dir: string, rel: string, text: string): Promise<string> {
  const full = path.join(dir, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, text, "utf8");
  return full;
}

const NEVER_OPEN = () => false;

test("isSourcePath recognizes Lisp source extensions only", () => {
  assert.equal(isSourcePath("foo.lisp"), true);
  assert.equal(isSourcePath("foo.cl"), true);
  assert.equal(isSourcePath("foo.lsp"), true);
  assert.equal(isSourcePath("system.asd"), true);
  assert.equal(isSourcePath("foo.LISP"), true);
  assert.equal(isSourcePath("readme.md"), false);
  assert.equal(isSourcePath("script.js"), false);
});

test("uriToFsPath / fsPathToUri round-trip a path with spaces", () => {
  const p = path.join(os.tmpdir(), "a dir", "my file.lisp");
  const uri = fsPathToUri(p);
  assert.equal(uriToFsPath(uri), path.resolve(p));
});

test("fsPathToUri percent-encodes spaces and Unicode", () => {
  const uri = fsPathToUri("/tmp/a dir/café.lisp");
  // A space must be encoded, never left literal, and the URI must be a file URI.
  assert.ok(uri.startsWith("file:///"));
  assert.ok(!uri.includes(" "), uri);
  assert.ok(uri.includes("%20"), uri);
});

test("uriToFsPath / fsPathToUri round-trip a Unicode path", () => {
  const p = path.join(os.tmpdir(), "проект", "café.lisp");
  const uri = fsPathToUri(p);
  assert.equal(uriToFsPath(uri), path.resolve(p));
});

test("uriToFsPath / fsPathToUri round-trip a path with special URI characters", () => {
  const p = path.join(os.tmpdir(), "a#b", "c%d e.lisp");
  const uri = fsPathToUri(p);
  assert.equal(uriToFsPath(uri), path.resolve(p));
});

test("uriToFsPath decodes a percent-encoded file URI", () => {
  assert.equal(uriToFsPath("file:///tmp/a%20b/c.lisp"), "/tmp/a b/c.lisp");
});

test("uriToFsPath rejects non-file and malformed URIs", () => {
  assert.equal(uriToFsPath("http://example.com/a.lisp"), undefined);
  assert.equal(uriToFsPath("not a uri"), undefined);
  assert.equal(uriToFsPath("untitled:Untitled-1"), undefined);
});

test("fsPathToUri parses a Windows drive-letter URI back to a path", () => {
  // Node's URL handling keeps drive-letter file URIs well-formed on every
  // platform; the decoded form always carries the colon after the drive.
  const fsPath = uriToFsPath("file:///C:/work/app.lisp");
  assert.ok(fsPath && fsPath.includes("C:"), String(fsPath));
});

test("isSourceUri honors the decoded extension", () => {
  assert.equal(isSourceUri(fsPathToUri("/x/y.lisp")), true);
  assert.equal(isSourceUri(fsPathToUri("/x/y.txt")), false);
  assert.equal(isSourceUri("http://example.com/y.lisp"), false);
});

test("scanRoots statically indexes every Lisp file under the root", async () => {
  const dir = await tempDir();
  try {
    const a = await write(dir, "a.lisp", "(defun foo () 1)");
    const b = await write(dir, "sub/b.cl", "(defun bar () 2)");
    await write(dir, "notes.md", "not lisp");

    const index = new WorkspaceIndex();
    await scanRoots([dir], index, NEVER_OPEN);

    assert.ok(index.hasDocument(fsPathToUri(a)));
    assert.ok(index.hasDocument(fsPathToUri(b)));
    assert.equal(
      index.allSymbols().filter((s) => s.name === "FOO").length,
      1,
    );
    assert.equal(
      index.allSymbols().filter((s) => s.name === "BAR").length,
      1,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("scanRoots skips ignored directories", async () => {
  const dir = await tempDir();
  try {
    await write(dir, "node_modules/dep.lisp", "(defun dep () 1)");
    await write(dir, ".git/hook.lisp", "(defun hook () 1)");
    await write(dir, "keep.lisp", "(defun keep () 1)");

    const index = new WorkspaceIndex();
    await scanRoots([dir], index, NEVER_OPEN);

    assert.equal(index.documentUris.length, 1);
    assert.ok(
      index.documentUris[0].endsWith("keep.lisp"),
      index.documentUris[0],
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("scanRoots leaves open buffers untouched", async () => {
  const dir = await tempDir();
  try {
    const file = await write(dir, "a.lisp", "(defun on-disk () 1)");
    const uri = fsPathToUri(file);

    const index = new WorkspaceIndex();
    index.setDocument(uri, "(defun in-buffer () 1)");

    await scanRoots([dir], index, (u) => u === uri);

    // The open-buffer content must win over the on-disk copy.
    assert.equal(
      index.allSymbols().filter((s) => s.name === "IN-BUFFER").length,
      1,
    );
    assert.equal(
      index.allSymbols().filter((s) => s.name === "ON-DISK").length,
      0,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("reindexUriFromDisk refreshes a modified file", async () => {
  const dir = await tempDir();
  try {
    const file = await write(dir, "a.lisp", "(defun first-def () 1)");
    const uri = fsPathToUri(file);

    const index = new WorkspaceIndex();
    await reindexUriFromDisk(uri, index);
    assert.equal(
      index.allSymbols().filter((s) => s.name === "FIRST-DEF").length,
      1,
    );

    await fs.writeFile(file, "(defun second-def () 2)", "utf8");
    await reindexUriFromDisk(uri, index);
    assert.equal(
      index.allSymbols().filter((s) => s.name === "FIRST-DEF").length,
      0,
    );
    assert.equal(
      index.allSymbols().filter((s) => s.name === "SECOND-DEF").length,
      1,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("reindexUriFromDisk drops a deleted file from the index", async () => {
  const dir = await tempDir();
  try {
    const file = await write(dir, "a.lisp", "(defun gone () 1)");
    const uri = fsPathToUri(file);

    const index = new WorkspaceIndex();
    await reindexUriFromDisk(uri, index);
    assert.ok(index.hasDocument(uri));

    await fs.rm(file);
    await reindexUriFromDisk(uri, index);
    assert.equal(index.hasDocument(uri), false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("scanRoots tolerates a non-existent root without throwing", async () => {
  const index = new WorkspaceIndex();
  await scanRoots(["/no/such/path/sexpr-scope-missing"], index, NEVER_OPEN);
  assert.equal(index.documentUris.length, 0);
});
