import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDocument } from "../src/parser/reader";
import { parseAsdfFile } from "../src/asdf/parser";
import {
  buildComponentGraph,
  buildSystemGraph,
  findCycles,
  topologicalOrder,
} from "../src/asdf/graph";
import {
  AsdfDependencyEdge,
  DependencyConfidence,
  DependencyReason,
} from "../src/asdf/model";

function systemsOf(text: string) {
  return parseAsdfFile(parseDocument("file:///w/test.asd", text)).systems;
}

function edge(
  edges: readonly AsdfDependencyEdge[],
  from: string,
  to: string,
): AsdfDependencyEdge | undefined {
  return edges.find((e) => e.from === from && e.to === to);
}

// ---------------------------------------------------------------------------
// :serial semantics (spec #27)
// ---------------------------------------------------------------------------

test(":serial t makes each file depend on all preceding siblings", () => {
  const [sys] = systemsOf(`
    (defsystem "s"
      :serial t
      :components ((:file "a") (:file "b") (:file "c")))
  `);
  const { edges } = buildComponentGraph(sys);
  const serial = edges.filter((e) => e.reason === DependencyReason.Serial);
  assert.equal(serial.length, 3);
  for (const [from, to] of [
    ["s/b", "s/a"],
    ["s/c", "s/a"],
    ["s/c", "s/b"],
  ]) {
    const e = edge(serial, from, to)!;
    assert.ok(e, `expected serial edge ${from} -> ${to}`);
    assert.equal(e.confidence, DependencyConfidence.Authoritative);
  }
});

test(":serial nil invents no edges", () => {
  const [sys] = systemsOf(`
    (defsystem "s"
      :serial nil
      :components ((:file "a") (:file "b") (:file "c")))
  `);
  const { edges } = buildComponentGraph(sys);
  assert.equal(edges.length, 0);
});

test("nested modules have independent :serial", () => {
  const [sys] = systemsOf(`
    (defsystem "s"
      :components ((:module "a" :serial t
                    :components ((:file "x") (:file "y")))
                   (:module "b" :serial nil
                    :components ((:file "p") (:file "q")))))
  `);
  const { edges } = buildComponentGraph(sys);
  const serial = edges.filter((e) => e.reason === DependencyReason.Serial);
  // Only module "a" is serial: y -> x. Module "b" invents nothing. The outer
  // scope is not serial, so "b" does not depend on "a".
  assert.equal(serial.length, 1);
  assert.ok(edge(serial, "s/a/y", "s/a/x"));
});

// ---------------------------------------------------------------------------
// explicit dependencies (spec #26)
// ---------------------------------------------------------------------------

test("component :depends-on produces an explicit authoritative edge", () => {
  const [sys] = systemsOf(`
    (defsystem "s"
      :components ((:file "a") (:file "b" :depends-on ("a"))))
  `);
  const { edges } = buildComponentGraph(sys);
  const e = edge(edges, "s/b", "s/a")!;
  assert.ok(e);
  assert.equal(e.reason, DependencyReason.Explicit);
  assert.equal(e.confidence, DependencyConfidence.Authoritative);
});

test("explicit and serial edges remain distinguishable", () => {
  const [sys] = systemsOf(`
    (defsystem "s"
      :serial t
      :components ((:file "a") (:file "b" :depends-on ("a"))))
  `);
  const { edges } = buildComponentGraph(sys);
  const reasons = edges
    .filter((e) => e.from === "s/b" && e.to === "s/a")
    .map((e) => e.reason)
    .sort();
  assert.deepEqual(reasons, [DependencyReason.Explicit, DependencyReason.Serial].sort());
});

test("system :depends-on / :defsystem-depends-on are authoritative; weak is advisory", () => {
  const systems = systemsOf(`
    (defsystem "s"
      :depends-on ("dep-a")
      :defsystem-depends-on ("dep-b")
      :weakly-depends-on ("dep-c"))
  `);
  const { edges } = buildSystemGraph(systems);
  assert.equal(edge(edges, "s", "dep-a")!.confidence, DependencyConfidence.Authoritative);
  assert.equal(edge(edges, "s", "dep-b")!.confidence, DependencyConfidence.Authoritative);
  assert.equal(edge(edges, "s", "dep-c")!.confidence, DependencyConfidence.Advisory);
});

test("external system dependencies are nodes, not errors", () => {
  const systems = systemsOf('(defsystem "s" :depends-on ("alexandria"))');
  const { nodes } = buildSystemGraph(systems);
  assert.ok(nodes.includes("alexandria"));
});

// ---------------------------------------------------------------------------
// graph: cycles & ordering (spec #28)
// ---------------------------------------------------------------------------

test("detects a two-node cycle with a concrete path", () => {
  const [sys] = systemsOf(`
    (defsystem "s"
      :components ((:file "a" :depends-on ("b"))
                   (:file "b" :depends-on ("a"))))
  `);
  const cycles = findCycles(buildComponentGraph(sys));
  assert.equal(cycles.length, 1);
  // Path begins and ends on the same node.
  assert.equal(cycles[0].path[0], cycles[0].path[cycles[0].path.length - 1]);
  assert.deepEqual(new Set(cycles[0].path), new Set(["s/a", "s/b"]));
});

test("detects a three-node cycle with a concrete path", () => {
  const [sys] = systemsOf(`
    (defsystem "s"
      :components ((:file "a" :depends-on ("b"))
                   (:file "b" :depends-on ("c"))
                   (:file "c" :depends-on ("a"))))
  `);
  const cycles = findCycles(buildComponentGraph(sys));
  assert.equal(cycles.length, 1);
  assert.deepEqual(new Set(cycles[0].path), new Set(["s/a", "s/b", "s/c"]));
  assert.equal(cycles[0].path.length, 4); // 3 nodes + repeat of entry
});

test("an acyclic diamond has no cycles and a stable topological order", () => {
  const [sys] = systemsOf(`
    (defsystem "s"
      :components ((:file "a")
                   (:file "b" :depends-on ("a"))
                   (:file "c" :depends-on ("a"))
                   (:file "d" :depends-on ("b" "c"))))
  `);
  const graph = buildComponentGraph(sys);
  assert.equal(findCycles(graph).length, 0);
  const { order, hasCycle } = topologicalOrder(graph);
  assert.equal(hasCycle, false);
  // a before b, c; b and c before d; declared order kept where free.
  assert.ok(order.indexOf("s/a") < order.indexOf("s/b"));
  assert.ok(order.indexOf("s/a") < order.indexOf("s/c"));
  assert.ok(order.indexOf("s/b") < order.indexOf("s/d"));
  assert.ok(order.indexOf("s/c") < order.indexOf("s/d"));
  assert.ok(order.indexOf("s/b") < order.indexOf("s/c")); // declared order preserved
});

test("topological order preserves declared order for independent nodes", () => {
  const [sys] = systemsOf(`
    (defsystem "s"
      :components ((:file "a") (:file "b") (:file "c")))
  `);
  const { order } = topologicalOrder(buildComponentGraph(sys));
  assert.deepEqual(order, ["s/a", "s/b", "s/c"]);
});

test("detects a cycle between declared systems", () => {
  const systems = systemsOf(`
    (defsystem "x" :depends-on ("y"))
    (defsystem "y" :depends-on ("x"))
  `);
  const cycles = findCycles(buildSystemGraph(systems));
  assert.equal(cycles.length, 1);
  assert.deepEqual(new Set(cycles[0].path), new Set(["x", "y"]));
});
