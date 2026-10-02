import { test } from "node:test";
import assert from "node:assert/strict";
import { WorkspaceIndex } from "../src/indexer/workspace-index";
import { parseAsdfFile } from "../src/asdf/parser";
import { analyzePackageInferredSystem } from "../src/asdf/package-inferred";
import {
  Certainty,
  DependencyConfidence,
  DependencyReason,
} from "../src/asdf/model";

/**
 * Tests for conservative `:class :package-inferred-system` support.
 *
 * Everything is driven statically from the M2 package index — no evaluation. A
 * supported fixture (my-lib.asd + foo.lisp + bar.lisp) must be detected and its
 * `:use`/`:import-from` package dependency inferred; an unsupported/dynamic case
 * must degrade to "unknown" rather than guess.
 */

const ROOT = "file:///proj/my-lib";

function buildIndex(docs: Record<string, string>): WorkspaceIndex {
  const idx = new WorkspaceIndex();
  for (const [uri, text] of Object.entries(docs)) idx.setDocument(uri, text);
  return idx;
}

function parsePrimary(index: WorkspaceIndex, asdUri: string) {
  const doc = index.getDocument(asdUri)!;
  const file = parseAsdfFile(doc);
  return { file, system: file.systems[0] };
}

test("package-inferred-system is detected without any evaluation", () => {
  const index = buildIndex({
    [`${ROOT}/my-lib.asd`]: `(defsystem "my-lib" :class :package-inferred-system)`,
  });
  const { system } = parsePrimary(index, `${ROOT}/my-lib.asd`);
  assert.equal(system.packageInferred, true);
  assert.equal(system.className, "package-inferred-system");
});

test("files map to secondary systems and :use yields a strong package edge", () => {
  const index = buildIndex({
    [`${ROOT}/my-lib.asd`]: `(defsystem "my-lib" :class :package-inferred-system)`,
    [`${ROOT}/foo.lisp`]: `
      (defpackage :my-lib/foo (:use :cl) (:export #:foo))
      (in-package :my-lib/foo)
      (defun foo () 1)
    `,
    [`${ROOT}/bar.lisp`]: `
      (defpackage :my-lib/bar (:use :cl :my-lib/foo))
      (in-package :my-lib/bar)
      (defun bar () (foo))
    `,
  });
  const { system } = parsePrimary(index, `${ROOT}/my-lib.asd`);
  const result = analyzePackageInferredSystem({ index, system });

  const names = result.systems.map((s) => s.name).sort();
  assert.deepEqual(names, ["my-lib/bar", "my-lib/foo"]);

  const edge = result.edges.find(
    (e) => e.from === "my-lib/bar" && e.to === "my-lib/foo",
  );
  assert.ok(edge, "expected my-lib/bar -> my-lib/foo");
  assert.equal(edge!.reason, DependencyReason.InferredPackage);
  assert.equal(edge!.confidence, DependencyConfidence.Strong);
  assert.ok(edge!.evidence, "inferred edge must retain evidence");
  assert.equal(edge!.evidence!.definedInUri, `${ROOT}/foo.lisp`);
  assert.equal(edge!.evidence!.referencedInUri, `${ROOT}/bar.lisp`);
});

test(":import-from also produces a strong package edge", () => {
  const index = buildIndex({
    [`${ROOT}/my-lib.asd`]: `(defsystem "my-lib" :class :package-inferred-system)`,
    [`${ROOT}/foo.lisp`]: `(defpackage :my-lib/foo (:use :cl) (:export #:foo))`,
    [`${ROOT}/bar.lisp`]: `(defpackage :my-lib/bar (:use :cl) (:import-from :my-lib/foo #:foo))`,
  });
  const { system } = parsePrimary(index, `${ROOT}/my-lib.asd`);
  const result = analyzePackageInferredSystem({ index, system });
  assert.ok(
    result.edges.some(
      (e) =>
        e.from === "my-lib/bar" &&
        e.to === "my-lib/foo" &&
        e.reason === DependencyReason.InferredPackage,
    ),
  );
});

test("literal register-system-packages maps an extra package to a system", () => {
  const index = buildIndex({
    [`${ROOT}/my-lib.asd`]: `
      (defsystem "my-lib" :class :package-inferred-system)
      (asdf:register-system-packages "my-lib/foo" '("SOME-API"))
    `,
    [`${ROOT}/foo.lisp`]: `(defpackage :my-lib/foo (:use :cl))`,
    [`${ROOT}/bar.lisp`]: `(defpackage :my-lib/bar (:use :cl :some-api))`,
  });
  const { file, system } = parsePrimary(index, `${ROOT}/my-lib.asd`);
  assert.equal(file.registeredPackages.length, 1);
  assert.deepEqual(file.registeredPackages[0].packages, ["SOME-API"]);

  const result = analyzePackageInferredSystem({
    index,
    system,
    registeredPackages: file.registeredPackages,
  });
  assert.ok(
    result.edges.some((e) => e.from === "my-lib/bar" && e.to === "my-lib/foo"),
    "register-system-packages should let :some-api resolve to my-lib/foo",
  );
});

test("a #. read-time form in the .asd never breaks detection or executes", () => {
  const index = buildIndex({
    [`${ROOT}/my-lib.asd`]: `
      (defsystem "my-lib"
        :class :package-inferred-system
        :version #.(error "must not evaluate"))
    `,
    [`${ROOT}/foo.lisp`]: `(defpackage :my-lib/foo (:use :cl))`,
  });
  const { system } = parsePrimary(index, `${ROOT}/my-lib.asd`);
  assert.equal(system.packageInferred, true);
  const result = analyzePackageInferredSystem({ index, system });
  assert.ok(result.systems.some((s) => s.name === "my-lib/foo"));
});

test("a dynamic/non-file system degrades to unknown with a condition", () => {
  const index = buildIndex({
    ["untitled:Untitled-1"]: `(defsystem "scratch" :class :package-inferred-system)`,
  });
  const doc = index.getDocument("untitled:Untitled-1")!;
  const system = parseAsdfFile(doc).systems[0];
  const result = analyzePackageInferredSystem({ index, system });

  assert.deepEqual(result.systems, []);
  assert.ok(result.edges.length === 0);
  assert.ok(
    result.conditions.some((c) => c.certainty === Certainty.Dynamic),
    "an unmappable root should produce a dynamic condition, not a guess",
  );
});
