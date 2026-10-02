import {
  AsdfComponent,
  AsdfDependencyEdge,
  AsdfSystem,
  DependencyConfidence,
  DependencyReason,
  walkComponents,
} from "./model";

/**
 * Dependency-graph construction, stable topological ordering and cycle
 * detection for the static ASDF model.
 *
 * This module is pure: it works only on the {@link AsdfSystem} model produced by
 * the safe parser and never touches the Lisp semantic index. Declared
 * (`:depends-on`) and serial-derived edges are both produced here but stay
 * distinguishable via {@link AsdfDependencyEdge.reason} / `confidence`.
 */

/** A simple directed graph keyed by node id, with categorized edges. */
export interface DependencyGraph {
  /** Node ids in declared (textual) order. */
  readonly nodes: string[];
  /** Directed edges where `from` depends on `to`. */
  readonly edges: AsdfDependencyEdge[];
}

/** A concrete, explainable dependency cycle. */
export interface CycleInfo {
  /** The cycle path, with the entry node repeated at the end, e.g.
   * `["api", "services", "repository", "api"]`. */
  readonly path: string[];
  /** The edges traversed, in order. */
  readonly edges: AsdfDependencyEdge[];
}

export interface TopologicalResult {
  /** A stable topological order (dependencies before dependents). */
  readonly order: string[];
  /** True when a cycle prevented a total ordering. */
  readonly hasCycle: boolean;
  /** Nodes that could not be ordered because they are on/behind a cycle. */
  readonly unordered: string[];
}

// ---------------------------------------------------------------------------
// component graph
// ---------------------------------------------------------------------------

/**
 * Builds the component dependency graph for one system.
 *
 * Within each parent scope (the system root, or a module's children) it emits:
 *  - an {@link DependencyReason.Explicit} edge for every resolvable sibling
 *    `:depends-on` reference, and
 *  - {@link DependencyReason.Serial} edges — when the scope is `:serial` — from
 *    each component to **all** preceding siblings (ASDF serial semantics).
 *
 * Serial is applied independently per scope, so nested modules keep their own
 * ordering. Missing `:depends-on` targets are intentionally skipped here (they
 * are reported by the diagnostics module); the textual component order is
 * preserved separately in {@link AsdfSystem.components}.
 */
