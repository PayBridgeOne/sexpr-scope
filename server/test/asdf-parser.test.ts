import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { parseDocument } from "../src/parser/reader";
import { parseAsdfFile } from "../src/asdf/parser";
import { AsdfComponent, AsdfSystem, Certainty } from "../src/asdf/model";

function parse(text: string, uri = "file:///workspace/test.asd") {
  return parseAsdfFile(parseDocument(uri, text));
}

function findComponent(
  components: readonly AsdfComponent[],
  name: string,
): AsdfComponent | undefined {
  for (const c of components) {
    if (c.name === name) return c;
    const nested = findComponent(c.children, name);
    if (nested) return nested;
  }
  return undefined;
}

test("recognizes a simple defsystem with a string name", () => {
  const { systems } = parse('(defsystem "payment")');
  assert.equal(systems.length, 1);
  assert.equal(systems[0].name, "payment");
  assert.equal(systems[0].nameCertainty, Certainty.Known);
});

test("recognizes asdf:defsystem with a package-qualified operator", () => {
  const { systems } = parse('(asdf:defsystem "payment")');
  assert.equal(systems.length, 1);
  assert.equal(systems[0].name, "payment");
});

test("coerces a symbol system name by downcasing", () => {
  const { systems } = parse("(defsystem #:Payment)");
  assert.equal(systems[0].name, "payment");
  assert.equal(systems[0].nameCertainty, Certainty.Known);
});

test("supports multiple systems in one file, including secondary systems", () => {
  const { systems } = parse(`
    (defsystem "foo")
    (defsystem "foo/test" :depends-on ("foo"))
    (defsystem "foo/examples")
  `);
  assert.deepEqual(
    systems.map((s) => s.name),
    ["foo", "foo/test", "foo/examples"],
  );
  assert.deepEqual(
    systems[1].dependsOn.map((d) => d.name),
    ["foo"],
  );
});

test("parses :file, :module and :static-file components with hierarchy", () => {
  const { systems } = parse(`
    (defsystem "app"
      :components ((:module "src"
                    :components ((:file "model")
                                 (:file "api")))
                   (:static-file "README.md")))
  `);
  const sys = systems[0];
  assert.deepEqual(sys.components.map((c) => c.type), ["module", "static-file"]);
  const src = findComponent(sys.components, "src")!;
  assert.equal(src.type, "module");
  assert.equal(src.typeCertainty, Certainty.Known);
  assert.deepEqual(src.children.map((c) => c.id), ["app/src/model", "app/src/api"]);
  const readme = findComponent(sys.components, "README.md")!;
  assert.equal(readme.type, "static-file");
});

test("represents a custom component type without pretending to understand it", () => {
  const { systems } = parse(`
    (defsystem "app"
      :components ((:my-custom-file "weird")))
  `);
  const comp = systems[0].components[0];
  assert.equal(comp.type, "my-custom-file");
  assert.equal(comp.typeCertainty, Certainty.Unknown);
  // Must never fabricate a path for an unknown component class.
  assert.equal(comp.effectiveUri, undefined);
});

test("captures literal system options", () => {
  const { systems } = parse(`
    (defsystem "app"
      :description "A thing"
      :version "1.2.3"
      :author "Ada"
      :maintainer "Grace"
      :license "MIT"
      :class :my-system-class
      :serial t)
  `);
  const sys = systems[0];
  assert.equal(sys.description, "A thing");
  assert.equal(sys.version, "1.2.3");
  assert.equal(sys.author, "Ada");
  assert.equal(sys.maintainer, "Grace");
  assert.equal(sys.license, "MIT");
  assert.equal(sys.className, "my-system-class");
  assert.equal(sys.serial, true);
});

test("accepts :licence spelling", () => {
  const { systems } = parse('(defsystem "app" :licence "BSD")');
  assert.equal(systems[0].license, "BSD");
});

test("keeps the three dependency kinds separate", () => {
  const { systems } = parse(`
    (defsystem "app"
      :depends-on ("alexandria")
      :defsystem-depends-on ("asdf-package-system")
      :weakly-depends-on ("optional-lib"))
  `);
  const sys = systems[0];
  assert.deepEqual(sys.dependsOn.map((d) => d.name), ["alexandria"]);
  assert.deepEqual(sys.defsystemDependsOn.map((d) => d.name), ["asdf-package-system"]);
  assert.deepEqual(sys.weaklyDependsOn.map((d) => d.name), ["optional-lib"]);
});

