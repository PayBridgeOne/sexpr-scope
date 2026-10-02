import { test } from "node:test";
import assert from "node:assert/strict";
import { WorkspaceIndex } from "../src/indexer/workspace-index";
import { OccurrenceRole } from "../src/model/resolution";

/** True when `c` delimits a Lisp symbol. */
function isDelim(c: string | undefined): boolean {
  return c === undefined || /[\s()'`,@[\]";]/.test(c);
}

/** Start offsets of every whole-token occurrence of `token`. */
function tokenOffsets(text: string, token: string): number[] {
  const out: number[] = [];
  let from = 0;
  for (;;) {
    const i = text.indexOf(token, from);
    if (i === -1) break;
    const before = i === 0 ? undefined : text[i - 1];
    const after = i + token.length >= text.length ? undefined : text[i + token.length];
    if (isDelim(before) && isDelim(after)) out.push(i);
    from = i + 1;
  }
  return out;
}

function nth(text: string, needle: string, n = 0): number {
  const offsets = tokenOffsets(text, needle);
  if (n >= offsets.length) throw new Error(`token ${needle}#${n} not found`);
  return offsets[n];
}

const A = "file:///a.lisp";
const B = "file:///b.lisp";

test("global references are found across files, honoring includeDeclaration", () => {
  const idx = new WorkspaceIndex();
  const libText = "(in-package :cl-user)\n(defun shared () 1)";
  const useText = "(in-package :cl-user)\n(shared)\n(list (shared))";
  idx.setDocument(A, libText);
  idx.setDocument(B, useText);

  // Find references from a use site in B.
  const offset = nth(useText, "shared", 0); // first use in B
  const withDecl = idx.findReferences(B, offset + 1, true);
  const withoutDecl = idx.findReferences(B, offset + 1, false);

  // One declaration (in A) + two uses (in B).
  assert.equal(withDecl.length, 3);
  assert.equal(withoutDecl.length, 2);

  const declCount = withDecl.filter((r) => r.role === OccurrenceRole.Definition).length;
  assert.equal(declCount, 1);
  // The declaration lives in the library file.
  const decl = withDecl.find((r) => r.role === OccurrenceRole.Definition);
  assert.equal(decl?.uri, A);
  // Both uses live in B.
  const uses = withDecl.filter((r) => r.role === OccurrenceRole.Reference);
  assert.ok(uses.every((r) => r.uri === B));
});

test("a reference never matches a same-named symbol in another package", () => {
  const idx = new WorkspaceIndex();
  const text =
    "(defpackage :one (:use :cl) (:export #:run))\n" +
    "(defpackage :two (:use :cl) (:export #:run))\n" +
    "(in-package :one)\n(defun run () 1)\n(run)\n" +
    "(in-package :two)\n(defun run () 2)\n(run)";
  idx.setDocument(A, text);

  // References to ONE::RUN must not include TWO::RUN's definition or call.
  const offset = nth(text, "run", 1); // the (run) call in package ONE
  const refs = idx.findReferences(A, offset + 1, true);
  // ONE:RUN — declaration + single call.
  assert.equal(refs.length, 2);
  // All results are in the ONE section (before the second in-package).
  const twoStart = text.indexOf("(in-package :two)");
  assert.ok(refs.every((r) => r.range.start.offset < twoStart));
});

test("lexical references stay confined to their binding's scope", () => {
  const idx = new WorkspaceIndex();
  const text = "(defun foo (x)\n  (let ((x 10))\n    (+ x x)))";
  idx.setDocument(A, text);

  // Reference the inner LET `x` (first body use).
  const bodyX = nth(text, "x", 2); // 0=param, 1=let binding, 2=first body use
  const refs = idx.findReferences(A, bodyX + 1, true);
  // LET declaration + two body uses = 3; the parameter is NOT included.
  assert.equal(refs.length, 3);
  const paramOffset = nth(text, "x", 0);
  assert.ok(refs.every((r) => r.range.start.offset !== paramOffset));
});

test("same-named function and value bindings produce disjoint references", () => {
  const idx = new WorkspaceIndex();
  const text = "(let ((f 1))\n  (flet ((f () 2))\n    (f)\n    f))";
  idx.setDocument(A, text);

  // The value `f` (bare symbol in the body).
  const valueUse = nth(text, "f", 3); // 0=let, 1=flet, 2=call, 3=value use
  const valueRefs = idx.findReferences(A, valueUse + 1, true);
  // The function `f` (the call `(f)`).
  const fnUse = nth(text, "f", 2);
  const fnRefs = idx.findReferences(A, fnUse + 1, true);

  // Value f: LET declaration + value use.
  assert.equal(valueRefs.length, 2);
  // Function f: FLET declaration + call.
  assert.equal(fnRefs.length, 2);

  // The two reference sets are disjoint.
  const valueOffsets = new Set(valueRefs.map((r) => r.range.start.offset));
  for (const r of fnRefs) {
    assert.ok(!valueOffsets.has(r.range.start.offset));
  }
});

test("Find References on a generic function includes its call sites", () => {
  const idx = new WorkspaceIndex();
  const text =
    "(in-package :cl-user)\n" +
    "(defgeneric process (object))\n" +
    "(defmethod process ((object integer)) object)\n" +
    "(defmethod process ((object string)) object)\n" +
    "(defun run (x) (process x))";
  idx.setDocument(A, text);

  // From the call site.
  const callOffset = text.lastIndexOf("process");
  const withDecl = idx.findReferences(A, callOffset + 1, true);
  const withoutDecl = idx.findReferences(A, callOffset + 1, false);

  // defgeneric + 2 defmethod names are declarations; the call is a reference.
  assert.equal(withoutDecl.length, 1, "only the call is a non-declaration use");
  assert.equal(withoutDecl[0].range.start.offset, callOffset);
  assert.equal(withDecl.length, 4, "generic + 2 methods + call");
});

test("references in comments, strings and quoted data are ignored", () => {
  const idx = new WorkspaceIndex();
  const text =
    "(in-package :cl-user)\n" +
    "(defun target () 1)\n" +
    "; a call to target in a comment\n" +
    '(defvar *s* "target in a string")\n' +
    "(defvar *q* \'(target))\n" +
    "(target)";
  idx.setDocument(A, text);

  const offset = text.lastIndexOf("target"); // the real call
  const refs = idx.findReferences(A, offset + 1, true);
  // Only the declaration and the single real call — not the comment, string or
  // quoted-data occurrences.
  assert.equal(refs.length, 2);
});

test("references inside reader-discarded data are ignored", () => {
  const idx = new WorkspaceIndex();
  const text =
    "(in-package :cl-user)\n(defun target () 1)\n#;(target)\n(target)";
  idx.setDocument(A, text);
  const offset = text.lastIndexOf("target");
  const refs = idx.findReferences(A, offset + 1, true);
  // Declaration + the single real call; the `#;(target)` datum is discarded.
  assert.equal(refs.length, 2);
});
