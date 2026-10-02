import { Range } from "../parser/position";
import { DiagnosticSeverityName } from "../model/diagnostic";

/**
 * The static ASDF project model.
 *
 * This module defines the data the ASDF subsystem produces by reading `.asd`
 * files **statically, without ever evaluating them** (see `parser.ts`). It is
 * deliberately a *separate* model from the Lisp `SymbolDefinition` index: a
 * system/module/file build graph is a different concern from package-aware
 * symbol resolution. The ASDF model *consumes* the M2 semantic model (for
 * inference) but never owns Lisp semantics.
 *
 * Because `.asd` files are untrusted executable Lisp, every value here is
 * either a safely extracted literal or explicitly marked uncertain. Nothing in
 * this model is ever guessed from a dynamic/computed form.
 */

/** Marker used in stable component identities to separate path segments. */
export const ID_SEPARATOR = "/";

/**
 * How confident the static analysis is about a piece of ASDF information.
 *
 * A value is only {@link Certainty.Known} when it was extracted from a literal
 * the reader can understand without evaluation. Anything computed, custom or
 * guarded is surfaced as uncertain rather than guessed.
 */
export enum Certainty {
  /** Extracted from a literal; safe to rely on statically. */
  Known = "known",
  /** Guarded by `#+`/`#-` or ASDF `:if-feature`; present but conditionally active. */
  Conditional = "conditional",
  /** Computed at read/load time (e.g. `#.`, a function call); not knowable statically. */
  Dynamic = "dynamic",
  /** A recognized construct whose full semantics M3 does not model. */
  Unsupported = "unsupported",
  /** Structurally present but otherwise opaque. */
  Unknown = "unknown",
}

/** Why one node depends on another. Keeps declared/serial/inferred distinct. */
export enum DependencyReason {
  /** An explicit `:depends-on` in the `.asd`. Authoritative. */
  Explicit = "explicit",
  /** Derived from `:serial t` ordering. Authoritative. */
  Serial = "serial",
  /** Inferred from a `defpackage` `:use`/`:import-from` relationship. Strong. */
  InferredPackage = "inferred-package",
  /** Inferred from use of a workspace macro defined in another component. Strong. */
  InferredMacro = "inferred-macro",
  /** Inferred from an ordinary cross-file symbol/function reference. Advisory. */
  InferredSymbol = "inferred-symbol",
}

/**
 * The strength of a dependency claim.
 *
 *  - {@link Authoritative}: declared in the `.asd` (`:depends-on`, `:serial`).
 *  - {@link Strong}: a package or macro relationship that genuinely affects
 *    compile-time availability.
 *  - {@link Advisory}: an ordinary cross-file reference; a suggestion only,
 *    never treated as a required ASDF dependency.
 */
export enum DependencyConfidence {
  Authoritative = "authoritative",
  Strong = "strong",
  Advisory = "advisory",
}

/** Evidence retained for an *inferred* dependency so it is explainable. */
export interface DependencyEvidence {
  /** Human-readable summary, e.g. "package :payment.services uses :payment.model". */
  readonly description: string;
  /** The symbol that links the two components, e.g. `PAYMENT.REPOSITORY:SAVE`. */
  readonly symbol?: string;
  /** Where the linking symbol / package is defined. */
  readonly definedInUri?: string;
  /** Range of the definition, when known (for navigation). */
  readonly definedInRange?: Range;
  /** Where the linking symbol / package is referenced. */
  readonly referencedInUri?: string;
  /** Range of the reference, when known (for navigation). */
  readonly referencedInRange?: Range;
}

/**
 * A dependency edge between two nodes (component ids, or system names).
 *
 * Declared, serial-derived and inferred edges are all represented here but stay
 * distinguishable through {@link reason} and {@link confidence}; an inferred
 * edge additionally keeps its {@link evidence}.
 */
export interface AsdfDependencyEdge {
  /** The dependent node (component id or system name). */
  readonly from: string;
  /** The depended-upon node (component id or system name). */
  readonly to: string;
  readonly reason: DependencyReason;
  readonly confidence: DependencyConfidence;
  /** Present for inferred edges only. */
  readonly evidence?: DependencyEvidence;
}

/** A reference to another system or sibling component, with its source range. */
export interface AsdfReference {
  /** The coerced name exactly as a literal (string kept verbatim; symbol downcased). */
  readonly name: string;
  /** The range of the reference token in the `.asd` source. */
  readonly range: Range;
  /** {@link Certainty.Known} for a literal; otherwise dynamic/conditional. */
  readonly certainty: Certainty;
  /** Raw feature expression when the reference is `(:feature …)` guarded. */
  readonly featureExpression?: string;
}

/** A note explaining an uncertainty attached to a system or component. */
export interface AsdfCondition {
  readonly message: string;
  readonly certainty: Certainty;
  /** Source range the uncertainty relates to, when known. */
  readonly range?: Range;
}

/**
 * A single ASDF component: a `:file`, `:module`, `:static-file` or custom type.
 *
 * Identity is stable and hierarchical: `system/<module…>/name` (e.g.
 * `payment/src/model`), suitable for future runtime reconciliation (M4).
 */
