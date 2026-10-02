import {
  AsdfComponent,
  AsdfDiagnostic,
  AsdfSystem,
  ASDF_DIAGNOSTIC_SOURCE,
  Certainty,
} from "./model";
import { buildComponentGraph, buildSystemGraph, findCycles } from "./graph";

/**
 * Conservative static project diagnostics for the ASDF model.
 *
 * Only *statically definite* problems are reported:
 *  - a component `:depends-on` that names a sibling which does not exist;
 *  - an authoritative dependency cycle (declared / serial edges only);
 *  - a known-missing source file (a component whose path is fully static);
 *  - an unambiguous duplicate component identity within one scope.
 *
 * Anything uncertain — dynamic names, computed paths, custom component classes,
 * or reader-conditional / `:if-feature` guarded nodes — is never diagnosed as
 * wrong. Diagnostics point at useful `.asd` source ranges.
 */

export interface AsdfDiagnosticsInput {
  /** All systems to analyze (typically every system in one `.asd` file). */
  readonly systems: readonly AsdfSystem[];
  /** Predicate telling whether a resolved source URI exists on disk. */
  readonly fileExists?: (uri: string) => boolean;
}

export const ASDF_DIAGNOSTIC_CODES = {
  MissingComponent: "asdf-missing-component",
  DuplicateComponent: "asdf-duplicate-component",
  MissingSource: "asdf-missing-source",
  Cycle: "asdf-cycle",
  SystemCycle: "asdf-system-cycle",
} as const;

export function computeAsdfDiagnostics(
  input: AsdfDiagnosticsInput,
): AsdfDiagnostic[] {
  const diagnostics: AsdfDiagnostic[] = [];
  for (const system of input.systems) {
    collectScopeDiagnostics(system, system.components, diagnostics, input.fileExists);
    collectComponentCycles(system, diagnostics);
  }
  collectSystemCycles(input.systems, diagnostics);
  return diagnostics;
}

/** Walks one parent scope: duplicate ids, missing deps and missing sources. */
function collectScopeDiagnostics(
  system: AsdfSystem,
  siblings: readonly AsdfComponent[],
  out: AsdfDiagnostic[],
  fileExists: ((uri: string) => boolean) | undefined,
): void {
  const seenNames = new Set<string>();
  const byName = new Map<string, AsdfComponent>();
  for (const comp of siblings) {
    if (!byName.has(comp.name)) byName.set(comp.name, comp);
  }

  for (const comp of siblings) {
    // Duplicate component identity (same name in the same scope).
    if (comp.name && comp.certainty !== Certainty.Dynamic) {
      if (seenNames.has(comp.name)) {
        out.push({
          uri: system.uri,
          range: comp.nameRange ?? comp.declarationRange,
          message: `Duplicate component "${comp.name}" in the same module; the identity "${comp.id}" is ambiguous.`,
          severity: "warning",
          code: ASDF_DIAGNOSTIC_CODES.DuplicateComponent,
          source: ASDF_DIAGNOSTIC_SOURCE,
        });
      }
      seenNames.add(comp.name);
    }

    // Missing component referenced by :depends-on (literal names only).
    for (const dep of comp.dependsOn) {
      if (dep.certainty !== Certainty.Known) continue;
      if (!byName.has(dep.name)) {
        out.push({
          uri: system.uri,
          range: dep.range,
          message: `Component "${comp.name}" depends on "${dep.name}", which is not a sibling component.`,
          severity: "warning",
          code: ASDF_DIAGNOSTIC_CODES.MissingComponent,
          source: ASDF_DIAGNOSTIC_SOURCE,
        });
      }
    }

    // Known-missing source file (only when the path is fully static).
    if (
      fileExists &&
      comp.children.length === 0 &&
      comp.effectiveUri &&
      comp.certainty === Certainty.Known &&
      comp.typeCertainty === Certainty.Known &&
      !comp.featureExpression
    ) {
      if (!fileExists(comp.effectiveUri)) {
        out.push({
          uri: system.uri,
          range: comp.nameRange ?? comp.declarationRange,
          message: `Source file for component "${comp.name}" was not found on disk.`,
          severity: "warning",
          code: ASDF_DIAGNOSTIC_CODES.MissingSource,
          source: ASDF_DIAGNOSTIC_SOURCE,
        });
      }
    }

    if (comp.children.length > 0) {
      collectScopeDiagnostics(system, comp.children, out, fileExists);
    }
  }
}

/** Reports authoritative cycles within a system's component graph. */
function collectComponentCycles(system: AsdfSystem, out: AsdfDiagnostic[]): void {
  const graph = buildComponentGraph(system);
  const cycles = findCycles(graph, { authoritativeOnly: true });
  for (const cycle of cycles) {
    out.push({
      uri: system.uri,
      range: system.nameRange ?? system.formRange,
      message: `Dependency cycle between components: ${renderCycle(cycle.path)}.`,
      severity: "error",
      code: ASDF_DIAGNOSTIC_CODES.Cycle,
      source: ASDF_DIAGNOSTIC_SOURCE,
    });
  }
}

/** Reports authoritative cycles across declared workspace systems. */
function collectSystemCycles(
  systems: readonly AsdfSystem[],
  out: AsdfDiagnostic[],
): void {
  const graph = buildSystemGraph(systems);
  const cycles = findCycles(graph, { authoritativeOnly: true });
  if (cycles.length === 0) return;
  const byName = new Map(systems.map((s) => [s.name, s]));
  for (const cycle of cycles) {
    // Anchor the diagnostic on a declared system in the cycle.
    const anchor = cycle.path.map((n) => byName.get(n)).find((s) => s);
    if (!anchor) continue;
    out.push({
      uri: anchor.uri,
      range: anchor.nameRange ?? anchor.formRange,
      message: `Dependency cycle between systems: ${renderCycle(cycle.path)}.`,
      severity: "error",
      code: ASDF_DIAGNOSTIC_CODES.SystemCycle,
      source: ASDF_DIAGNOSTIC_SOURCE,
    });
  }
}

function renderCycle(path: readonly string[]): string {
  return path.join(" \u2192 ");
}
