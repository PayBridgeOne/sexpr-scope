import { Range } from "../parser/position";

/** Severity of a static diagnostic, mapped to LSP severities at the boundary. */
export type DiagnosticSeverityName =
  | "error"
  | "warning"
  | "information"
  | "hint";

/**
 * A conservative static diagnostic.
 *
 * Milestone 2 only emits diagnostics that are safe to infer without a running
 * Lisp image. Crucially, an unknown function/value is *never* reported as an
 * error: Common Lisp programs legitimately define names at load time, via macros
 * or at runtime, so static analysis must prefer no diagnostic over a false
 * positive (see the project's diagnostics philosophy).
 */
export interface DiagnosticInfo {
  readonly range: Range;
  readonly message: string;
  readonly severity: DiagnosticSeverityName;
  /** Stable machine-readable code, e.g. `unknown-package`. */
  readonly code: string;
  readonly source: string;
}

export const DIAGNOSTIC_SOURCE = "sexpr-scope";
