import { test } from "node:test";
import assert from "node:assert/strict";
import { WorkspaceIndex } from "../src/indexer/workspace-index";
import { SignatureModel } from "../src/analyzer/signature";

/** Offset of a single `|` cursor marker; returns cleaned source + offset. */
function cursor(withMarker: string): { source: string; offset: number } {
  const offset = withMarker.indexOf("|");
  assert.ok(offset >= 0, "test source must contain a | cursor marker");
  return { source: withMarker.slice(0, offset) + withMarker.slice(offset + 1), offset };
}

function help(withMarker: string): SignatureModel | undefined {
  const idx = new WorkspaceIndex();
  const { source, offset } = cursor(withMarker);
  idx.setDocument("file:///a.lisp", source);
  return idx.signatureHelp("file:///a.lisp", offset);
}

const CHARGE = `(in-package :cl-user)
(defun charge-fee (transaction amount &key currency) transaction)`;

test("signature help at the first argument", () => {
  const sig = help(`${CHARGE}
(defun run (tx) (charge-fee |tx))`);
  assert.ok(sig);
  assert.equal(sig!.label, "(charge-fee transaction amount &key currency)");
  assert.deepEqual(sig!.parameters, ["transaction", "amount", "currency"]);
  assert.equal(sig!.activeParameter, 0);
});

test("signature help advances to a later argument", () => {
  const sig = help(`${CHARGE}
(defun run (tx) (charge-fee tx |))`);
  assert.ok(sig);
  assert.equal(sig!.activeParameter, 1);
});

test("signature help for a &key argument", () => {
  const sig = help(`${CHARGE}
(defun run (tx) (charge-fee tx 100 |))`);
  assert.ok(sig);
  assert.equal(sig!.activeParameter, 2);
});

test("signature help for a defgeneric", () => {
  const sig = help(`(in-package :cl-user)
(defgeneric area (shape &optional unit))
(defun run (s) (area s |))`);
  assert.ok(sig);
  assert.equal(sig!.label, "(area shape &optional unit)");
  assert.deepEqual(sig!.parameters, ["shape", "unit"]);
  assert.equal(sig!.activeParameter, 1);
});

test("signature help for a local FLET function", () => {
  const sig = help(`(in-package :cl-user)
(defun run (x) (flet ((g (a b) a)) (g 1 |)))`);
  assert.ok(sig);
  assert.equal(sig!.label, "(g a b)");
  assert.equal(sig!.activeParameter, 1);
});

test("signature help for a local LABELS function", () => {
  const sig = help(`(in-package :cl-user)
(defun run (x) (labels ((h (a b) a)) (h 1 |)))`);
  assert.ok(sig);
  assert.equal(sig!.label, "(h a b)");
  assert.equal(sig!.activeParameter, 1);
});

test("signature help for a macro with a known lambda list", () => {
  const sig = help(`(in-package :cl-user)
(defmacro mywith (var val &body body) var)
(defun run () (mywith a 1 |))`);
  assert.ok(sig);
  assert.equal(sig!.label, "(mywith var val &body body)");
  assert.deepEqual(sig!.parameters, ["var", "val", "body"]);
  assert.equal(sig!.activeParameter, 2);
});

test("a nested argument form does not throw off the active parameter", () => {
  // (foo (bar 1 2) second|) — the cursor is on the SECOND argument even though
  // the first argument contains a nested form with its own atoms. Active
  // parameter must follow source structure, not a count of atoms/commas.
  const sig = help(`(in-package :cl-user)
(defun foo (a b) a)
(defun run (x) (foo (bar 1 2) |second))`);
  assert.ok(sig);
  assert.equal(sig!.label, "(foo a b)");
  assert.equal(sig!.activeParameter, 1);
});

test("no signature help on the operator itself", () => {
  const sig = help(`${CHARGE}
(defun run (tx) (charge|-fee tx))`);
  assert.equal(sig, undefined);
});
