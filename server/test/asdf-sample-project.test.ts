import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { WorkspaceIndex } from "../src/indexer/workspace-index";
import { AsdfProject } from "../src/asdf/project";
import { DependencyReason, walkComponents } from "../src/asdf/model";

/**
 * Acceptance test for the shipped sample project (spec #33).
 *
 * `fixtures/sample-project/payment.asd` must be modeled *statically* (no Lisp
 * evaluation) as:
 *
 *   payment
 *   └── src
 *       ├── packages
 *       ├── model
 *       └── services
 *
 * correlating `src/packages.lisp`, `src/model.lisp` and `src/services.lisp`.
 * Because both the system and the module are `:serial t`, the effective module
 * dependencies must include model→packages, services→packages and
 * services→model, all with reason `serial`.
 */

const PROJECT_DIR = path.resolve(__dirname, "../../../fixtures/sample-project");

async function loadProjectIndex(): Promise<WorkspaceIndex> {
  const index = new WorkspaceIndex();
  const files = [
    "payment.asd",
    path.join("src", "packages.lisp"),
    path.join("src", "model.lisp"),
    path.join("src", "services.lisp"),
  ];
  for (const rel of files) {
    const abs = path.join(PROJECT_DIR, rel);
    const text = await fs.readFile(abs, "utf8");
    index.setDocument(pathToFileURL(abs).toString(), text);
  }
  return index;
}

function srcUri(rel: string): string {
  return pathToFileURL(path.join(PROJECT_DIR, "src", rel)).toString();
}

test("sample payment project is modeled statically with its serial dependencies", async () => {
  const index = await loadProjectIndex();
  const project = new AsdfProject(index);
  const analysis = project.analyze();

  // Exactly one system, named "payment".
  assert.equal(analysis.systems.length, 1);
  const payment = analysis.systems[0];
  assert.equal(payment.name, "payment");

  // Hierarchy: payment -> src (module) -> packages, model, services.
  assert.equal(payment.components.length, 1);
  const src = payment.components[0];
  assert.equal(src.name, "src");
  assert.equal(src.type, "module");
  assert.deepEqual(
    src.children.map((c) => c.name),
    ["packages", "model", "services"],
  );
  assert.deepEqual(
    src.children.map((c) => c.id),
    ["payment/src/packages", "payment/src/model", "payment/src/services"],
  );

  // Correlation: each file maps to the real indexed source document.
  assert.equal(analysis.sourceByComponentId.get("payment/src/packages"), srcUri("packages.lisp"));
  assert.equal(analysis.sourceByComponentId.get("payment/src/model"), srcUri("model.lisp"));
  assert.equal(analysis.sourceByComponentId.get("payment/src/services"), srcUri("services.lisp"));

  // Serial-derived edges inside the module, with reason "serial".
  const serial = analysis.componentEdges.filter((e) => e.reason === DependencyReason.Serial);
  const has = (from: string, to: string): boolean =>
    serial.some((e) => e.from === `payment/src/${from}` && e.to === `payment/src/${to}`);

  assert.ok(has("model", "packages"), "model -> packages (serial)");
  assert.ok(has("services", "packages"), "services -> packages (serial)");
  assert.ok(has("services", "model"), "services -> model (serial)");

  // The module's serial order must not fabricate a reverse edge.
  assert.ok(!has("packages", "model"), "serial order is one-directional");

  // No ASDF diagnostics for this well-formed project.
  assert.deepEqual(analysis.diagnostics, []);

  // Sanity: textual order is preserved on the model independently of the graph.
  const names: string[] = [];
  walkComponents(payment.components, (c) => names.push(c.name));
  assert.deepEqual(names, ["src", "packages", "model", "services"]);
});
