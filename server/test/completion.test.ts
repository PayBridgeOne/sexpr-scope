import { test } from "node:test";
import assert from "node:assert/strict";
import { WorkspaceIndex } from "../src/indexer/workspace-index";
import { Namespace } from "../src/model/symbol";
import { CompletionCandidate } from "../src/model/intelligence";

/**
 * Splits a source string containing a single `|` cursor marker into the source
 * without the marker and the byte offset where the marker was.
 */
function cursor(withMarker: string): { source: string; offset: number } {
  const offset = withMarker.indexOf("|");
  assert.ok(offset >= 0, "test source must contain a | cursor marker");
  return { source: withMarker.slice(0, offset) + withMarker.slice(offset + 1), offset };
}

function completeIn(
  docs: Record<string, string>,
  target: string,
): CompletionCandidate[] {
  const idx = new WorkspaceIndex();
  let uri = "";
  let offset = -1;
  for (const [name, text] of Object.entries(docs)) {
    const u = `file:///${name}`;
    if (name === target) {
      const c = cursor(text);
      idx.setDocument(u, c.source);
      uri = u;
      offset = c.offset;
    } else {
      idx.setDocument(u, text);
    }
  }
  return idx.completions(uri, offset);
}

function labels(cs: CompletionCandidate[]): string[] {
  return cs.map((c) => c.label);
}

test("completion in operator position offers the function namespace", () => {
  const cs = completeIn(
    {
      a: `(in-package :cl-user)
(defun calculate-fee (amount) amount)
(defvar calc-rate 1)
(defun run (v) (calc|))`,
    },
    "a",
  );
  assert.ok(cs.every((c) => c.namespace === Namespace.Function));
  assert.ok(labels(cs).includes("calculate-fee"));
  // A value-namespace defvar must not appear in operator position.
  assert.ok(!labels(cs).includes("calc-rate"));
});

test("completion in value position offers the value namespace", () => {
  const cs = completeIn(
    {
      a: `(in-package :cl-user)
(defun calculate-fee (amount) amount)
(defvar calc-rate 1)
(defun run (v) (list calc|))`,
    },
    "a",
  );
  assert.ok(cs.every((c) => c.namespace === Namespace.Value));
  assert.ok(labels(cs).includes("calc-rate"));
  assert.ok(!labels(cs).includes("calculate-fee"));
});

test("a lexical binding outranks a same-named global", () => {
  const cs = completeIn(
    {
      a: `(in-package :cl-user)
(defvar total-rate 0)
(defun run (v)
  (let ((total-sum 1))
    (list total|)))`,
    },
    "a",
  );
  // The lexical binding sorts first (rank 0), ahead of the global defvar.
  assert.equal(cs[0].label, "total-sum");
  assert.equal(cs[0].sortRank, 0);
  const global = cs.find((c) => c.label === "total-rate");
  assert.ok(global);
  assert.ok(global!.sortRank > 0);
});

test("a local function outranks a global function", () => {
  const cs = completeIn(
    {
      a: `(in-package :cl-user)
(defun helper-fn (x) x)
(defun run (v)
  (flet ((helper-local (y) y))
    (help|)))`,
    },
    "a",
  );
  // Both match "help"; the lexical flet function ranks ahead of the global.
  assert.equal(cs[0].label, "helper-local");
  assert.equal(cs[0].sortRank, 0);
});

test("pkg: prefix offers only exported symbols", () => {
  const cs = completeIn(
    {
      a: `(defpackage :payment
  (:use :cl)
  (:export #:authorize))
(in-package :payment)
(defun authorize (tx) tx)
(defun authenticate (tx) tx)`,
      b: `(in-package :cl-user)
(defun run (v) (payment:auth|))`,
    },
    "b",
  );
  assert.deepEqual(labels(cs), ["authorize"]);
});

test("pkg:: prefix allows internal symbols", () => {
  const cs = completeIn(
    {
      a: `(defpackage :payment
  (:use :cl)
  (:export #:authorize))
(in-package :payment)
(defun authorize (tx) tx)
(defun authenticate (tx) tx)`,
      b: `(in-package :cl-user)
(defun run (v) (payment::auth|))`,
    },
    "b",
  );
  assert.deepEqual(labels(cs).sort(), ["authenticate", "authorize"]);
});

