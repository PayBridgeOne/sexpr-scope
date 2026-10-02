import { test } from "node:test";
import assert from "node:assert/strict";
import { WorkspaceIndex } from "../src/indexer/workspace-index";
import { parseQualifiedName } from "../src/model/symbol";

/** Resolves an unqualified print name as seen from `currentPackage`. */
function resolve(idx: WorkspaceIndex, name: string, pkg: string) {
  return idx.resolveReference(parseQualifiedName(name), pkg);
}

test(":use inherits exported symbols from the used package", () => {
  const idx = new WorkspaceIndex();
  idx.setDocument(
    "file:///common.lisp",
    "(defpackage :common (:use :cl) (:export #:calculate))\n" +
      "(in-package :common)\n(defun calculate () 1)",
  );
  idx.setDocument(
    "file:///app.lisp",
    "(defpackage :app (:use :cl :common))\n(in-package :app)\n(calculate)",
  );

  const defs = resolve(idx, "calculate", "APP");
  assert.equal(defs.length, 1);
  assert.equal(defs[0].package, "COMMON");
  assert.equal(defs[0].name, "CALCULATE");
});

test(":use does not expose internal (unexported) symbols", () => {
  const idx = new WorkspaceIndex();
  idx.setDocument(
    "file:///common.lisp",
    "(defpackage :common (:use :cl) (:export #:calculate))\n" +
      "(in-package :common)\n(defun calculate () 1)\n(defun helper () 2)",
  );
  idx.setDocument(
    "file:///app.lisp",
    "(defpackage :app (:use :cl :common))\n(in-package :app)",
  );

  // CALCULATE is exported and inherited; HELPER is internal and must not leak.
  assert.equal(resolve(idx, "calculate", "APP").length, 1);
  assert.equal(resolve(idx, "helper", "APP").length, 0);
});

test(":import-from resolves to the imported symbol's original definition", () => {
  const idx = new WorkspaceIndex();
  idx.setDocument(
    "file:///db.lisp",
    "(defpackage :database (:use :cl) (:export #:save-record))\n" +
      "(in-package :database)\n(defun save-record (x) x)",
  );
  idx.setDocument(
    "file:///app.lisp",
    "(defpackage :app (:use :cl) (:import-from :database #:save-record))\n" +
      "(in-package :app)\n(save-record 1)",
  );

  const defs = resolve(idx, "save-record", "APP");
  assert.equal(defs.length, 1);
  assert.equal(defs[0].package, "DATABASE");

  const access = idx.packageAccess("APP", "SAVE-RECORD");
  assert.equal(access.status, "present");
  if (access.status === "present") {
    assert.equal(access.via, "import");
    assert.equal(access.imported, true);
    assert.equal(access.homePackage, "DATABASE");
  }
});

test(":import-from can import an internal (unexported) symbol", () => {
  const idx = new WorkspaceIndex();
  idx.setDocument(
    "file:///db.lisp",
    "(defpackage :database (:use :cl))\n(in-package :database)\n(defun secret () 1)",
  );
  idx.setDocument(
    "file:///app.lisp",
    "(defpackage :app (:use :cl) (:import-from :database #:secret))\n" +
      "(in-package :app)\n(secret)",
  );

  // Importing does not require the source symbol be exported.
  const defs = resolve(idx, "secret", "APP");
  assert.equal(defs.length, 1);
  assert.equal(defs[0].package, "DATABASE");
});

test("ambiguous inherited symbols resolve to nothing rather than guessing", () => {
  const idx = new WorkspaceIndex();
  idx.setDocument(
    "file:///a.lisp",
    "(defpackage :alpha (:use :cl) (:export #:process))\n" +
      "(in-package :alpha)\n(defun process () 1)",
  );
  idx.setDocument(
    "file:///b.lisp",
    "(defpackage :beta (:use :cl) (:export #:process))\n" +
      "(in-package :beta)\n(defun process () 2)",
  );
  idx.setDocument(
    "file:///app.lisp",
    "(defpackage :app (:use :cl :alpha :beta))\n(in-package :app)\n(process)",
  );

  assert.equal(resolve(idx, "process", "APP").length, 0);
  const access = idx.packageAccess("APP", "PROCESS");
  assert.equal(access.status, "ambiguous");
  if (access.status === "ambiguous") {
    assert.deepEqual(access.candidatePackages, ["ALPHA", "BETA"]);
  }
});

