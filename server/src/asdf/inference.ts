import { WorkspaceIndex } from "../indexer/workspace-index";
import { SymbolKind, Namespace } from "../model/symbol";
import { OccurrenceRole } from "../model/resolution";
import {
  AsdfDependencyEdge,
  DependencyConfidence,
  DependencyEvidence,
  DependencyReason,
} from "./model";

/**
 * Semantic dependency inference for the ASDF model.
 *
 * This is the one ASDF module that *consumes* the M2 semantic index. It never
 * re-analyzes packages or symbols itself; it reads the existing
 * {@link WorkspaceIndex} and translates cross-file semantic relationships
 * between **mapped** components into inferred dependency edges, each of which
 * retains explicit evidence and a confidence level:
 *
 *  - package `:use` / `:import-from` relationships → **strong** (compile-time
 *    package availability matters);
 *  - use of a workspace **macro** defined in another component → **strong**
 *    (compile-time macro availability may matter);
 *  - an ordinary cross-file function/variable reference → **advisory** only.
 *
 * Advisory edges are suggestions; they are never promoted to authoritative ASDF
 * truth. An ordinary `(foo)` call does not become a required `:depends-on`.
 */

/** A source file correlated with the component it belongs to. */
export interface ComponentSource {
  /** Stable component identity, e.g. `payment/src/services`. */
  readonly componentId: string;
  /** Owning system name. */
  readonly systemName: string;
  /** The source document URI. */
  readonly uri: string;
}

export interface InferenceInput {
  readonly index: WorkspaceIndex;
  readonly sources: readonly ComponentSource[];
}

/**
 * Infers component dependency edges from the semantic index.
 *
 * Edges are de-duplicated per `(from, to, reason)` and only connect two
 * distinct mapped components. The result mixes strong and advisory edges; the
 * caller keeps them distinct from declared/serial edges.
 */
export function inferComponentEdges(input: InferenceInput): AsdfDependencyEdge[] {
  const { index, sources } = input;
  const componentByUri = new Map<string, ComponentSource>();
  for (const s of sources) componentByUri.set(s.uri, s);

  // Map every package name (and nickname) known in the workspace to the URI
  // that defines it, so we can resolve `:use` / `:import-from` targets.
  const packageDefiner = new Map<string, string>();
  for (const uri of index.documentUris) {
    const docIndex = index.getDocumentIndex(uri);
    if (!docIndex) continue;
    for (const pkg of docIndex.packages) {
      if (!packageDefiner.has(pkg.name)) packageDefiner.set(pkg.name, uri);
      for (const nick of pkg.nicknames) {
        if (!packageDefiner.has(nick)) packageDefiner.set(nick, uri);
      }
    }
  }

  const edges: AsdfDependencyEdge[] = [];
  const seen = new Set<string>();
  const add = (edge: AsdfDependencyEdge): void => {
    const key = `${edge.from}\u0000${edge.to}\u0000${edge.reason}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push(edge);
  };

  for (const source of sources) {
    inferPackageEdges(index, source, componentByUri, packageDefiner, add);
    inferSymbolEdges(index, source, componentByUri, add);
  }

  return edges;
}

/** Package `:use` / `:import-from` relationships → strong inferred edges. */
function inferPackageEdges(
  index: WorkspaceIndex,
  source: ComponentSource,
  componentByUri: Map<string, ComponentSource>,
  packageDefiner: Map<string, string>,
  add: (edge: AsdfDependencyEdge) => void,
): void {
  const docIndex = index.getDocumentIndex(source.uri);
  if (!docIndex) return;

  for (const pkg of docIndex.packages) {
    const related: Array<{ target: string; kind: "use" | "import" }> = [];
    for (const used of pkg.uses) related.push({ target: used, kind: "use" });
    for (const imp of pkg.imports) related.push({ target: imp.from, kind: "import" });
    for (const imp of pkg.shadowingImports) {
      related.push({ target: imp.from, kind: "import" });
    }

    for (const rel of related) {
      const definerUri = packageDefiner.get(rel.target);
      if (!definerUri) continue; // external/standard package: not in workspace.
      const other = componentByUri.get(definerUri);
      if (!other || other.componentId === source.componentId) continue;

      const verb = rel.kind === "use" ? "uses" : "imports from";
      const evidence: DependencyEvidence = {
        description: `package ${pkg.name} ${verb} package ${rel.target} defined in another component`,
        symbol: rel.target,
        definedInUri: definerUri,
        referencedInUri: source.uri,
        referencedInRange: pkg.selectionRange,
      };
      add({
        from: source.componentId,
        to: other.componentId,
        reason: DependencyReason.InferredPackage,
        confidence: DependencyConfidence.Strong,
        evidence,
      });
    }
  }
}

/**
 * Cross-file symbol references → strong (macro) or advisory (ordinary) edges.
 */
function inferSymbolEdges(
  index: WorkspaceIndex,
  source: ComponentSource,
  componentByUri: Map<string, ComponentSource>,
  add: (edge: AsdfDependencyEdge) => void,
): void {
  for (const occ of index.classifyDocument(source.uri)) {
    if (occ.role !== OccurrenceRole.Reference) continue;
    if (occ.target.kind !== "global") continue;

    for (const def of occ.target.symbols) {
      if (def.uri === source.uri) continue; // same file
      const other = componentByUri.get(def.uri);
      if (!other || other.componentId === source.componentId) continue;

      const isMacro = def.kind === SymbolKind.Macro;
      const symbol = `${def.package}:${def.name}`;
      const evidence: DependencyEvidence = {
        description: isMacro
          ? `macro ${symbol} is defined in another component and used here`
          : `${describeKind(def.kind, def.namespace)} ${symbol} is defined in another component and referenced here`,
        symbol,
        definedInUri: def.uri,
        definedInRange: def.selectionRange,
        referencedInUri: source.uri,
        referencedInRange: occ.node.range,
      };

      add({
        from: source.componentId,
        to: other.componentId,
        reason: isMacro
          ? DependencyReason.InferredMacro
          : DependencyReason.InferredSymbol,
        confidence: isMacro
          ? DependencyConfidence.Strong
          : DependencyConfidence.Advisory,
        evidence,
      });
    }
  }
}

function describeKind(kind: SymbolKind, namespace: Namespace): string {
  switch (kind) {
    case SymbolKind.Function:
      return "function";
    case SymbolKind.GenericFunction:
      return "generic function";
    case SymbolKind.Variable:
      return "variable";
    case SymbolKind.Constant:
      return "constant";
    case SymbolKind.Class:
      return "class";
    case SymbolKind.Struct:
      return "struct";
    case SymbolKind.Condition:
      return "condition";
    case SymbolKind.Type:
      return "type";
    default:
      return namespace === Namespace.Value ? "variable" : "symbol";
  }
}