test("discovers defsystem nested inside arbitrary surrounding Lisp", () => {
  const { systems } = parse(`
    (eval-when (:load-toplevel)
      (progn
        (defsystem "buried")))
  `);
  assert.deepEqual(systems.map((s) => s.name), ["buried"]);
});

test("ignores quoted and read-time forms without evaluating them", () => {
  // The #. and the error form must never be evaluated; parsing must succeed.
  const { systems } = parse(`
    (defsystem "safe"
      :version #.(error "do not evaluate me")
      :components ((:file "x")))
  `);
  assert.equal(systems.length, 1);
  assert.equal(systems[0].name, "safe");
  assert.equal(systems[0].version, undefined); // computed -> opaque, not guessed
  assert.ok(findComponent(systems[0].components, "x"));
});

test("marks a reader-conditional component as conditional but visible", () => {
  const { systems } = parse(`
    (defsystem "app"
      :components ((:file "always")
                   #+sbcl (:file "sbcl-only")))
  `);
  const sys = systems[0];
  const conditional = findComponent(sys.components, "sbcl-only")!;
  assert.ok(conditional, "conditional component remains visible");
  assert.equal(conditional.certainty, Certainty.Conditional);
  assert.match(conditional.featureExpression ?? "", /sbcl/i);
});

test("marks an :if-feature component as conditional without evaluating it", () => {
  const { systems } = parse(`
    (defsystem "app"
      :components ((:file "maybe" :if-feature :sbcl)))
  `);
  const comp = systems[0].components[0];
  assert.equal(comp.certainty, Certainty.Conditional);
  assert.match(comp.featureExpression ?? "", /sbcl/i);
});

test("treats a computed/dynamic system name as unsupported, not evaluated", () => {
  const { systems } = parse('(defsystem (compute-name) :serial t)');
  const sys = systems[0];
  assert.equal(sys.nameCertainty, Certainty.Dynamic);
  assert.ok(sys.conditions.some((c) => c.certainty === Certainty.Dynamic));
});

test("treats a computed component name as dynamic", () => {
  const { systems } = parse(`
    (defsystem "app"
      :components ((:file #.(symbol-name 'x))))
  `);
  const comp = systems[0].components[0];
  assert.equal(comp.certainty, Certainty.Dynamic);
  assert.equal(comp.effectiveUri, undefined);
});

// ---------------------------------------------------------------------------
// effective paths (spec #25) — exercised against real temp directories.
// ---------------------------------------------------------------------------

test("resolves effective file paths relative to the .asd directory", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asdf-paths-"));
  try {
    const asd = path.join(dir, "app.asd");
    const text = `
      (defsystem "app"
        :components ((:module "src"
                      :components ((:file "model")
                                   (:static-file "notes.txt")))))
    `;
    const { systems } = parseAsdfFile(
      parseDocument(pathToFileURL(asd).href, text),
    );
    const model = findComponent(systems[0].components, "model")!;
    const notes = findComponent(systems[0].components, "notes.txt")!;
    assert.equal(model.effectiveUri, pathToFileURL(path.join(dir, "src", "model.lisp")).href);
    // static-file keeps its literal name (extension already present).
    assert.equal(notes.effectiveUri, pathToFileURL(path.join(dir, "src", "notes.txt")).href);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("honors a literal :pathname override", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asdf-paths-"));
  try {
    const asd = path.join(dir, "app.asd");
    const text = `
      (defsystem "app"
        :components ((:file "model" :pathname "custom/model-impl.lisp")))
    `;
    const { systems } = parseAsdfFile(
      parseDocument(pathToFileURL(asd).href, text),
    );
    const model = systems[0].components[0];
    assert.equal(
      model.effectiveUri,
      pathToFileURL(path.join(dir, "custom", "model-impl.lisp")).href,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("honors a literal system-level :pathname override for its components", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asdf-paths-"));
  try {
    const asd = path.join(dir, "app.asd");
    const text = `
      (defsystem "app"
        :pathname "lisp"
        :components ((:file "model")))
    `;
    const { systems } = parseAsdfFile(
      parseDocument(pathToFileURL(asd).href, text),
    );
    const model = systems[0].components[0];
    assert.equal(
      model.effectiveUri,
      pathToFileURL(path.join(dir, "lisp", "model.lisp")).href,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("does not fabricate a path when the .asd uri is not a file uri", () => {
  const { systems } = parse(
    '(defsystem "app" :components ((:file "model")))',
    "untitled:Untitled-1",
  );
  assert.equal(systems[0].components[0].effectiveUri, undefined);
});