export interface AsdfComponent {
  /** Stable hierarchical identity, e.g. `payment/src/model`. */
  readonly id: string;
  /** The component name exactly as written (coerced: string kept, symbol downcased). */
  readonly name: string;
  /**
   * Normalized component type: `file`, `module`, `static-file`, or a custom
   * type name verbatim (e.g. `cl-source-file.cl`). Never invented.
   */
  readonly type: string;
  /** {@link Certainty.Known} for the three standard types; otherwise unknown/custom. */
  readonly typeCertainty: Certainty;
  /** Owning system name. */
  readonly system: string;
  /** Parent component id, or undefined for a system-root component. */
  readonly parentId?: string;
  /** Range of the whole `(:file "x" …)` declaration form. */
  readonly declarationRange: Range;
  /** Range of the name token (navigation / diagnostics target). */
  readonly nameRange?: Range;
  /** Literal `:pathname` override as written, when present and static. */
  readonly pathname?: string;
  /**
   * Statically resolved file URI for this component, when the class/path/name
   * make it unambiguous. Never fabricated for custom/dynamic components.
   */
  readonly effectiveUri?: string;
  /** Module-local `:serial` flag. */
  readonly serial: boolean;
  /** Explicit sibling `:depends-on` references. */
  readonly dependsOn: AsdfReference[];
  /** Child components (modules only); files have none. */
  readonly children: AsdfComponent[];
  /** Overall uncertainty for this component. */
  readonly certainty: Certainty;
  /** Raw `#+`/`#-` or `:if-feature` expression guarding the component, if any. */
  readonly featureExpression?: string;
  /** Uncertainty notes. */
  readonly conditions: AsdfCondition[];
}

/** A statically discovered `defsystem` (primary or secondary system). */
export interface AsdfSystem {
  /** System name, e.g. `payment` or `payment/test`. */
  readonly name: string;
  /** {@link Certainty.Dynamic} when the name is computed rather than a literal. */
  readonly nameCertainty: Certainty;
  /** URI of the `.asd` file the system was declared in. */
  readonly uri: string;
  /** Range of the whole `defsystem` form. */
  readonly formRange: Range;
  /** Range of the name token. */
  readonly nameRange?: Range;
  /** Normalized `:class` value (downcased), when literal. */
  readonly className?: string;
  /** True when `:class :package-inferred-system` is declared. */
  readonly packageInferred: boolean;
  /** Literal `:pathname` override, when present and static. */
  readonly pathname?: string;
  /** Top-level `:serial` flag. */
  readonly serial: boolean;
  /** `:depends-on` (ordinary system dependencies). */
  readonly dependsOn: AsdfReference[];
  /** `:defsystem-depends-on` (build-time system dependencies). */
  readonly defsystemDependsOn: AsdfReference[];
  /** `:weakly-depends-on` (optional system dependencies). */
  readonly weaklyDependsOn: AsdfReference[];
  /** Top-level components in declaration order. */
  readonly components: AsdfComponent[];
  readonly description?: string;
  readonly version?: string;
  readonly author?: string;
  readonly maintainer?: string;
  readonly license?: string;
  /** Normalized `:default-component-class`, when literal. */
  readonly defaultComponentClass?: string;
  /** Raw `:if-feature` / reader-conditional expression guarding the system. */
  readonly featureExpression?: string;
  readonly certainty: Certainty;
  readonly conditions: AsdfCondition[];
}

/** The systems discovered in a single `.asd` file. */
export interface AsdfFile {
  readonly uri: string;
  readonly systems: AsdfSystem[];
  /**
   * Literal `asdf:register-system-packages` registrations found in the file.
   * Used for conservative `package-inferred-system` package→system mapping.
   * Empty when none are present or they are not statically literal.
   */
  readonly registeredPackages: AsdfRegisteredPackages[];
}

/**
 * A statically literal `(asdf:register-system-packages SYSTEM (PKG…))` form.
 *
 * Only pure-literal forms are captured; computed system names or package lists
 * are skipped rather than guessed.
 */
export interface AsdfRegisteredPackages {
  /** The system name the packages are registered to (coerced literal). */
  readonly system: string;
  /** Canonical UPPERCASE package names registered to the system. */
  readonly packages: string[];
  /** Range of the whole registration form. */
  readonly range: Range;
  readonly certainty: Certainty;
}

/** A conservative ASDF project diagnostic (missing component, cycle, …). */
export interface AsdfDiagnostic {
  readonly uri: string;
  readonly range: Range;
  readonly message: string;
  readonly severity: DiagnosticSeverityName;
  /** Stable machine-readable code, e.g. `asdf-missing-component`. */
  readonly code: string;
  readonly source: string;
}

/** Diagnostic source tag for ASDF project diagnostics. */
export const ASDF_DIAGNOSTIC_SOURCE = "sexpr-scope-asdf";

/** Builds the stable hierarchical identity of a component. */
export function componentId(
  system: string,
  parentId: string | undefined,
  name: string,
): string {
  const base = parentId ?? system;
  return `${base}${ID_SEPARATOR}${name}`;
}

/** Depth-first walk over a component and its descendants. */
export function walkComponents(
  components: readonly AsdfComponent[],
  visit: (component: AsdfComponent) => void,
): void {
  for (const component of components) {
    visit(component);
    walkComponents(component.children, visit);
  }
}
