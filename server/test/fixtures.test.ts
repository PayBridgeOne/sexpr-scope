import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { WorkspaceIndex } from "../src/indexer/workspace-index";
import { parseQualifiedName, SymbolKind } from "../src/model/symbol";

const FIXTURE_DIR = path.resolve(__dirname, "../../../fixtures/sample-project/src");

function loadFixtureWorkspace(): WorkspaceIndex {
  const idx = new WorkspaceIndex();
  for (const file of ["packages.lisp", "model.lisp", "services.lisp"]) {
    const full = path.join(FIXTURE_DIR, file);
    idx.setDocument(pathToFileURL(full).toString(), fs.readFileSync(full, "utf8"));
  }
  return idx;
}

test("sample project indexes definitions across files", () => {
  const idx = loadFixtureWorkspace();
  const names = new Set(idx.allSymbols().map((s) => s.name));
  for (const expected of [
    "PROCESS-TRANSACTION",
    "CHARGE-FEE",
    "PROCESS",
    "TRANSACTION",
    "INSUFFICIENT-FUNDS",
    "WITH-TRANSACTION",
    "*FEE-RATE*",
    "PAYMENT",
  ]) {
    assert.ok(names.has(expected), `missing ${expected}`);
  }
});

test("cross-file reference resolves charge-fee to its defun", () => {
  const idx = loadFixtureWorkspace();
  const defs = idx.resolveReference(parseQualifiedName("charge-fee"), "PAYMENT");
  assert.equal(defs.length, 1);
  assert.equal(defs[0].kind, SymbolKind.Function);
  assert.ok(defs[0].uri.endsWith("services.lisp"));
});

test("exported symbols are flagged from the sample defpackage", () => {
  const idx = loadFixtureWorkspace();
  const chargeFee = idx
    .allSymbols()
    .find((s) => s.name === "CHARGE-FEE" && s.package === "PAYMENT");
  assert.equal(chargeFee?.exported, true);
});

test("define-condition is recognized as a condition", () => {
  const idx = loadFixtureWorkspace();
  const cond = idx.allSymbols().find((s) => s.name === "INSUFFICIENT-FUNDS");
  assert.equal(cond?.kind, SymbolKind.Condition);
});
