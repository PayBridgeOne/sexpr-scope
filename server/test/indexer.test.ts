import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDocument } from "../src/parser/reader";
import { indexDocument, packageAtOffset } from "../src/indexer/document-indexer";
import { SymbolKind } from "../src/model/symbol";

const SOURCE = `(defpackage :payment
  (:use :cl)
  (:nicknames :pay)
  (:export #:authorize #:transaction)
  (:documentation "Payment domain."))

(in-package :payment)

(defvar *rate* 0.03 "Base fee rate.")

(defun authorize (transaction amount)
  "Authorize a transaction."
  (* amount *rate*))

(defclass transaction ()
  ((id :initarg :id))
  (:documentation "A money movement."))

(defgeneric process (tx))

(defmethod process ((tx transaction))
  (authorize tx 10))

(defmacro with-transaction ((var) &body body)
  \`(let ((,var (make-transaction))) ,@body))
`;

function indexSource() {
  const doc = parseDocument("file:///payment.lisp", SOURCE);
  return { doc, index: indexDocument(doc) };
}

test("indexer extracts all top-level definition kinds", () => {
  const { index } = indexSource();
  const byName = new Map(index.symbols.map((s) => [s.name, s]));
  assert.equal(byName.get("AUTHORIZE")?.kind, SymbolKind.Function);
  assert.equal(byName.get("WITH-TRANSACTION")?.kind, SymbolKind.Macro);
  assert.equal(byName.get("TRANSACTION")?.kind, SymbolKind.Class);
  assert.equal(byName.get("*RATE*")?.kind, SymbolKind.Variable);
  assert.equal(byName.get("PAYMENT")?.kind, SymbolKind.Package);
  assert.ok(
    index.symbols.some((s) => s.name === "PROCESS" && s.kind === SymbolKind.GenericFunction),
  );
  assert.ok(
    index.symbols.some((s) => s.name === "PROCESS" && s.kind === SymbolKind.Method),
  );
});

test("definitions are attributed to the in-package package", () => {
  const { index } = indexSource();
  const authorize = index.symbols.find((s) => s.name === "AUTHORIZE");
  assert.equal(authorize?.package, "PAYMENT");
});

test("docstrings and lambda lists are captured", () => {
  const { index } = indexSource();
  const authorize = index.symbols.find((s) => s.name === "AUTHORIZE");
  assert.equal(authorize?.documentation, "Authorize a transaction.");
  assert.equal(authorize?.lambdaList, "(transaction amount)");
  const klass = index.symbols.find((s) => s.name === "TRANSACTION" && s.kind === SymbolKind.Class);
  assert.equal(klass?.documentation, "A money movement.");
});

test("defpackage parsing records exports, nicknames and use list", () => {
  const { index } = indexSource();
  const pkg = index.packages[0];
  assert.equal(pkg.name, "PAYMENT");
  assert.deepEqual(pkg.nicknames, ["PAY"]);
  assert.deepEqual(pkg.uses, ["CL"]);
  assert.ok(pkg.exports.includes("AUTHORIZE"));
});

test("packageAtOffset reflects in-package boundaries", () => {
  const { doc, index } = indexSource();
  const before = SOURCE.indexOf("defpackage");
  const after = SOURCE.indexOf("defun authorize");
  assert.equal(packageAtOffset(index, before), "COMMON-LISP-USER");
  assert.equal(packageAtOffset(index, after), "PAYMENT");
  void doc;
});
