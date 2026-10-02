import { Range } from "../parser/position";
import { Namespace } from "./symbol";

/**
 * A coarse completion-item classification, mapped to an LSP `CompletionItemKind`
 * at the protocol boundary. It is deliberately small: it only needs to drive the
 * editor's icon/grouping, while the authoritative Lisp semantics stay in the
 * workspace index.
 */
export enum CompletionKind {
  Function = "function",
  Macro = "macro",
  GenericFunction = "generic-function",
  Method = "method",
  Variable = "variable",
  Constant = "constant",
  Class = "class",
  Struct = "struct",
  Type = "type",
  Package = "package",
  Parameter = "parameter",
  LocalFunction = "local-function",
  LocalMacro = "local-macro",
}

/**
 * A single, ranked completion candidate produced by the workspace index.
 *
 * Candidates are gathered through the same lexical/package model used for
 * navigation, so what completes always matches what resolves. `sortRank` encodes
 * the deterministic priority (nearest lexical binding first, then local/current
 * package, imports, inheritance) — there is no ML ranking.
 */
export interface CompletionCandidate {
  /** Print name as it should appear/insert (source-cased). */
  readonly label: string;
  readonly insertText: string;
  readonly kind: CompletionKind;
  readonly namespace: Namespace;
  /** Canonical owning package, when the candidate is a global symbol. */
  readonly package?: string;
  /** Short right-hand detail: lambda list and/or accessibility note. */
  readonly detail?: string;
  readonly documentation?: string;
  /** Lower sorts earlier. */
  readonly sortRank: number;
  /** Source range the insertion replaces (the symbol-name part of the token). */
  readonly replaceRange: Range;
}
