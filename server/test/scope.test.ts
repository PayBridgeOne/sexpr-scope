import { test } from "node:test";
import assert from "node:assert/strict";
import { WorkspaceIndex } from "../src/indexer/workspace-index";
import { analyzeScopes } from "../src/analyzer/scope-analyzer";
import { parseDocument } from "../src/parser/reader";
import { LexicalBindingKind } from "../src/model/scope";
import { Namespace } from "../src/model/symbol";

const URI = "file:///a.lisp";

function index(text: string): WorkspaceIndex {
  const idx = new WorkspaceIndex();
  idx.setDocument(URI, text);
  return idx;
}

/** True when `c` delimits a Lisp symbol (whitespace, parens, quote, …). */
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

/** Start offset of the n-th (0-based) whole-token occurrence of `needle`. */
function nth(text: string, needle: string, n = 0): number {
  const offsets = tokenOffsets(text, needle);
  if (n >= offsets.length) {
    throw new Error(`token occurrence ${n} of ${needle} not found`);
  }
  return offsets[n];
}

/** Start offset of the n-th raw substring occurrence (for non-token needles). */
function rawNth(text: string, needle: string, n = 0): number {
  let i = -1;
  for (let k = 0; k <= n; k++) {
    i = text.indexOf(needle, i + 1);
    if (i === -1) throw new Error(`occurrence ${n} of ${needle} not found`);
  }
  return i;
}

/** Resolves the target at the n-th whole-token occurrence of `needle`. */
function resolveNth(idx: WorkspaceIndex, text: string, needle: string, n = 0) {
  const offset = nth(text, needle, n);
  const resolution = idx.resolveAt(URI, offset + 1);
  return resolution?.target;
}

test("a function parameter reference resolves to its lambda-list binding", () => {
  const text = "(defun foo (x) (+ x 1))";
  const idx = index(text);
  const target = resolveNth(idx, text, "x", 1); // the reference, not the param
  assert.equal(target?.kind, "lexical");
  if (target?.kind !== "lexical") return;
  assert.equal(target.binding.bindingKind, LexicalBindingKind.Parameter);
  assert.equal(target.binding.namespace, Namespace.Value);
  // The binding's selection range is the parameter token itself.
  assert.equal(target.binding.selectionRange.start.offset, nth(text, "x", 0));
});

test("a LET variable is not visible in its own initializer (parallel binding)", () => {
  const text = "(let ((x 1) (y x)) (+ x y))";
  const idx = index(text);
  // The `x` inside `(y x)` must not see the LET's own `x`.
  const initRef = resolveNth(idx, text, "x", 1);
  assert.notEqual(initRef?.kind, "lexical");
  // The `x` in the body does resolve to the LET binding.
  const bodyRef = resolveNth(idx, text, "x", 2);
  assert.equal(bodyRef?.kind, "lexical");
  if (bodyRef?.kind === "lexical") {
    assert.equal(bodyRef.binding.bindingKind, LexicalBindingKind.LetVariable);
  }
});

test("a LET* variable is visible in a following clause's initializer", () => {
  const text = "(let* ((x 1) (y x)) (+ x y))";
  const idx = index(text);
  const initRef = resolveNth(idx, text, "x", 1); // the `x` inside `(y x)`
  assert.equal(initRef?.kind, "lexical");
  if (initRef?.kind === "lexical") {
    assert.equal(initRef.binding.selectionRange.start.offset, nth(text, "x", 0));
  }
});

test("an inner LET shadows a parameter and a global of the same name", () => {
  const text = "(defvar x 1)\n(defun foo (x)\n  (let ((x 10))\n    x))";
  const idx = index(text);
  // The body `x` resolves to the innermost LET binding.
  const target = resolveNth(idx, text, "x", 3);
  assert.equal(target?.kind, "lexical");
  if (target?.kind !== "lexical") return;
  assert.equal(target.binding.bindingKind, LexicalBindingKind.LetVariable);
  // It is the LET's `x`, i.e. the 3rd `x` token, not the parameter (2nd).
  assert.equal(target.binding.selectionRange.start.offset, nth(text, "x", 2));
});

test("a LAMBDA parameter resolves inside the lambda body", () => {
  const text = "(mapcar (lambda (x) (* x x)) items)";
  const idx = index(text);
  const target = resolveNth(idx, text, "x", 1);
  assert.equal(target?.kind, "lexical");
  if (target?.kind === "lexical") {
    assert.equal(target.binding.bindingKind, LexicalBindingKind.Parameter);
  }
});

test("FLET local functions are not visible in their own bodies (non-recursive)", () => {
  const text = "(flet ((fact () (fact))) (fact))";
  const idx = index(text);
  // The recursive call inside the FLET function body does NOT see the binding.
  const bodyCallOffset = rawNth(text, "(fact))", 0) + 1; // inner call
  const innerTarget = idx.resolveAt(URI, bodyCallOffset)?.target;
  assert.notEqual(innerTarget?.kind, "lexical");
  // The outer call resolves to the FLET function.
  const outerTarget = resolveNth(idx, text, "fact", 2);
  assert.equal(outerTarget?.kind, "lexical");
  if (outerTarget?.kind === "lexical") {
    assert.equal(outerTarget.binding.namespace, Namespace.Function);
    assert.equal(outerTarget.binding.bindingKind, LexicalBindingKind.LocalFunction);
  }
});

