import { test } from "node:test";
import assert from "node:assert/strict";
import { parseQualifiedName, canonicalizeName } from "../src/model/symbol";

test("bare symbol parses as unqualified and upcased", () => {
  const q = parseQualifiedName("process-transaction");
  assert.equal(q.name, "PROCESS-TRANSACTION");
  assert.equal(q.qualification, "none");
  assert.equal(q.packagePrefix, undefined);
});

test("external qualification pkg:foo", () => {
  const q = parseQualifiedName("payment:authorize");
  assert.equal(q.packagePrefix, "PAYMENT");
  assert.equal(q.name, "AUTHORIZE");
  assert.equal(q.qualification, "external");
});

test("internal qualification pkg::foo", () => {
  const q = parseQualifiedName("payment::secret");
  assert.equal(q.packagePrefix, "PAYMENT");
  assert.equal(q.name, "SECRET");
  assert.equal(q.qualification, "internal");
});

test("keyword :foo lives in the KEYWORD package", () => {
  const q = parseQualifiedName(":export");
  assert.equal(q.packagePrefix, "KEYWORD");
  assert.equal(q.name, "EXPORT");
  assert.equal(q.qualification, "keyword");
});

test("uninterned #:g is modeled with explicit uninterned identity", () => {
  const q = parseQualifiedName("#:gensym");
  assert.equal(q.name, "GENSYM");
  assert.equal(q.qualification, "uninterned");
  assert.equal(q.packagePrefix, undefined);
});

test("vertical-bar escaping preserves case and colons", () => {
  assert.equal(canonicalizeName("|MixedCase|"), "MixedCase");
  const q = parseQualifiedName("|weird:name|");
  assert.equal(q.qualification, "none");
  assert.equal(q.name, "weird:name");
});
