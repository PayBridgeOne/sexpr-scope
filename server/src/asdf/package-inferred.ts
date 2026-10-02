import * as path from "path";
import { WorkspaceIndex } from "../indexer/workspace-index";
import { fsPathFromUri } from "./parser";
import {
  AsdfCondition,
  AsdfDependencyEdge,
  AsdfRegisteredPackages,
  AsdfSystem,
  Certainty,
  DependencyConfidence,
  DependencyReason,
} from "./model";

/**
 * Conservative `:class :package-inferred-system` support.
 *
 * In a package-inferred system each source file is its own secondary system,
 * named by its path relative to the system root (e.g. file `foo.lisp` under
 * system `my-lib` is system `my-lib/foo`). Inter-file build dependencies are
 * derived from each file's `defpackage` `:use` / `:import-from` clauses: if a
 * file's package uses/imports a package defined by another file in the same
 * system, that is a strong compile-order dependency.
 *
 * SAFETY / SCOPE
 * --------------
 * This reuses the M2 package index only (no evaluation, no macroexpansion). It
 * models the statically obvious subset the spec asks for:
 *   - secondary system naming by relative path (where the path is literal);
 *   - `:use` / `:import-from` package dependencies;
 *   - literal `asdf:register-system-packages` package→system mappings.
 *
 * It deliberately does NOT implement the full UIOP package DSL. `:mix`,
 * `:reexport`, `:use-reexport`, computed naming/path conventions and non-literal
 * registrations remain unsupported and are surfaced as uncertainty rather than
 * guessed.
 */

/** A secondary system inferred from a single source file. */
export interface PackageInferredSystem {
  /** The owning package-inferred primary system name. */
  readonly primary: string;
  /** Stable system name, e.g. `my-lib/foo` (or the primary for its own file). */
  readonly name: string;
  /** Source file URI backing this secondary system. */
  readonly uri: string;
  /** The primary package the file defines, when one is statically clear. */
  readonly packageName?: string;
  readonly certainty: Certainty;
}

export interface PackageInferredResult {
  readonly systems: PackageInferredSystem[];
  /** Dependency edges between secondary systems (reason=inferred-package, strong). */
  readonly edges: AsdfDependencyEdge[];
  readonly conditions: AsdfCondition[];
}

export interface PackageInferredInput {
  readonly index: WorkspaceIndex;
  readonly system: AsdfSystem;
  /** Literal registrations from the same `.asd` file, if any. */
  readonly registeredPackages?: readonly AsdfRegisteredPackages[];
}

const SOURCE_EXTS = new Set([".lisp", ".cl", ".lsp"]);

export function analyzePackageInferredSystem(
  input: PackageInferredInput,
): PackageInferredResult {
  const { index, system } = input;
  const conditions: AsdfCondition[] = [];

  const rootDir = systemRootDir(system);
  if (rootDir === undefined) {
    conditions.push({
      message:
        "package-inferred-system root path is not statically known; secondary systems cannot be mapped.",
      certainty: Certainty.Dynamic,
      range: system.formRange,
    });
    return { systems: [], edges: [], conditions };
  }

  // Enumerate indexed source files under the system root; each becomes a
  // secondary system named by its relative path.
  const filesBySystem = new Map<string, string>(); // systemName -> uri
  for (const uri of index.documentUris) {
    const fsPath = fsPathFromUri(uri);
    if (fsPath === undefined) continue;
    if (!SOURCE_EXTS.has(path.extname(fsPath).toLowerCase())) continue;
    const rel = path.relative(rootDir, fsPath);
    if (rel.startsWith("..") || path.isAbsolute(rel)) continue;
    const suffix = rel
      .slice(0, rel.length - path.extname(rel).length)
      .split(path.sep)
      .join("/")
      .toLowerCase();
    if (suffix.length === 0) continue;
    const name = suffix === system.name ? system.name : `${system.name}/${suffix}`;
    if (!filesBySystem.has(name)) filesBySystem.set(name, uri);
  }

  // Map canonical (UPPERCASE) package names to the secondary system that defines
  // them, plus any literal register-system-packages registrations.
  const packageToSystem = new Map<string, string>();
  for (const [name, uri] of filesBySystem) {
    const docIndex = index.getDocumentIndex(uri);
    if (!docIndex) continue;
    for (const pkg of docIndex.packages) {
      registerPackage(packageToSystem, pkg.name, name);
      for (const nick of pkg.nicknames) registerPackage(packageToSystem, nick, name);
    }
  }
  for (const reg of input.registeredPackages ?? []) {
    const target = resolveRegisteredSystem(reg.system, filesBySystem, system.name);
    if (!target) continue;
    for (const pkg of reg.packages) registerPackage(packageToSystem, pkg, target);
    if (reg.certainty !== Certainty.Known) {
      conditions.push({
        message: `register-system-packages for "${reg.system}" has a non-literal package list; it is only partially modeled.`,
        certainty: Certainty.Dynamic,
        range: reg.range,
      });
    }
  }

  // Build secondary systems and their package-derived dependency edges.
  const systems: PackageInferredSystem[] = [];
  const edges: AsdfDependencyEdge[] = [];
  const seen = new Set<string>();

  for (const [name, uri] of filesBySystem) {
    const docIndex = index.getDocumentIndex(uri);
    const packages = docIndex?.packages ?? [];
    const own = packages.find((p) => p.name.toUpperCase() === name.toUpperCase()) ??
      packages[0];
    systems.push({
      primary: system.name,
      name,
      uri,
      packageName: own?.name,
      certainty: packages.length > 0 ? Certainty.Known : Certainty.Unknown,
    });

    for (const pkg of packages) {
      const referenced = new Set<string>();
      for (const used of pkg.uses) referenced.add(used.toUpperCase());
      for (const imp of pkg.imports) referenced.add(imp.from.toUpperCase());
      for (const ref of referenced) {
        const target = packageToSystem.get(ref);
        if (!target || target === name) continue;
        const key = `${name}\u0000${target}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const targetUri = filesBySystem.get(target);
        edges.push({
          from: name,
          to: target,
          reason: DependencyReason.InferredPackage,
          confidence: DependencyConfidence.Strong,
          evidence: {
            description: `package ${lower(pkg.name)} depends on package ${lower(ref)} (system ${target})`,
            symbol: ref,
            definedInUri: targetUri,
            referencedInUri: uri,
          },
        });
      }
    }
  }

  return { systems, edges, conditions };
}

function registerPackage(
  map: Map<string, string>,
  pkg: string,
  system: string,
): void {
  const key = pkg.toUpperCase();
  if (!map.has(key)) map.set(key, system);
}

function resolveRegisteredSystem(
  declared: string,
  filesBySystem: ReadonlyMap<string, string>,
  primary: string,
): string | undefined {
  const lc = declared.toLowerCase();
  if (filesBySystem.has(lc)) return lc;
  if (lc === primary.toLowerCase()) return primary;
  // Allow registering to a system named exactly as declared even if not yet
  // discovered as a file (conservative: still a valid mapping target).
  return lc;
}

function systemRootDir(system: AsdfSystem): string | undefined {
  const asdPath = fsPathFromUri(system.uri);
  if (asdPath === undefined) return undefined;
  const base = path.dirname(asdPath);
  return system.pathname ? path.resolve(base, system.pathname) : base;
}

function lower(name: string): string {
  return name.toLowerCase();
}
