import { test } from "node:test";
import assert from "node:assert/strict";
import { WorkspaceIndex } from "../src/indexer/workspace-index";
import { DiagnosticInfo } from "../src/model/diagnostic";

function diagnose(docs: Record<string, string>, target: string): DiagnosticInfo[] {
  const idx = new WorkspaceIndex();
  for (const [name, text] of Object.entries(docs)) {
    idx.setDocument(`file:///${name}`, text);
  }
  return idx.diagnostics(`file:///${target}`);
}

function codes(ds: DiagnosticInfo[]): string[] {
  return ds.map((d) => d.code);
}

// --- Positive cases: diagnostics that can be statically established. ---

test("an unknown explicit package is diagnosed", () => {
  const ds = diagnose(
    { a: `(in-package :cl-user)
(defun r () (nosuch:foo))` },
    "a",
  );
  assert.ok(codes(ds).includes("unknown-package"));
});

test("a non-exported external access is diagnosed", () => {
  const ds = diagnose(
    {
      a: `(defpackage :payment (:use :cl) (:export #:authorize))
(in-package :payment)
(defun authorize () 1)
(defun secret () 2)`,
      b: `(in-package :cl-user)
(defun r () (payment:secret))`,
    },
    "b",
  );
  assert.ok(codes(ds).includes("not-exported"));
});

test("an ambiguously inherited symbol is diagnosed", () => {
  const ds = diagnose(
    {
      a: `(defpackage :alpha (:use :cl) (:export #:ambi))
(in-package :alpha)
(defun ambi () 1)`,
      b: `(defpackage :beta (:use :cl) (:export #:ambi))
(in-package :beta)
(defun ambi () 1)`,
      c: `(defpackage :app (:use :cl :alpha :beta))
(in-package :app)
(defun r () (ambi))`,
    },
    "c",
  );
  assert.ok(codes(ds).includes("ambiguous-symbol"));
});

test("a clearly invalid duplicate binding is diagnosed", () => {
  const ds = diagnose(
    { a: `(in-package :cl-user)
(defun f (x x) x)` },
    "a",
  );
  assert.ok(codes(ds).includes("duplicate-binding"));
});

// --- Negative cases: never diagnose what cannot be statically proven. ---

test("an unknown runtime-defined function is not diagnosed", () => {
  const ds = diagnose(
    { a: `(in-package :cl-user)
(defun r () (runtime-generated-function 1))` },
    "a",
  );
  assert.deepEqual(ds, []);
});

test("an unknown value possibly established dynamically is not diagnosed", () => {
  const ds = diagnose(
    { a: `(in-package :cl-user)
(defun r () (list *dynamic-value*))` },
    "a",
  );
  assert.deepEqual(ds, []);
});

test("valid lexical shadowing is not diagnosed", () => {
  const ds = diagnose(
    { a: `(in-package :cl-user)
(defvar total 0)
(defun r (total) total)` },
    "a",
  );
  assert.deepEqual(ds, []);
});

test("a valid LET* rebinding is not diagnosed", () => {
  const ds = diagnose(
    { a: `(in-package :cl-user)
(defun r () (let* ((x 1) (x (+ x 1))) x))` },
    "a",
  );
  assert.deepEqual(ds, []);
});

test("valid package-qualified internal access with :: is not diagnosed", () => {
  const ds = diagnose(
    {
      a: `(defpackage :payment (:use :cl) (:export #:authorize))
(in-package :payment)
(defun secret () 2)`,
      b: `(in-package :cl-user)
(defun r () (payment::secret))`,
    },
    "b",
  );
  assert.deepEqual(ds, []);
});

test("diagnostics carry a range, severity, code and source", () => {
  const ds = diagnose(
    { a: `(in-package :cl-user)
(defun r () (nosuch:foo))` },
    "a",
  );
  const d = ds.find((x) => x.code === "unknown-package");
  assert.ok(d);
  assert.equal(d!.source, "sexpr-scope");
  assert.equal(d!.severity, "warning");
  assert.ok(d!.range.end.offset > d!.range.start.offset);
  assert.ok(d!.message.length > 0);
});

test("a cross-file package export change removes a stale diagnostic", () => {
  const idx = new WorkspaceIndex();
  idx.setDocument(
    "file:///pkg.lisp",
    `(defpackage :payment (:use :cl))
(in-package :payment)
(defun secret () 2)`,
  );
  idx.setDocument(
    "file:///client.lisp",
    `(in-package :cl-user)
(defun r () (payment:secret))`,
  );
  // secret is not exported yet → diagnosed.
  assert.ok(
    idx.diagnostics("file:///client.lisp").some((d) => d.code === "not-exported"),
  );
  // Exporting it in the other file clears the diagnostic.
  idx.setDocument(
    "file:///pkg.lisp",
    `(defpackage :payment (:use :cl) (:export #:secret))
(in-package :payment)
(defun secret () 2)`,
  );
  assert.deepEqual(idx.diagnostics("file:///client.lisp"), []);
});
