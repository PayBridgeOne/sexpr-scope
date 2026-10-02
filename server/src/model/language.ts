/**
 * Central static knowledge about Common Lisp the static model needs.
 *
 * This module is the single place where "built-in" language facts live, so the
 * analyzer, resolver and semantic-token provider never scatter ad-hoc,
 * incomplete literal lists across the codebase. It is deliberately static: it
 * encodes only what the standard guarantees and never reflects a running image.
 *
 * Runtime-enriched knowledge (what a particular SBCL actually has loaded) is a
 * later milestone; nothing here evaluates Lisp.
 */

import { canonicalizeName } from "./symbol";

/**
 * Common Lisp lambda-list keywords. These mark sections of a lambda list and
 * never introduce a variable themselves.
 */
export const LAMBDA_LIST_KEYWORDS: ReadonlySet<string> = new Set([
  "&OPTIONAL",
  "&REST",
  "&BODY",
  "&KEY",
  "&AUX",
  "&ALLOW-OTHER-KEYS",
  "&WHOLE",
  "&ENVIRONMENT",
]);

export function isLambdaListKeyword(name: string): boolean {
  return LAMBDA_LIST_KEYWORDS.has(name);
}

/**
 * The Common Lisp special operators (CLHS 3.1.2.1.2.1). These are the true
 * special forms the evaluator recognizes; macros such as `LOOP`, `DOLIST` or
 * `WHEN` are intentionally *not* here — they are ordinary macros and must not be
 * presented as special operators.
 */
export const SPECIAL_OPERATORS: ReadonlySet<string> = new Set([
  "BLOCK",
  "CATCH",
  "EVAL-WHEN",
  "FLET",
  "FUNCTION",
  "GO",
  "IF",
  "LABELS",
  "LET",
  "LET*",
  "LOAD-TIME-VALUE",
  "LOCALLY",
  "MACROLET",
  "MULTIPLE-VALUE-CALL",
  "MULTIPLE-VALUE-PROG1",
  "PROGN",
  "PROGV",
  "QUOTE",
  "RETURN-FROM",
  "SETQ",
  "SYMBOL-MACROLET",
  "TAGBODY",
  "THE",
  "THROW",
  "UNWIND-PROTECT",
]);

export function isSpecialOperator(name: string): boolean {
  return SPECIAL_OPERATORS.has(name);
}

/**
 * Operators that introduce lexical bindings and the shape of the binding form.
 * The scope analyzer consumes this to build the scope tree; it is kept separate
 * from the evaluator's notion of special forms because some binding forms
 * (`multiple-value-bind`, `destructuring-bind`) are macros, not special
 * operators.
 */
export enum BindingFormKind {
  /** `(let ((v init)...) body)` — parallel value bindings. */
  Let = "let",
  /** `(let* ((v init)...) body)` — sequential value bindings. */
  LetStar = "let*",
  /** `(flet ((f (ll) body)...) body)` — parallel local functions. */
  Flet = "flet",
  /** `(labels ((f (ll) body)...) body)` — recursive local functions. */
  Labels = "labels",
  /** `(macrolet ((m (ll) body)...) body)` — local macros. */
  Macrolet = "macrolet",
  /** `(symbol-macrolet ((s expansion)...) body)` — local symbol macros. */
  SymbolMacrolet = "symbol-macrolet",
  /** `(multiple-value-bind (v...) values-form body)`. */
  MultipleValueBind = "multiple-value-bind",
  /** `(destructuring-bind lambda-list expr body)`. */
  DestructuringBind = "destructuring-bind",
  /** `(lambda (ll) body)` — anonymous function. */
  Lambda = "lambda",
}

const BINDING_FORMS: ReadonlyMap<string, BindingFormKind> = new Map([
  ["LET", BindingFormKind.Let],
  ["LET*", BindingFormKind.LetStar],
  ["FLET", BindingFormKind.Flet],
  ["LABELS", BindingFormKind.Labels],
  ["MACROLET", BindingFormKind.Macrolet],
  ["SYMBOL-MACROLET", BindingFormKind.SymbolMacrolet],
  ["MULTIPLE-VALUE-BIND", BindingFormKind.MultipleValueBind],
  ["DESTRUCTURING-BIND", BindingFormKind.DestructuringBind],
  ["LAMBDA", BindingFormKind.Lambda],
]);

/** Returns the binding-form kind for an operator name, if it introduces one. */
export function bindingFormKind(operator: string): BindingFormKind | undefined {
  return BINDING_FORMS.get(operator);
}

/**
 * Definer operators whose lambda list introduces lexical parameters over a
 * body: `defun`, `defmacro`, `defmethod`, `define-compiler-macro`. The name
 * itself is a *global* definition (indexed elsewhere); only its parameters are
 * lexical.
 */
const PARAMETERIZED_DEFINERS: ReadonlySet<string> = new Set([
  "DEFUN",
  "DEFMACRO",
  "DEFINE-COMPILER-MACRO",
  "DEFMETHOD",
  "DEFGENERIC",
]);

export function isParameterizedDefiner(operator: string): boolean {
  return PARAMETERIZED_DEFINERS.has(operator);
}

/** Canonicalizes an operator/symbol token to its upcased print name. */
export function operatorFromToken(token: string): string {
  return canonicalizeName(token);
}
