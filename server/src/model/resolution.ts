import { Range } from "../parser/position";
import { AtomNode } from "../parser/reader";
import { LexicalBinding } from "./scope";
import { Namespace, SymbolDefinition } from "./symbol";

/**
 * The semantic target a reference resolves to.
 *
 * This is the single resolution result shared by Go to Definition, Find
 * References, Hover, semantic tokens and completion, so every feature agrees on
 * what a symbol *means* rather than re-deriving Common Lisp semantics
 * independently. A target is one of:
 *
 *  - `lexical`: a lexical binding (`let`, parameter, `flet`, …). Its identity is
 *    the binding's stable id; references to it are confined to its scope.
 *  - `global`: a package-owned definition identity. `symbols` are the matching
 *    definitions (possibly several, e.g. a generic function and nothing else, or
 *    several conditional candidates); `identity` groups references across files.
 *  - `unresolved`: a well-formed reference that names nothing statically known.
 *    It still carries a stable identity so Find References can group equal uses,
 *    but Go to Definition yields no location (navigation stays conservative).
 *  - `none`: not a binding reference at all (quoted data, a keyword, an
 *    uninterned symbol, a lambda-list keyword, …).
 */
export type ResolvedTarget =
  | {
      readonly kind: "lexical";
      readonly identity: string;
      readonly binding: LexicalBinding;
    }
  | {
      readonly kind: "global";
      readonly identity: string;
      readonly namespace: Namespace;
      readonly name: string;
      readonly package: string;
      readonly symbols: SymbolDefinition[];
    }
  | {
      readonly kind: "unresolved";
      readonly identity: string;
      readonly namespace: Namespace;
      readonly name: string;
      readonly package: string;
    }
  | { readonly kind: "none" };

/** Whether an occurrence introduces a binding or refers to one. */
export enum OccurrenceRole {
  Definition = "definition",
  Reference = "reference",
}

/** A classified symbol occurrence: its atom, role and resolved target. */
export interface SemanticOccurrence {
  readonly node: AtomNode;
  readonly role: OccurrenceRole;
  readonly target: ResolvedTarget;
}

/** The resolution of a single cursor position. */
export interface Resolution {
  readonly occurrence: SemanticOccurrence;
  readonly target: ResolvedTarget;
}

/** A located reference (document uri + source range). */
export interface ReferenceLocation {
  readonly uri: string;
  readonly range: Range;
  readonly role: OccurrenceRole;
}

/** The stable identity string of a target, or `undefined` for `none`. */
export function targetIdentity(target: ResolvedTarget): string | undefined {
  return target.kind === "none" ? undefined : target.identity;
}

/** Builds the identity string for a global symbol reference. */
export function globalIdentityOf(
  pkg: string,
  name: string,
  namespace: Namespace,
): string {
  return `global:${pkg}:${name}:${namespace}`;
}
