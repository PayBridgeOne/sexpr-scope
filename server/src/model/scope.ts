import { Range, rangeContainsOffset } from "../parser/position";
import { Namespace } from "./symbol";

/**
 * The lexical model.
 *
 * Common Lisp has first-class lexical scope and *separate* function and value
 * namespaces (it is a Lisp-2). A `let` variable and an `flet` function of the
 * same name are distinct bindings that must never collide. This module models
 * lexical bindings and the nested scopes that contain them, so later features
 * (Go to Definition, Find References, completion, semantic tokens) can share one
 * correct notion of lexical identity rather than matching text.
 *
 * Lexical bindings are *not* package-owned: a `let` variable has no package.
 * The model therefore deliberately avoids inventing a fake package for them.
 */

/** The kind of lexical binding, used for hover/semantic classification. */
export enum LexicalBindingKind {
  /** A function/macro lambda-list parameter (`defun`, `lambda`, `flet`, …). */
  Parameter = "parameter",
  /** A `let` / `let*` variable. */
  LetVariable = "let-variable",
  /** A `flet` / `labels` local function. */
  LocalFunction = "local-function",
  /** A `macrolet` local macro. */
  LocalMacro = "local-macro",
  /** A `symbol-macrolet` local symbol macro. */
  SymbolMacro = "symbol-macro",
  /** A `multiple-value-bind` variable. */
  MultipleValue = "multiple-value",
  /** A `destructuring-bind` (or destructuring lambda-list) variable. */
  Destructuring = "destructuring",
}

/**
 * A single lexical binding: a name introduced over a source region.
 *
 * `scopeRange` is the region over which the binding is *live* (visible). It may
 * be narrower than the enclosing scope's range — e.g. a `let` variable is not
 * visible inside the initializer forms of its own `let`, and a `let*` variable
 * is visible only from the clause after its own.
 */
export interface LexicalBinding {
  readonly name: string;
  /** Lexical bindings live in the function or value namespace only. */
  readonly namespace: Namespace.Function | Namespace.Value;
  readonly bindingKind: LexicalBindingKind;
  readonly uri: string;
  /** The binding's own name token — the Go-to-Definition target. */
  readonly selectionRange: Range;
  /** The region over which this binding is visible. */
  readonly scopeRange: Range;
  /** Raw lambda list, for local functions/macros (signature help). */
  readonly lambdaList?: string;
  /**
   * A stable semantic identity for this binding, unique within the workspace.
   * Two textually identical names in different scopes get different ids, so
   * references and rename can match identity rather than text.
   */
  readonly id: string;
}

/** Builds the stable identity string for a lexical binding. */
export function lexicalBindingId(
  uri: string,
  selectionRange: Range,
  namespace: Namespace,
): string {
  return `lexical:${uri}:${selectionRange.start.offset}:${namespace}`;
}

/**
 * A lexical scope: a source region that may introduce bindings and contain
 * nested child scopes. The root scope of a document introduces no bindings; it
 * represents the top level where only global/package resolution applies.
 */
export class Scope {
  readonly bindings: LexicalBinding[] = [];
  readonly children: Scope[] = [];

  constructor(
    readonly range: Range,
    readonly parent: Scope | undefined,
  ) {}

  addBinding(binding: LexicalBinding): void {
    this.bindings.push(binding);
  }

  newChild(range: Range): Scope {
    const child = new Scope(range, this);
    this.children.push(child);
    return child;
  }

  /** The innermost scope (this or a descendant) whose range contains offset. */
  innermostAt(offset: number): Scope {
    for (const child of this.children) {
      if (rangeContainsOffset(child.range, offset)) {
        return child.innermostAt(offset);
      }
    }
    return this;
  }

  /**
   * Resolves a lexical reference by name + namespace at a source offset.
   *
   * Walks from the innermost scope outward, so an inner binding correctly
   * shadows an outer one. Within a scope only bindings whose `scopeRange`
   * actually covers the offset are considered, which encodes the LET vs LET*
   * and FLET vs LABELS visibility differences.
   */
  resolve(
    offset: number,
    name: string,
    namespace: Namespace.Function | Namespace.Value,
  ): LexicalBinding | undefined {
    let scope: Scope | undefined = this.innermostAt(offset);
    while (scope) {
      // Last matching binding wins within a scope (later rebinding shadows).
      for (let i = scope.bindings.length - 1; i >= 0; i--) {
        const b = scope.bindings[i];
        if (
          b.name === name &&
          b.namespace === namespace &&
          rangeContainsOffset(b.scopeRange, offset)
        ) {
          return b;
        }
      }
      scope = scope.parent;
    }
    return undefined;
  }

  /**
   * Every binding visible at an offset, innermost first, with outer bindings
   * shadowed by an inner binding of the same name + namespace. Used by
   * completion to offer the lexical environment at the cursor.
   */
  visibleBindings(offset: number): LexicalBinding[] {
    const seen = new Set<string>();
    const result: LexicalBinding[] = [];
    let scope: Scope | undefined = this.innermostAt(offset);
    while (scope) {
      for (let i = scope.bindings.length - 1; i >= 0; i--) {
        const b = scope.bindings[i];
        if (!rangeContainsOffset(b.scopeRange, offset)) continue;
        const key = `${b.namespace}:${b.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(b);
      }
      scope = scope.parent;
    }
    return result;
  }

  /** Collects every binding in this scope subtree (for Find References). */
  allBindings(out: LexicalBinding[] = []): LexicalBinding[] {
    for (const b of this.bindings) out.push(b);
    for (const child of this.children) child.allBindings(out);
    return out;
  }
}