test(":shadowing-import-from resolves an otherwise ambiguous symbol", () => {
  const idx = new WorkspaceIndex();
  idx.setDocument(
    "file:///a.lisp",
    "(defpackage :alpha (:use :cl) (:export #:process))\n" +
      "(in-package :alpha)\n(defun process () 1)",
  );
  idx.setDocument(
    "file:///b.lisp",
    "(defpackage :beta (:use :cl) (:export #:process))\n" +
      "(in-package :beta)\n(defun process () 2)",
  );
  idx.setDocument(
    "file:///app.lisp",
    "(defpackage :app (:use :cl :alpha :beta)\n" +
      "  (:shadowing-import-from :alpha #:process))\n" +
      "(in-package :app)\n(process)",
  );

  // The shadowing import picks ALPHA's PROCESS and suppresses the conflict.
  const defs = resolve(idx, "process", "APP");
  assert.equal(defs.length, 1);
  assert.equal(defs[0].package, "ALPHA");

  const access = idx.packageAccess("APP", "PROCESS");
  assert.equal(access.status, "present");
  if (access.status === "present") {
    assert.equal(access.via, "shadowing-import");
    assert.equal(access.shadowed, true);
    assert.equal(access.homePackage, "ALPHA");
  }
});

test(":shadow gives a local symbol precedence over inherited ones", () => {
  const idx = new WorkspaceIndex();
  idx.setDocument(
    "file:///other.lisp",
    "(defpackage :other (:use :cl) (:export #:process))\n" +
      "(in-package :other)\n(defun process () 1)",
  );
  idx.setDocument(
    "file:///app.lisp",
    "(defpackage :app (:use :cl :other) (:shadow #:process))\n" +
      "(in-package :app)\n(defun process () 2)\n(process)",
  );

  // The local (shadowing) PROCESS wins over OTHER's exported PROCESS.
  const defs = resolve(idx, "process", "APP");
  assert.equal(defs.length, 1);
  assert.equal(defs[0].package, "APP");

  const access = idx.packageAccess("APP", "PROCESS");
  assert.equal(access.status, "present");
  if (access.status === "present") {
    assert.equal(access.via, "shadow");
    assert.equal(access.shadowed, true);
  }
});

test("inheritance is not transitive across a chain of :use", () => {
  const idx = new WorkspaceIndex();
  idx.setDocument(
    "file:///base.lisp",
    "(defpackage :base (:use :cl) (:export #:root))\n" +
      "(in-package :base)\n(defun root () 1)",
  );
  // MIDDLE uses BASE but does not re-export ROOT.
  idx.setDocument(
    "file:///middle.lisp",
    "(defpackage :middle (:use :cl :base))",
  );
  idx.setDocument(
    "file:///leaf.lisp",
    "(defpackage :leaf (:use :cl :middle))\n(in-package :leaf)\n(root)",
  );

  // LEAF uses MIDDLE, which does not export ROOT, so ROOT is not accessible.
  assert.equal(resolve(idx, "root", "LEAF").length, 0);
});

test("package nicknames are honored in :use and :import-from", () => {
  const idx = new WorkspaceIndex();
  idx.setDocument(
    "file:///db.lisp",
    "(defpackage :database (:use :cl) (:nicknames :db) (:export #:save))\n" +
      "(in-package :database)\n(defun save () 1)",
  );
  idx.setDocument(
    "file:///app.lisp",
    "(defpackage :app (:use :cl :db))\n(in-package :app)\n(save)",
  );

  const defs = resolve(idx, "save", "APP");
  assert.equal(defs.length, 1);
  assert.equal(defs[0].package, "DATABASE");
});

// ---------------------------------------------------------------------------
// Package-aware *definition* identity. A bare definition name denotes a symbol
// the reader already resolved, so a definition and all references to it must
// share one identity even across packages (CLHS symbol resolution precedes the
// definer's effect).
// ---------------------------------------------------------------------------

/** Offset of the name token in the first `(defun <name>` form of a document. */
function defunNameOffset(text: string, name: string): number {
  const i = text.indexOf("(defun " + name);
  if (i === -1) throw new Error(`defun ${name} not found`);
  return i + "(defun ".length;
}

function targetOf(idx: WorkspaceIndex, uri: string, offset: number) {
  const r = idx.resolveAt(uri, offset + 1);
  return r?.target;
}

test("defun of an imported symbol is homed in the exporting package", () => {
  const idx = new WorkspaceIndex();
  idx.setDocument(
    "file:///db.lisp",
    "(defpackage :database (:use :cl) (:export #:save-record))\n" +
      "(in-package :database)\n(defun save-record (x) x)",
  );
  const appText =
    "(defpackage :app (:use :cl) (:import-from :database #:save-record))\n" +
    "(in-package :app)\n(defun save-record (y) y)";
  idx.setDocument("file:///app.lisp", appText);

  const t = targetOf(idx, "file:///app.lisp", defunNameOffset(appText, "save-record"));
  assert.equal(t?.kind, "global");
  if (t?.kind === "global") {
    assert.equal(t.package, "DATABASE");
  }
});

