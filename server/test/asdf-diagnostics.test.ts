import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDocument } from "../src/parser/reader";
import { parseAsdfFile } from "../src/asdf/parser";
import {
  ASDF_DIAGNOSTIC_CODES,
  computeAsdfDiagnostics,
} from "../src/asdf/diagnostics";

function systemsOf(text: string, uri = "file:///w/test.asd") {
  return parseAsdfFile(parseDocument(uri, text)).systems;
}

test("flags a :depends-on referencing a non-existent sibling component", () => {
  const systems = systemsOf(`
    (defsystem "s"
      :components ((:file "a")
                   (:file "b" :depends-on ("missing"))))
  `);
  const diags = computeAsdfDiagnostics({ systems });
  const d = diags.find((x) => x.code === ASDF_DIAGNOSTIC_CODES.MissingComponent);
  assert.ok(d, "expected a missing-component diagnostic");
  assert.match(d!.message, /missing/);
});

test("does not flag an existing sibling :depends-on", () => {
  const systems = systemsOf(`
    (defsystem "s"
      :components ((:file "a") (:file "b" :depends-on ("a"))))
  `);
  const diags = computeAsdfDiagnostics({ systems });
  assert.equal(
    diags.filter((x) => x.code === ASDF_DIAGNOSTIC_CODES.MissingComponent).length,
    0,
  );
});

test("reports an authoritative component cycle with a concrete path", () => {
  const systems = systemsOf(`
    (defsystem "s"
      :components ((:file "a" :depends-on ("b"))
                   (:file "b" :depends-on ("a"))))
  `);
  const diags = computeAsdfDiagnostics({ systems });
  const d = diags.find((x) => x.code === ASDF_DIAGNOSTIC_CODES.Cycle);
  assert.ok(d);
  assert.equal(d!.severity, "error");
  assert.match(d!.message, /s\/a/);
  assert.match(d!.message, /s\/b/);
});

test("reports a known-missing source file only when the path is fully static", () => {
  const systems = systemsOf(`
    (defsystem "s"
      :components ((:file "present") (:file "absent")))
  `);
  const present = "file:///w/present.lisp";
  const diags = computeAsdfDiagnostics({
    systems,
    fileExists: (uri) => uri === present,
  });
  const missing = diags.filter((x) => x.code === ASDF_DIAGNOSTIC_CODES.MissingSource);
  assert.equal(missing.length, 1);
  assert.match(missing[0].message, /absent/);
});

test("never reports a missing source for a conditional component", () => {
  const systems = systemsOf(`
    (defsystem "s"
      :components (#+sbcl (:file "sbcl-only")))
  `);
  const diags = computeAsdfDiagnostics({
    systems,
    fileExists: () => false, // nothing exists
  });
  assert.equal(
    diags.filter((x) => x.code === ASDF_DIAGNOSTIC_CODES.MissingSource).length,
    0,
  );
});

test("never reports a missing source for a custom/unknown component type", () => {
  const systems = systemsOf(`
    (defsystem "s"
      :components ((:my-type "thing")))
  `);
  const diags = computeAsdfDiagnostics({ systems, fileExists: () => false });
  assert.equal(
    diags.filter((x) => x.code === ASDF_DIAGNOSTIC_CODES.MissingSource).length,
    0,
  );
});

test("flags an unambiguous duplicate component identity", () => {
  const systems = systemsOf(`
    (defsystem "s"
      :components ((:file "dup") (:file "dup")))
  `);
  const diags = computeAsdfDiagnostics({ systems });
  const d = diags.find((x) => x.code === ASDF_DIAGNOSTIC_CODES.DuplicateComponent);
  assert.ok(d);
  assert.match(d!.message, /dup/);
});

test("reports a declared system cycle", () => {
  const systems = systemsOf(`
    (defsystem "x" :depends-on ("y"))
    (defsystem "y" :depends-on ("x"))
  `);
  const diags = computeAsdfDiagnostics({ systems });
  const d = diags.find((x) => x.code === ASDF_DIAGNOSTIC_CODES.SystemCycle);
  assert.ok(d);
  assert.match(d!.message, /x/);
  assert.match(d!.message, /y/);
});

test("produces no diagnostics for a clean system", () => {
  const systems = systemsOf(`
    (defsystem "s"
      :serial t
      :components ((:file "a") (:file "b")))
  `);
  const diags = computeAsdfDiagnostics({ systems, fileExists: () => true });
  assert.deepEqual(diags, []);
});
