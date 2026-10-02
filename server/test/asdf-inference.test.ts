import { test } from "node:test";
import assert from "node:assert/strict";
import { WorkspaceIndex } from "../src/indexer/workspace-index";
import { inferComponentEdges, ComponentSource } from "../src/asdf/inference";
import { AsdfDependencyEdge, DependencyConfidence, DependencyReason } from "../src/asdf/model";

const MODEL_URI = "file:///w/app/model.lisp";
const SERVICES_URI = "file:///w/app/services.lisp";
const UTIL_URI = "file:///w/app/util.lisp";
const CONSUMER_URI = "file:///w/app/consumer.lisp";

function edgesBetween(
  edges: readonly AsdfDependencyEdge[],
  from: string,
  to: string,
): AsdfDependencyEdge[] {
  return edges.filter((e) => e.from === from && e.to === to);
}

function buildIndex(docs: Record<string, string>): WorkspaceIndex {
  const idx = new WorkspaceIndex();
  for (const [uri, text] of Object.entries(docs)) idx.setDocument(uri, text);
  return idx;
}

test("package :use relation yields a strong inferred-package edge with evidence", () => {
  const index = buildIndex({
    [MODEL_URI]: `
      (defpackage :app.model (:use :cl) (:export #:make-thing))
      (in-package :app.model)
      (defun make-thing () 42)
    `,
    [SERVICES_URI]: `
      (defpackage :app.services (:use :cl :app.model))
      (in-package :app.services)
      (defun run () (make-thing))
    `,
  });
  const sources: ComponentSource[] = [
    { componentId: "app/model", systemName: "app", uri: MODEL_URI },
    { componentId: "app/services", systemName: "app", uri: SERVICES_URI },
  ];
  const edges = inferComponentEdges({ index, sources });

  const pkgEdge = edgesBetween(edges, "app/services", "app/model").find(
    (e) => e.reason === DependencyReason.InferredPackage,
  );
  assert.ok(pkgEdge, "expected inferred-package edge services -> model");
  assert.equal(pkgEdge!.confidence, DependencyConfidence.Strong);
  assert.ok(pkgEdge!.evidence, "edge must retain evidence");
  assert.match(pkgEdge!.evidence!.description, /APP\.MODEL/);
});

test("workspace macro use yields a strong inferred-macro edge with evidence", () => {
  const index = buildIndex({
    [MODEL_URI]: `
      (defpackage :app.model (:use :cl) (:export #:with-thing))
      (in-package :app.model)
      (defmacro with-thing (&body body) \`(progn ,@body))
    `,
    [SERVICES_URI]: `
      (defpackage :app.services (:use :cl :app.model))
      (in-package :app.services)
      (defun run () (with-thing 1))
    `,
  });
  const sources: ComponentSource[] = [
    { componentId: "app/model", systemName: "app", uri: MODEL_URI },
    { componentId: "app/services", systemName: "app", uri: SERVICES_URI },
  ];
  const edges = inferComponentEdges({ index, sources });

  const macroEdge = edgesBetween(edges, "app/services", "app/model").find(
    (e) => e.reason === DependencyReason.InferredMacro,
  );
  assert.ok(macroEdge, "expected inferred-macro edge services -> model");
  assert.equal(macroEdge!.confidence, DependencyConfidence.Strong);
  assert.ok(macroEdge!.evidence?.symbol);
  assert.match(macroEdge!.evidence!.symbol!, /WITH-THING/);
});

test("an ordinary cross-file function reference is advisory only", () => {
  const index = buildIndex({
    [UTIL_URI]: `
      (defpackage :app.util (:use :cl) (:export #:helper))
      (in-package :app.util)
      (defun helper () 1)
    `,
    [CONSUMER_URI]: `
      (defpackage :app.consumer (:use :cl))
      (in-package :app.consumer)
      (defun go () (app.util:helper))
    `,
  });
  const sources: ComponentSource[] = [
    { componentId: "app/util", systemName: "app", uri: UTIL_URI },
    { componentId: "app/consumer", systemName: "app", uri: CONSUMER_URI },
  ];
  const edges = inferComponentEdges({ index, sources });

  const between = edgesBetween(edges, "app/consumer", "app/util");
  assert.ok(between.length > 0, "expected an advisory edge");
  for (const e of between) {
    assert.equal(e.reason, DependencyReason.InferredSymbol);
    assert.equal(e.confidence, DependencyConfidence.Advisory);
    assert.ok(e.evidence, "advisory edge must retain evidence");
  }
  // There must be NO strong edge from an ordinary function call.
  assert.equal(
    between.filter((e) => e.confidence !== DependencyConfidence.Advisory).length,
    0,
  );
});

test("every inferred edge is distinct from declared/serial ASDF edges", () => {
  const index = buildIndex({
    [MODEL_URI]: `
      (defpackage :app.model (:use :cl) (:export #:make-thing #:with-thing))
      (in-package :app.model)
      (defmacro with-thing (&body body) \`(progn ,@body))
      (defun make-thing () 42)
    `,
    [SERVICES_URI]: `
      (defpackage :app.services (:use :cl :app.model))
      (in-package :app.services)
      (defun run () (with-thing (make-thing)))
    `,
  });
  const sources: ComponentSource[] = [
    { componentId: "app/model", systemName: "app", uri: MODEL_URI },
    { componentId: "app/services", systemName: "app", uri: SERVICES_URI },
  ];
  const edges = inferComponentEdges({ index, sources });
  // All returned edges carry an inferred reason — never explicit/serial.
  for (const e of edges) {
    assert.ok(
      [
        DependencyReason.InferredPackage,
        DependencyReason.InferredMacro,
        DependencyReason.InferredSymbol,
      ].includes(e.reason),
    );
    assert.notEqual(e.confidence, DependencyConfidence.Authoritative);
  }
});

test("no edges are inferred when there are no cross-component relationships", () => {
  const index = buildIndex({
    [MODEL_URI]: `
      (defpackage :app.model (:use :cl))
      (in-package :app.model)
      (defun only-here () 1)
    `,
  });
  const sources: ComponentSource[] = [
    { componentId: "app/model", systemName: "app", uri: MODEL_URI },
  ];
  assert.deepEqual(inferComponentEdges({ index, sources }), []);
});