test("imported symbols appear unqualified", () => {
  const cs = completeIn(
    {
      a: `(defpackage :database
  (:use :cl)
  (:export #:save-record))
(in-package :database)
(defun save-record (x) x)`,
      b: `(defpackage :app
  (:use :cl)
  (:import-from :database #:save-record))
(in-package :app)
(defun run (v) (save|))`,
    },
    "b",
  );
  assert.ok(labels(cs).includes("save-record"));
});

test("inherited symbols appear unqualified", () => {
  const cs = completeIn(
    {
      a: `(defpackage :shared
  (:use :cl)
  (:export #:process))
(in-package :shared)
(defun process (x) x)`,
      b: `(defpackage :app
  (:use :cl :shared))
(in-package :app)
(defun run (v) (proc|))`,
    },
    "b",
  );
  assert.ok(labels(cs).includes("process"));
});

test("ambiguous inherited symbols do not appear as a resolved candidate", () => {
  const cs = completeIn(
    {
      a: `(defpackage :alpha (:use :cl) (:export #:ambi))
(in-package :alpha)
(defun ambi (x) x)`,
      b: `(defpackage :beta (:use :cl) (:export #:ambi))
(in-package :beta)
(defun ambi (x) x)`,
      c: `(defpackage :app (:use :cl :alpha :beta))
(in-package :app)
(defun run (v) (amb|))`,
    },
    "c",
  );
  // The name is ambiguously inherited from two packages; neither home wins, so
  // "ambi" must not be offered as if it resolved cleanly.
  assert.ok(!labels(cs).includes("ambi"));
});

test("no completion inside a comment", () => {
  const cs = completeIn(
    { a: `(in-package :cl-user)
(defun run (v) v) ; call map|` },
    "a",
  );
  assert.equal(cs.length, 0);
});

test("no completion inside a string", () => {
  const cs = completeIn(
    { a: `(in-package :cl-user)
(defun run (v) "map|")` },
    "a",
  );
  assert.equal(cs.length, 0);
});

test("no semantic completion inside quoted data", () => {
  const cs = completeIn(
    {
      a: `(in-package :cl-user)
(defun calculate-fee (x) x)
(defun run (v) '(calc|))`,
    },
    "a",
  );
  assert.ok(!labels(cs).includes("calculate-fee"));
});

test("completion replacement range covers only the symbol name after a qualifier", () => {
  const idx = new WorkspaceIndex();
  const src = `(defpackage :payment (:use :cl) (:export #:authorize))
(in-package :payment)
(defun authorize (tx) tx)`;
  idx.setDocument("file:///a.lisp", src);
  const client = `(in-package :cl-user)
(defun run (v) (payment:auth))`;
  idx.setDocument("file:///b.lisp", client);
  const offset = client.indexOf("payment:auth") + "payment:auth".length;
  const cs = idx.completions("file:///b.lisp", offset);
  const authorize = cs.find((c) => c.label === "authorize");
  assert.ok(authorize);
  // The replaced range is just "auth", preserving the "payment:" qualifier.
  const replaced = client.slice(
    authorize!.replaceRange.start.offset,
    authorize!.replaceRange.end.offset,
  );
  assert.equal(replaced, "auth");
});

test("standard COMMON-LISP symbols participate in completion", () => {
  const cs = completeIn(
    { a: `(in-package :cl-user)
(defun run (v) (map|))` },
    "a",
  );
  const l = labels(cs);
  assert.ok(l.includes("mapcar"));
  assert.ok(l.includes("mapc"));
});

test("standard symbols are gated by the Lisp-2 namespace", () => {
  // `when` is a macro (function namespace); it must not appear in value position.
  const cs = completeIn(
    { a: `(in-package :cl-user)
(defun run (v) (list whe|))` },
    "a",
  );
  assert.ok(!labels(cs).includes("when"));
});
