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
