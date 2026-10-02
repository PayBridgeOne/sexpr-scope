import { test } from "node:test";
import assert from "node:assert/strict";
import { WorkspaceIndex } from "../src/indexer/workspace-index";
import { parseQualifiedName } from "../src/model/symbol";

const PAYMENT = `(defpackage :payment
  (:use :cl)
  (:nicknames :pay)
  (:export #:authorize))
(in-package :payment)
(defun authorize (tx) tx)`;

const ACCOUNT = `(defpackage :account (:use :cl))
(in-package :account)
(defun authorize (user) user)`;

const CLIENT = `(in-package :account)
(defun run (tx)
  (payment:authorize tx)
  (authorize tx))`;

function build(): WorkspaceIndex {
  const idx = new WorkspaceIndex();
  idx.setDocument("file:///payment.lisp", PAYMENT);
  idx.setDocument("file:///account.lisp", ACCOUNT);
  idx.setDocument("file:///client.lisp", CLIENT);
  return idx;
}

test("workspace/symbol search matches by print name", () => {
  const idx = build();
  const hits = idx.searchSymbols("authorize");
  assert.equal(hits.length, 2);
});

test("qualified reference resolves to the right package", () => {
  const idx = build();
  const ref = parseQualifiedName("payment:authorize");
  const defs = idx.resolveReference(ref, "ACCOUNT");
  assert.equal(defs.length, 1);
  assert.equal(defs[0].package, "PAYMENT");
});

test("unqualified reference resolves in the current package", () => {
  const idx = build();
  const ref = parseQualifiedName("authorize");
  const defs = idx.resolveReference(ref, "ACCOUNT");
  assert.equal(defs.length, 1);
  assert.equal(defs[0].package, "ACCOUNT");
});

test("nickname resolves to its canonical package", () => {
  const idx = build();
  assert.equal(idx.resolvePackageName("PAY"), "PAYMENT");
  const defs = idx.resolveReference(parseQualifiedName("pay:authorize"), "ACCOUNT");
  assert.equal(defs[0].package, "PAYMENT");
});

test("export status is computed from defpackage", () => {
  const idx = build();
  const exported = idx
    .allSymbols()
    .find((s) => s.name === "AUTHORIZE" && s.package === "PAYMENT");
  assert.equal(exported?.exported, true);
  const internal = idx
    .allSymbols()
    .find((s) => s.name === "AUTHORIZE" && s.package === "ACCOUNT");
  assert.equal(internal?.exported, false);
});

test("removing a document drops its symbols", () => {
  const idx = build();
  idx.removeDocument("file:///payment.lisp");
  assert.equal(idx.searchSymbols("authorize").length, 1);
});
