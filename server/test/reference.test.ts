import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDocument } from "../src/parser/reader";
import {
  ReferenceContext,
  referenceAt,
  referenceContextAt,
} from "../src/model/reference";
import { WorkspaceIndex } from "../src/indexer/workspace-index";
import { Namespace } from "../src/model/symbol";

function refAt(text: string, needle: string) {
  const doc = parseDocument("file:///a.lisp", text);
  const offset = text.indexOf(needle) + 1;
  return referenceAt(doc, offset);
}

function ctxAt(text: string, needle: string) {
  const doc = parseDocument("file:///a.lisp", text);
  return referenceContextAt(doc, text.indexOf(needle) + 1);
}

test("a list head is a function reference", () => {
  assert.equal(ctxAt("(process tx)", "process"), ReferenceContext.Function);
});

test("an evaluated argument is a value reference", () => {
  assert.equal(ctxAt("(+ process 1)", "process"), ReferenceContext.Value);
});

test("a top-level bare symbol is a value reference", () => {
  assert.equal(ctxAt("process", "process"), ReferenceContext.Value);
});

test("#'name is a function reference", () => {
  assert.equal(ctxAt("(mapcar #'process items)", "process"), ReferenceContext.Function);
});

test("(function name) is a function reference", () => {
  assert.equal(ctxAt("(function process)", "process"), ReferenceContext.Function);
});

test("(function (setf name)) names the setf function (SETF NAME)", () => {
  const ref = refAt("(function (setf place))", "place");
  assert.equal(ref?.name, "(SETF PLACE)");
  assert.equal(ref?.context, ReferenceContext.Function);
});

test("#'(setf name) names the setf function (SETF NAME)", () => {
  const ref = refAt("#'(setf place)", "place");
  assert.equal(ref?.name, "(SETF PLACE)");
  assert.equal(ref?.context, ReferenceContext.Function);
});

test("a quoted symbol is literal data", () => {
  assert.equal(ctxAt("'process", "process"), ReferenceContext.Data);
});

test("a quoted list head is literal data, not a call", () => {
  assert.equal(ctxAt("'(process tx)", "process"), ReferenceContext.Data);
});

test("(quote x) treats x as literal data", () => {
  assert.equal(ctxAt("(quote process)", "process"), ReferenceContext.Data);
});

test("unquote re-enters evaluation inside a quasiquote", () => {
  assert.equal(ctxAt("`(foo ,bar)", "bar"), ReferenceContext.Value);
  // The quasiquoted head remains data.
  assert.equal(ctxAt("`(foo ,bar)", "foo"), ReferenceContext.Data);
});

test("package qualification is carried onto the reference", () => {
  const ext = refAt("(payment:authorize tx)", "payment:authorize");
  assert.equal(ext?.name, "AUTHORIZE");
  assert.equal(ext?.packagePrefix, "PAYMENT");
  assert.equal(ext?.qualification, "external");

  const int = refAt("(payment::secret tx)", "payment::secret");
  assert.equal(int?.qualification, "internal");
});

test("an uninterned symbol keeps its uninterned qualification", () => {
  const ref = refAt("(list #:foo)", "#:foo");
  assert.equal(ref?.name, "FOO");
  assert.equal(ref?.qualification, "uninterned");
});

// End-to-end: the FUNCTION operator and quoted data, resolved through the index.

function index(): WorkspaceIndex {
  const idx = new WorkspaceIndex();
  idx.setDocument("file:///a.lisp", "(in-package :cl-user)\n(defun thing () 2)");
  return idx;
}

function resolveVia(idx: WorkspaceIndex, text: string, needle: string) {
  const doc = parseDocument("file:///q.lisp", text);
  const offset = text.indexOf(needle) + 1;
  const ref = referenceAt(doc, offset);
  if (!ref) return [];
  if (ref.context === ReferenceContext.Data) return [];
  const namespace =
    ref.context === ReferenceContext.Function ? Namespace.Function : Namespace.Value;
  return idx.resolveReference(
    { name: ref.name, packagePrefix: ref.packagePrefix, qualification: ref.qualification },
    "CL-USER",
    { namespace },
  );
}

test("#'thing and (function thing) resolve to the same DEFUN", () => {
  const idx = index();
  const sharp = resolveVia(idx, "#'thing", "thing");
  const op = resolveVia(idx, "(function thing)", "thing");
  assert.equal(sharp.length, 1);
  assert.equal(op.length, 1);
  assert.equal(sharp[0].uri, op[0].uri);
  assert.equal(sharp[0].selectionRange.start.offset, op[0].selectionRange.start.offset);
});

test("quoted data 'thing and '(thing) do not resolve to the DEFUN", () => {
  const idx = index();
  assert.equal(resolveVia(idx, "'thing", "thing").length, 0);
  assert.equal(resolveVia(idx, "'(thing)", "thing").length, 0);
});
