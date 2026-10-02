import { test } from "node:test";
import assert from "node:assert/strict";
import { tokenize, TokenType } from "../src/parser/tokenizer";
import {
  parseDocument,
  NodeKind,
  isList,
  atomAtOffset,
} from "../src/parser/reader";

test("tokenizer treats #. read-eval as an inert prefix, never evaluating", () => {
  const tokens = tokenize("(list #.(launch-missiles))");
  const prefix = tokens.find((t) => t.type === TokenType.Prefix);
  assert.ok(prefix, "expected a prefix token for #.");
  assert.equal(prefix!.prefix, "#.");
  // The inner form is tokenized as plain data: open paren + atoms + close.
  assert.ok(tokens.some((t) => t.type === TokenType.Atom && t.text === "launch-missiles"));
});

test("tokenizer handles strings, line comments and nested block comments", () => {
  const src = '"a;b" ; comment (\n#| outer #| inner |# still |# x';
  const tokens = tokenize(src);
  assert.equal(tokens[0].type, TokenType.String);
  assert.equal(tokens[0].text, '"a;b"');
  assert.equal(tokens[1].type, TokenType.LineComment);
  const block = tokens.find((t) => t.type === TokenType.BlockComment);
  assert.ok(block && !block.unterminated, "nested block comment should close");
  assert.equal(tokens[tokens.length - 1].text, "x");
});

test("tokenizer flags an unterminated string but keeps going", () => {
  const tokens = tokenize('(foo "open');
  const str = tokens.find((t) => t.type === TokenType.String);
  assert.ok(str?.unterminated);
});

test("reader builds a tree and tolerates a missing closing paren", () => {
  const doc = parseDocument("file:///a.lisp", "(defun f (x)\n  (+ x 1)");
  assert.equal(doc.roots.length, 1);
  const root = doc.roots[0];
  assert.ok(isList(root));
  if (isList(root)) {
    assert.equal(root.unclosed, true);
    assert.equal(root.children[0].kind, NodeKind.Atom);
  }
});

test("reader ignores stray closing parens without throwing", () => {
  const doc = parseDocument("file:///a.lisp", ")) (foo) ))");
  assert.equal(doc.roots.length, 1);
  assert.ok(isList(doc.roots[0]));
});

test("atomAtOffset finds the symbol under the cursor", () => {
  const text = "(charge-fee tx)";
  const doc = parseDocument("file:///a.lisp", text);
  const atom = atomAtOffset(doc, text.indexOf("charge-fee") + 2);
  assert.equal(atom?.text, "charge-fee");
});

test("#' and quote are represented as prefixed wrappers around a datum", () => {
  const doc = parseDocument("file:///a.lisp", "(mapcar #'foo '(1 2 3))");
  const root = doc.roots[0];
  assert.ok(isList(root));
  if (isList(root)) {
    const fn = root.children[1];
    assert.equal(fn.kind, NodeKind.Prefixed);
  }
});

test("#+ reader conditional is parsed as a reader-conditional node", () => {
  const doc = parseDocument("file:///a.lisp", "#+sbcl (defun f () 1)");
  assert.equal(doc.roots.length, 1);
  const root = doc.roots[0];
  assert.equal(root.kind, NodeKind.ReaderConditional);
  if (root.kind === NodeKind.ReaderConditional) {
    assert.equal(root.polarity, "+");
    assert.ok(root.feature && root.feature.kind === NodeKind.Atom);
    assert.ok(root.child && isList(root.child));
  }
});

test("#- reader conditional records negative polarity", () => {
  const doc = parseDocument("file:///a.lisp", "#-sbcl (defun g () 2)");
  const root = doc.roots[0];
  assert.equal(root.kind, NodeKind.ReaderConditional);
  if (root.kind === NodeKind.ReaderConditional) {
    assert.equal(root.polarity, "-");
  }
});

test("compound #+ feature expression is kept as inert syntax", () => {
  const doc = parseDocument("file:///a.lisp", "#+(and sbcl unix) (defun h () 3)");
  const root = doc.roots[0];
  assert.equal(root.kind, NodeKind.ReaderConditional);
  if (root.kind === NodeKind.ReaderConditional) {
    assert.ok(root.feature && isList(root.feature));
    assert.ok(root.child && isList(root.child));
  }
});

test("#; discard wraps a datum and removes it from list children", () => {
  const doc = parseDocument("file:///a.lisp", "(a #;(b c) d)");
  const root = doc.roots[0];
  assert.ok(isList(root));
  if (isList(root)) {
    const names = root.children
      .filter((c) => c.kind === NodeKind.Atom)
      .map((c) => (c.kind === NodeKind.Atom ? c.text : ""));
    assert.deepEqual(names, ["a", "d"]);
  }
});

test("atomAtOffset does not surface atoms inside a #; discard", () => {
  const text = "(a #;(b c) d)";
  const doc = parseDocument("file:///a.lisp", text);
  const atom = atomAtOffset(doc, text.indexOf("b"));
  assert.equal(atom, undefined);
});