export function buildComponentGraph(system: AsdfSystem): DependencyGraph {
  const nodes: string[] = [];
  walkComponents(system.components, (c) => nodes.push(c.id));

  const edges: AsdfDependencyEdge[] = [];

  const visitScope = (siblings: readonly AsdfComponent[], serial: boolean): void => {
    const byName = new Map<string, AsdfComponent>();
    for (const c of siblings) {
      if (!byName.has(c.name)) byName.set(c.name, c);
    }

    siblings.forEach((comp, index) => {
      for (const dep of comp.dependsOn) {
        const target = byName.get(dep.name);
        if (target && target.id !== comp.id) {
          edges.push({
            from: comp.id,
            to: target.id,
            reason: DependencyReason.Explicit,
            confidence: DependencyConfidence.Authoritative,
          });
        }
      }
      if (serial) {
        for (let j = 0; j < index; j++) {
          edges.push({
            from: comp.id,
            to: siblings[j].id,
            reason: DependencyReason.Serial,
            confidence: DependencyConfidence.Authoritative,
          });
        }
      }
    });

    for (const comp of siblings) {
      if (comp.children.length > 0) visitScope(comp.children, comp.serial);
    }
  };

  visitScope(system.components, system.serial);
  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// system graph
// ---------------------------------------------------------------------------

/**
 * Builds the workspace system graph.
 *
 * Nodes are every declared system plus any referenced dependency name (external
 * systems like `"alexandria"` appear as leaf nodes and are *not* errors).
 * `:depends-on` and `:defsystem-depends-on` become authoritative edges;
 * `:weakly-depends-on` becomes an advisory edge so optional links never force
 * ordering or trip cycle diagnostics.
 */
export function buildSystemGraph(systems: readonly AsdfSystem[]): DependencyGraph {
  const nodes: string[] = [];
  const seen = new Set<string>();
  const addNode = (name: string): void => {
    if (!seen.has(name)) {
      seen.add(name);
      nodes.push(name);
    }
  };

  for (const s of systems) addNode(s.name);

  const edges: AsdfDependencyEdge[] = [];
  const addEdges = (
    s: AsdfSystem,
    refs: AsdfSystem["dependsOn"],
    confidence: DependencyConfidence,
  ): void => {
    for (const ref of refs) {
      addNode(ref.name);
      if (ref.name === s.name) continue;
      edges.push({
        from: s.name,
        to: ref.name,
        reason: DependencyReason.Explicit,
        confidence,
      });
    }
  };

  for (const s of systems) {
    addEdges(s, s.dependsOn, DependencyConfidence.Authoritative);
    addEdges(s, s.defsystemDependsOn, DependencyConfidence.Authoritative);
    addEdges(s, s.weaklyDependsOn, DependencyConfidence.Advisory);
  }

  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// ordering & cycles
// ---------------------------------------------------------------------------

/**
 * Computes a stable topological order where dependencies precede dependents.
 *
 * Only {@link DependencyConfidence.Authoritative} edges constrain the order, so
 * advisory/inferred suggestions never reorder the build. When several orders
 * are valid, declared (textual) order is preserved. Nodes trapped by a cycle
 * are reported in {@link TopologicalResult.unordered} rather than guessed.
 */
export function topologicalOrder(
  graph: DependencyGraph,
  options: { authoritativeOnly?: boolean } = {},
): TopologicalResult {
  const authoritativeOnly = options.authoritativeOnly ?? true;
  const nodeSet = new Set(graph.nodes);
  const edges = graph.edges.filter(
    (e) =>
      nodeSet.has(e.from) &&
      nodeSet.has(e.to) &&
      (!authoritativeOnly || e.confidence === DependencyConfidence.Authoritative),
  );

  // outDegree[node] = number of unresolved dependencies it still has.
  const outDegree = new Map<string, number>();
  for (const n of graph.nodes) outDegree.set(n, 0);
  // dependents[to] = nodes that depend on `to`.
  const dependents = new Map<string, string[]>();
  for (const e of edges) {
    if (e.from === e.to) continue;
    outDegree.set(e.from, (outDegree.get(e.from) ?? 0) + 1);
    const list = dependents.get(e.to) ?? [];
    list.push(e.from);
    dependents.set(e.to, list);
  }

  const order: string[] = [];
  const emitted = new Set<string>();
  let progressed = true;
  while (progressed) {
    progressed = false;
    // Stable: scan nodes in declared order and emit any with no deps left.
    for (const n of graph.nodes) {
      if (emitted.has(n)) continue;
      if ((outDegree.get(n) ?? 0) === 0) {
        emitted.add(n);
        order.push(n);
        progressed = true;
        for (const dep of dependents.get(n) ?? []) {
          outDegree.set(dep, (outDegree.get(dep) ?? 0) - 1);
        }
      }
    }
  }

  const unordered = graph.nodes.filter((n) => !emitted.has(n));
  return { order, hasCycle: unordered.length > 0, unordered };
}

/**
 * Finds concrete dependency cycles and returns an explainable path for each.
 *
 * Only {@link DependencyConfidence.Authoritative} edges are considered by
 * default so advisory/inferred suggestions can never be reported as a hard
 * cycle. Cycles are de-duplicated by their normalized node set.
 */
export function findCycles(
  graph: DependencyGraph,
  options: { authoritativeOnly?: boolean } = {},
): CycleInfo[] {
  const authoritativeOnly = options.authoritativeOnly ?? true;
  const nodeSet = new Set(graph.nodes);
  const adjacency = new Map<string, AsdfDependencyEdge[]>();
  for (const e of graph.edges) {
    if (!nodeSet.has(e.from) || !nodeSet.has(e.to)) continue;
    if (authoritativeOnly && e.confidence !== DependencyConfidence.Authoritative) continue;
    const list = adjacency.get(e.from) ?? [];
    list.push(e);
    adjacency.set(e.from, list);
  }

  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const n of graph.nodes) color.set(n, WHITE);

  const cycles: CycleInfo[] = [];
  const seenKeys = new Set<string>();
  const nodeStack: string[] = [];
  const edgeStack: AsdfDependencyEdge[] = [];

  const recordCycle = (startNode: string, backEdge: AsdfDependencyEdge): void => {
    const startIndex = nodeStack.indexOf(startNode);
    if (startIndex < 0) return;
    const pathNodes = nodeStack.slice(startIndex);
    const pathEdges = edgeStack.slice(startIndex).concat(backEdge);
    const key = normalizeCycleKey(pathNodes);
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    cycles.push({ path: [...pathNodes, startNode], edges: pathEdges });
  };

  const dfs = (node: string): void => {
    color.set(node, GRAY);
    nodeStack.push(node);
    for (const edge of adjacency.get(node) ?? []) {
      const next = edge.to;
      const c = color.get(next);
      if (c === GRAY) {
        recordCycle(next, edge);
      } else if (c === WHITE) {
        edgeStack.push(edge);
        dfs(next);
        edgeStack.pop();
      }
    }
    nodeStack.pop();
    color.set(node, BLACK);
  };

  for (const n of graph.nodes) {
    if (color.get(n) === WHITE) dfs(n);
  }
  return cycles;
}

/** Normalizes a cycle to a rotation-independent key for de-duplication. */
function normalizeCycleKey(nodes: readonly string[]): string {
  if (nodes.length === 0) return "";
  let minIndex = 0;
  for (let i = 1; i < nodes.length; i++) {
    if (nodes[i] < nodes[minIndex]) minIndex = i;
  }
  const rotated = [...nodes.slice(minIndex), ...nodes.slice(0, minIndex)];
  return rotated.join("\u0000");
}