test("defun of a shadowing-imported symbol preserves the imported home", () => {
  const idx = new WorkspaceIndex();
  idx.setDocument(
    "file:///db.lisp",
    "(defpackage :database (:use :cl) (:export #:save-record))\n" +
      "(in-package :database)\n(defun save-record (x) x)",
  );
  const appText =
    "(defpackage :app (:use :cl) (:shadowing-import-from :database #:save-record))\n" +
    "(in-package :app)\n(defun save-record (y) y)";
  idx.setDocument("file:///app.lisp", appText);

  const t = targetOf(idx, "file:///app.lisp", defunNameOffset(appText, "save-record"));
  assert.equal(t?.kind, "global");
  if (t?.kind === "global") {
    assert.equal(t.package, "DATABASE");
  }
});

test("defun of an inherited symbol is homed in the used package", () => {
  const idx = new WorkspaceIndex();
  idx.setDocument(
    "file:///shared.lisp",
    "(defpackage :shared (:use :cl) (:export #:process))\n" +
      "(in-package :shared)\n(defun process (x) x)",
  );
  const appText =
    "(defpackage :app (:use :cl :shared))\n" +
    "(in-package :app)\n(defun process (y) y)";
  idx.setDocument("file:///app.lisp", appText);

  const t = targetOf(idx, "file:///app.lisp", defunNameOffset(appText, "process"));
  assert.equal(t?.kind, "global");
  if (t?.kind === "global") {
    assert.equal(t.package, "SHARED");
  }
});

test("defun after :shadow creates a local identity in the shadowing package", () => {
  const idx = new WorkspaceIndex();
  idx.setDocument(
    "file:///shared.lisp",
    "(defpackage :shared (:use :cl) (:export #:process))\n" +
      "(in-package :shared)\n(defun process (x) x)",
  );
  const appText =
    "(defpackage :app (:use :cl :shared) (:shadow #:process))\n" +
    "(in-package :app)\n(defun process (y) y)";
  idx.setDocument("file:///app.lisp", appText);

  const t = targetOf(idx, "file:///app.lisp", defunNameOffset(appText, "process"));
  assert.equal(t?.kind, "global");
  if (t?.kind === "global") {
    assert.equal(t.package, "APP");
  }
});

test("Find References spans imported definition identity across packages", () => {
  const idx = new WorkspaceIndex();
  const dbText =
    "(defpackage :database (:use :cl) (:export #:save-record))\n" +
    "(in-package :database)\n(defun save-record (x) x)\n(save-record 1)";
  idx.setDocument("file:///db.lisp", dbText);
  const appText =
    "(defpackage :app (:use :cl) (:import-from :database #:save-record))\n" +
    "(in-package :app)\n(save-record 2)";
  idx.setDocument("file:///app.lisp", appText);

  // From the use site in APP, references must include the DATABASE definition
  // and both call sites — one identity across the imported boundary.
  const useOffset = appText.lastIndexOf("save-record");
  const refs = idx.findReferences("file:///app.lisp", useOffset + 1, true);
  const uris = refs.map((r) => r.uri).sort();
  assert.ok(refs.length >= 3, `expected >=3 references, got ${refs.length}`);
  assert.ok(uris.includes("file:///db.lisp"));
  assert.ok(uris.includes("file:///app.lisp"));
});

test("Go to Definition across imported identity lands on the exporting defun", () => {
  const idx = new WorkspaceIndex();
  const dbText =
    "(defpackage :database (:use :cl) (:export #:save-record))\n" +
    "(in-package :database)\n(defun save-record (x) x)";
  idx.setDocument("file:///db.lisp", dbText);
  const appText =
    "(defpackage :app (:use :cl) (:import-from :database #:save-record))\n" +
    "(in-package :app)\n(save-record 2)";
  idx.setDocument("file:///app.lisp", appText);

  const useOffset = appText.lastIndexOf("save-record");
  const t = targetOf(idx, "file:///app.lisp", useOffset);
  assert.equal(t?.kind, "global");
  if (t?.kind === "global") {
    assert.equal(t.package, "DATABASE");
    assert.equal(t.symbols.length, 1);
    assert.equal(t.symbols[0].uri, "file:///db.lisp");
  }
});