test("LABELS local functions can call themselves recursively", () => {
  const text = "(labels ((fact (n) (fact n))) (fact 5))";
  const idx = index(text);
  // The recursive call inside the body resolves to the LABELS function.
  const recursive = resolveNth(idx, text, "fact", 1); // inside the body
  assert.equal(recursive?.kind, "lexical");
  if (recursive?.kind === "lexical") {
    assert.equal(recursive.binding.selectionRange.start.offset, nth(text, "fact", 0));
  }
});

test("LABELS local functions can reference each other (mutual recursion)", () => {
  const text = "(labels ((evenp (n) (oddp n)) (oddp (n) (evenp n))) (evenp 4))";
  const idx = index(text);
  // `oddp` referenced inside `evenp`'s body resolves to the LABELS `oddp`.
  const oddpRef = resolveNth(idx, text, "oddp", 0); // inside evenp body
  assert.equal(oddpRef?.kind, "lexical");
  if (oddpRef?.kind === "lexical") {
    assert.equal(oddpRef.binding.selectionRange.start.offset, nth(text, "oddp", 1));
  }
  // `evenp` referenced inside `oddp`'s body resolves to the LABELS `evenp`.
  const evenpRef = resolveNth(idx, text, "evenp", 1); // inside oddp body
  assert.equal(evenpRef?.kind, "lexical");
  if (evenpRef?.kind === "lexical") {
    assert.equal(evenpRef.binding.selectionRange.start.offset, nth(text, "evenp", 0));
  }
});

test("MACROLET introduces a function-namespace local macro", () => {
  const text = "(macrolet ((m (x) x)) (m 1))";
  const idx = index(text);
  const target = resolveNth(idx, text, "m", 1); // the call `(m 1)`
  assert.equal(target?.kind, "lexical");
  if (target?.kind === "lexical") {
    assert.equal(target.binding.namespace, Namespace.Function);
    assert.equal(target.binding.bindingKind, LexicalBindingKind.LocalMacro);
  }
});

test("SYMBOL-MACROLET introduces a value-namespace binding", () => {
  const text = "(symbol-macrolet ((x 1)) (+ x 2))";
  const idx = index(text);
  const target = resolveNth(idx, text, "x", 1); // use in the body
  assert.equal(target?.kind, "lexical");
  if (target?.kind === "lexical") {
    assert.equal(target.binding.namespace, Namespace.Value);
    assert.equal(target.binding.bindingKind, LexicalBindingKind.SymbolMacro);
  }
});

test("MULTIPLE-VALUE-BIND binds its variables over the body only", () => {
  const text = "(multiple-value-bind (q r) (floor 10 3) (+ q r))";
  const idx = index(text);
  const target = resolveNth(idx, text, "q", 1); // use in the body
  assert.equal(target?.kind, "lexical");
  if (target?.kind === "lexical") {
    assert.equal(target.binding.bindingKind, LexicalBindingKind.MultipleValue);
  }
});

test("DESTRUCTURING-BIND binds every variable in the pattern", () => {
  const text = "(destructuring-bind (a (b c)) x (list a b c))";
  const idx = index(text);
  for (const name of ["a", "b", "c"]) {
    const target = resolveNth(idx, text, name, 1); // use in the body
    assert.equal(target?.kind, "lexical", `${name} should be lexical`);
    if (target?.kind === "lexical") {
      assert.equal(target.binding.bindingKind, LexicalBindingKind.Destructuring);
    }
  }
});

test("&optional, &key, &rest and &aux parameters all introduce bindings", () => {
  const text = "(defun foo (a &optional b &rest c &key d &aux e) (list a b c d e))";
  const idx = index(text);
  for (const name of ["a", "b", "c", "d", "e"]) {
    const target = resolveNth(idx, text, name, 1); // use in the body
    assert.equal(target?.kind, "lexical", `${name} should be lexical`);
  }
});

test("function and value namespaces never collide for same-named bindings", () => {
  const text =
    "(defun example (x)\n" +
    "  (let ((process x))\n" +
    "    (flet ((process (y) (+ y 1)))\n" +
    "      (process process))))";
  const idx = index(text);
  // In `(process process)`: head is the FLET function, argument is the LET var.
  const callOffset = rawNth(text, "(process process)", 0) + 1;
  const head = idx.resolveAt(URI, callOffset)?.target;
  const argOffset = rawNth(text, "(process process)", 0) + "(process ".length;
  const arg = idx.resolveAt(URI, argOffset)?.target;
  assert.equal(head?.kind, "lexical");
  assert.equal(arg?.kind, "lexical");
  if (head?.kind === "lexical" && arg?.kind === "lexical") {
    assert.equal(head.binding.namespace, Namespace.Function);
    assert.equal(arg.binding.namespace, Namespace.Value);
    // Distinct identities — they must never be conflated.
    assert.notEqual(head.binding.id, arg.binding.id);
  }
});

test("the scope analyzer never treats quoted data as a binding form", () => {
  const text = "'(let ((x 1)) x)";
  const scope = analyzeScopes(parseDocument(URI, text));
  assert.equal(scope.allBindings().length, 0);
});
