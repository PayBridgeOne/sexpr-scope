import { test } from "node:test";
import assert from "node:assert/strict";
import { WorkspaceIndex } from "../src/indexer/workspace-index";
import {
  SemanticTokenInfo,
  TokenModifier,
  TokenType,
  encodeSemanticTokens,
} from "../src/analyzer/token-classifier";

const URI = "file:///tok.lisp";

const SOURCE = [
  "(in-package :cl-user)",
  "(defvar *rate* 0.03)",
  "(defconstant +limit+ 100)",
  "(defmacro with-thing (x) x)",
  "(defclass widget () ())",
  "(defun calculate (amount)",
  "  (let ((result (* amount *rate*)))",
  "    (flet ((persist (value)",
  "             (cl:identity value)))",
  "      (persist result))))",
].join("\n");

function tokensFor(text: string): SemanticTokenInfo[] {
  const idx = new WorkspaceIndex();
  idx.setDocument(URI, text);
  return idx.semanticTokens(URI);
}

/** Whole-token offset of the nth occurrence of `token` in `text`. */
function offsetOf(text: string, token: string, n = 0): number {
  const isDelim = (c: string | undefined) =>
    c === undefined || /[\s()'`,@[\]";]/.test(c);
  let from = 0;
  let seen = 0;
  for (;;) {
    const i = text.indexOf(token, from);
    if (i === -1) throw new Error(`token ${token}#${n} not found`);
    if (isDelim(text[i - 1]) && isDelim(text[i + token.length])) {
      if (seen === n) return i;
      seen++;
    }
    from = i + 1;
  }
}

function at(tokens: SemanticTokenInfo[], offset: number): SemanticTokenInfo {
  const t = tokens.find((tok) => tok.range.start.offset === offset);
  if (!t) throw new Error(`no token at offset ${offset}`);
  return t;
}

function assertToken(
  tokens: SemanticTokenInfo[],
  text: string,
  needle: string,
  n: number,
  type: TokenType,
  modifiers: TokenModifier[] = [],
): void {
  const tok = at(tokens, offsetOf(text, needle, n));
  assert.equal(tok.type, type, `${needle}#${n} type`);
  for (const m of modifiers) {
    assert.ok(tok.modifiers.includes(m), `${needle}#${n} missing modifier ${m}`);
  }
}

test("semantic tokens classify a representative file by binding", () => {
  const tokens = tokensFor(SOURCE);

  // Global definitions.
  assertToken(tokens, SOURCE, "calculate", 0, "function", ["definition"]);
  assertToken(tokens, SOURCE, "with-thing", 0, "macro", ["definition"]);
  assertToken(tokens, SOURCE, "widget", 0, "class", ["definition"]);
  assertToken(tokens, SOURCE, "*rate*", 0, "variable", ["special", "definition"]);
  assertToken(tokens, SOURCE, "+limit+", 0, "variable", ["readonly", "definition"]);

  // Parameter: declaration and use.
  assertToken(tokens, SOURCE, "amount", 0, "parameter", ["local", "definition"]);
  assertToken(tokens, SOURCE, "amount", 1, "parameter", ["local"]);

  // LET variable: declaration and use.
  assertToken(tokens, SOURCE, "result", 0, "variable", ["local", "definition"]);
  assertToken(tokens, SOURCE, "result", 1, "variable", ["local"]);

  // Special/global variable reference.
  assertToken(tokens, SOURCE, "*rate*", 1, "variable", ["special"]);

  // Local function (FLET): declaration and call.
  assertToken(tokens, SOURCE, "persist", 0, "function", ["local", "definition"]);
  assertToken(tokens, SOURCE, "persist", 1, "function", ["local"]);

  // Special operators read as keywords.
  assertToken(tokens, SOURCE, "let", 0, "keyword");
  assertToken(tokens, SOURCE, "flet", 0, "keyword");

  // Keyword symbol.
  assertToken(tokens, SOURCE, ":cl-user", 0, "enumMember");
});

test("a package-qualified call splits into a namespace and a function token", () => {
  const tokens = tokensFor(SOURCE);
  // `cl:identity` → `cl` namespace token + `identity` function token.
  const pkg = at(tokens, offsetOf(SOURCE, "cl:identity", 0));
  assert.equal(pkg.type, "namespace");
  const sym = tokens.find(
    (t) => t.range.start.offset === offsetOf(SOURCE, "cl:identity", 0) + 3,
  );
  assert.ok(sym, "symbol token present after package prefix");
  assert.equal(sym!.type, "function");
});

test("numeric and quoted-data atoms are not tokenized", () => {
  const text = "(in-package :cl-user)\n(defvar *n* 42)\n(defvar *q* '(alpha beta))";
  const tokens = tokensFor(text);
  // The number 42 has no token.
  assert.equal(
    tokens.some((t) => t.range.start.offset === offsetOf(text, "42", 0)),
    false,
  );
  // Quoted data symbols are not tokenized.
  assert.equal(
    tokens.some((t) => t.range.start.offset === offsetOf(text, "alpha", 0)),
    false,
  );
});

test("encodeSemanticTokens produces 5-tuples with non-negative deltas", () => {
  const tokens = tokensFor(SOURCE);
  const data = encodeSemanticTokens(tokens);
  assert.equal(data.length % 5, 0);
  assert.ok(data.length > 0);
  // Deltas and lengths are non-negative; the first token's deltaLine is its line.
  for (let i = 0; i < data.length; i += 5) {
    assert.ok(data[i] >= 0, "deltaLine non-negative");
    assert.ok(data[i + 2] > 0, "length positive");
  }
});
