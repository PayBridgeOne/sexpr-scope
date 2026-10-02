import { Range } from "../parser/position";
import { AsdfAnalysis } from "./project";
import {
  AsdfComponent,
  AsdfReference,
  Certainty,
  DependencyConfidence,
  DependencyReason,
} from "./model";

/**
 * Conservative, explicit ASDF Code Actions.
 *
 * The only action offered is adding a missing `:depends-on` to a component when
 * a **strong** inferred relationship (package or workspace-macro) exists between
 * two sibling components and no authoritative edge already orders them. The edit
 * is the smallest possible insertion, preserves surrounding formatting, never
 * regenerates the `defsystem` and never sorts components. Advisory (ordinary
 * function-call) relationships never produce an action, and nothing is rewritten
 * unless the user explicitly chooses the action.
 */

export interface AsdfTextEdit {
  readonly uri: string;
  /** A zero-width range marks a pure insertion point. */
  readonly range: Range;
  readonly newText: string;
}

export interface AsdfCodeAction {
  readonly title: string;
  readonly kind: "quickfix";
  readonly edit: AsdfTextEdit;
  /** The strong inference reason that motivated the action. */
  readonly reason: DependencyReason;
}

export function computeAsdfCodeActions(
  analysis: AsdfAnalysis,
  uri: string,
  selection?: Range,
): AsdfCodeAction[] {
  const actions: AsdfCodeAction[] = [];
  const emitted = new Set<string>();

  // Pre-index authoritative (declared/serial) edges to suppress redundant
  // suggestions where the components are already ordered.
  const authoritative = new Set<string>();
  for (const e of analysis.componentEdges) {
    if (e.confidence === DependencyConfidence.Authoritative) {
      authoritative.add(`${e.from}\u0000${e.to}`);
    }
  }

  for (const edge of analysis.componentEdges) {
    // Only strong inferred relationships justify editing the `.asd`.
    if (
      edge.reason !== DependencyReason.InferredPackage &&
      edge.reason !== DependencyReason.InferredMacro
    ) {
      continue;
    }
    if (edge.confidence !== DependencyConfidence.Strong) continue;

    const from = analysis.componentById.get(edge.from);
    const to = analysis.componentById.get(edge.to);
    if (!from || !to) continue;

    // A component `:depends-on` may only name a sibling (same parent scope).
    if (from.parentId !== to.parentId) continue;
    if (from.system !== to.system) continue;

    // Only act on statically certain components in the requested document.
    const sys = analysis.systemByName.get(from.system);
    if (!sys || sys.uri !== uri) continue;
    if (from.certainty === Certainty.Dynamic || to.certainty === Certainty.Dynamic) {
      continue;
    }

    // Skip if already declared or already authoritatively ordered.
    if (hasDependency(from, to.name)) continue;
    if (authoritative.has(`${from.id}\u0000${to.id}`)) continue;

    const key = `${from.id}\u0000${to.id}`;
    if (emitted.has(key)) continue;

    const edit = buildDependsOnEdit(uri, from, to.name);
    if (!edit) continue;
    if (selection && !rangeIntersects(selection, from.declarationRange)) continue;

    emitted.add(key);
    actions.push({
      title: `Add :depends-on "${to.name}" to component "${from.name}"`,
      kind: "quickfix",
      edit,
      reason: edge.reason,
    });
  }

  return actions;
}

function hasDependency(component: AsdfComponent, name: string): boolean {
  return component.dependsOn.some((d) => d.name === name);
}

/**
 * Builds the smallest insertion that adds `name` to a component's dependencies.
 *
 * If the component already has a `:depends-on (...)` list, the new name is
 * appended inside it after the last existing reference. Otherwise a fresh
 * `:depends-on ("name")` clause is inserted right after the component name.
 */
function buildDependsOnEdit(
  uri: string,
  component: AsdfComponent,
  name: string,
): AsdfTextEdit | undefined {
  if (component.dependsOn.length > 0) {
    const last: AsdfReference = component.dependsOn[component.dependsOn.length - 1];
    return {
      uri,
      range: emptyRange(last.range.end),
      newText: ` "${name}"`,
    };
  }
  if (component.nameRange) {
    return {
      uri,
      range: emptyRange(component.nameRange.end),
      newText: ` :depends-on ("${name}")`,
    };
  }
  return undefined;
}

function emptyRange(at: Range["end"]): Range {
  return { start: at, end: at };
}

function rangeIntersects(a: Range, b: Range): boolean {
  return (
    a.start.offset <= b.end.offset && b.start.offset <= a.end.offset
  );
}
