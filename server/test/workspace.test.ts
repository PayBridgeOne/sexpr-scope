import { test } from "node:test";
import assert from "node:assert/strict";
import { WorkspaceIndex } from "../src/indexer/workspace-index";
import { Namespace, SymbolKind, parseQualifiedName } from "../src/model/symbol";

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

test("a value reference does not resolve to a same-named function", () => {
  const idx = new WorkspaceIndex();
  idx.setDocument(
    "file:///a.lisp",
    "(in-package :cl-user)\n(defun size () 1)",
  );
  const ref = parseQualifiedName("size");
  // In function position the defun resolves.
  const fn = idx.resolveReference(ref, "CL-USER", {
    namespace: Namespace.Function,
  });
  assert.equal(fn.length, 1);
  // In value position there is no variable named SIZE, so nothing resolves.
  const val = idx.resolveReference(ref, "CL-USER", {
    namespace: Namespace.Value,
  });
  assert.equal(val.length, 0);
});

test("resolution never falls back to a same-named symbol in another package", () => {
  const idx = new WorkspaceIndex();
  idx.setDocument(
    "file:///pay.lisp",
    "(defpackage :payment (:use :cl))\n(in-package :payment)\n(defun authorize (tx) tx)",
  );
  idx.setDocument(
    "file:///acct.lisp",
    "(defpackage :account (:use :cl))\n(in-package :account)",
  );
  // ACCOUNT has no AUTHORIZE; a bare reference there must not leak PAYMENT's.
  const defs = idx.resolveReference(parseQualifiedName("authorize"), "ACCOUNT");
  assert.equal(defs.length, 0);
});

test("a generic function is preferred over its method implementations", () => {
  const idx = new WorkspaceIndex();
  idx.setDocument(
    "file:///g.lisp",
    `(in-package :cl-user)
(defgeneric process (object))
(defmethod process ((x integer)) x)
(defmethod process ((x string)) x)`,
  );
  const defs = idx.resolveReference(parseQualifiedName("process"), "CL-USER", {
    namespace: Namespace.Function,
  });
  assert.equal(defs.length, 1);
  assert.equal(defs[0].kind, SymbolKind.GenericFunction);
});

test("methodsFor returns every defmethod for a name", () => {
  const idx = new WorkspaceIndex();
  idx.setDocument(
    "file:///g.lisp",
    `(in-package :cl-user)
(defgeneric process (object))
(defmethod process ((x integer)) x)
(defmethod process ((x string)) x)`,
  );
  const methods = idx.methodsFor("PROCESS", "CL-USER");
  assert.equal(methods.length, 2);
  assert.ok(methods.every((m) => m.methodImplementation));
});

test("a #+ guarded definition is only used when no unconditional one exists", () => {
  const idx = new WorkspaceIndex();
  idx.setDocument(
    "file:///c.lisp",
    `(in-package :cl-user)
#+sbcl (defun only-guarded () 1)
(defun both () 2)
#+sbcl (defun both () 3)`,
  );
  // A purely conditional definition still resolves (best effort).
  const guarded = idx.resolveReference(
    parseQualifiedName("only-guarded"),
    "CL-USER",
    { namespace: Namespace.Function },
  );
  assert.equal(guarded.length, 1);
  assert.equal(guarded[0].conditional, true);
  // When an unconditional definition exists, the conditional one is dropped.
  const both = idx.resolveReference(parseQualifiedName("both"), "CL-USER", {
    namespace: Namespace.Function,
  });
  assert.equal(both.length, 1);
  assert.equal(both[0].conditional, undefined);
});

test("a conditional in-package does not rebind the current package", () => {
  const idx = new WorkspaceIndex();
  idx.setDocument(
    "file:///p.lisp",
    `(defpackage :payment (:use :cl))
(in-package :payment)
#+sbcl (in-package :cl-user)
(defun charge () 1)`,
  );
  const sym = idx.allSymbols().find((s) => s.name === "CHARGE");
  assert.equal(sym?.package, "PAYMENT");
});

test("CL resolves to COMMON-LISP without any defpackage", () => {
  const idx = new WorkspaceIndex();
  idx.setDocument("file:///a.lisp", "(defun noop () nil)");
  assert.equal(idx.resolvePackageName("CL"), "COMMON-LISP");
  assert.equal(idx.resolvePackageName("COMMON-LISP"), "COMMON-LISP");
});

test("CL-USER resolves to COMMON-LISP-USER without any defpackage", () => {
  const idx = new WorkspaceIndex();
  idx.setDocument("file:///a.lisp", "(defun noop () nil)");
  assert.equal(idx.resolvePackageName("CL-USER"), "COMMON-LISP-USER");
  assert.equal(idx.resolvePackageName("COMMON-LISP-USER"), "COMMON-LISP-USER");
});

test("definitions before and after (in-package :cl-user) share COMMON-LISP-USER", () => {
  const idx = new WorkspaceIndex();
  idx.setDocument(
    "file:///a.lisp",
    `(defun first-definition () 1)
(in-package :cl-user)
(defun second-definition () 2)`,
  );
  const first = idx.allSymbols().find((s) => s.name === "FIRST-DEFINITION");
  const second = idx.allSymbols().find((s) => s.name === "SECOND-DEFINITION");
  assert.equal(first?.package, "COMMON-LISP-USER");
  assert.equal(second?.package, "COMMON-LISP-USER");
  // Both are reachable from the canonical package and from its nickname.
  assert.equal(
    idx.resolveReference(parseQualifiedName("second-definition"), "COMMON-LISP-USER", {
      namespace: Namespace.Function,
    }).length,
    1,
  );
  assert.equal(
    idx.resolveReference(parseQualifiedName("first-definition"), "CL-USER", {
      namespace: Namespace.Function,
    }).length,
    1,
  );
});

test("external vs internal qualification is enforced", () => {
  const idx = new WorkspaceIndex();
  idx.setDocument(
    "file:///payment.lisp",
    `(defpackage :payment
  (:use :cl)
  (:export :public))
(in-package :payment)
(defun public () 1)
(defun private () 2)`,
  );
  // payment:public — single colon, exported symbol → resolves.
  assert.equal(
    idx.resolveReference(parseQualifiedName("payment:public"), "CL-USER").length,
    1,
  );
  // payment:private — single colon, internal symbol → no result.
  assert.equal(
    idx.resolveReference(parseQualifiedName("payment:private"), "CL-USER").length,
    0,
  );
  // payment::public — double colon, external symbol → resolves.
  assert.equal(
    idx.resolveReference(parseQualifiedName("payment::public"), "CL-USER").length,
    1,
  );
  // payment::private — double colon, internal symbol → resolves.
  assert.equal(
    idx.resolveReference(parseQualifiedName("payment::private"), "CL-USER").length,
    1,
  );
});

test("an uninterned #:foo never resolves to a global definition", () => {
  const idx = new WorkspaceIndex();
  idx.setDocument("file:///a.lisp", "(in-package :cl-user)\n(defun foo () 1)");
  // The same print name resolves when interned in the current package.
  assert.equal(
    idx.resolveReference(parseQualifiedName("foo"), "CL-USER", {
      namespace: Namespace.Function,
    }).length,
    1,
  );
  // But the uninterned symbol has no global identity and must not resolve.
  assert.equal(
    idx.resolveReference(parseQualifiedName("#:foo"), "CL-USER", {
      namespace: Namespace.Function,
    }).length,
    0,
  );
});

test("function and value references pick distinct same-named definitions", () => {
  const idx = new WorkspaceIndex();
  idx.setDocument(
    "file:///a.lisp",
    `(in-package :cl-user)
(defvar thing 1)
(defun thing () 2)`,
  );
  const value = idx.resolveReference(parseQualifiedName("thing"), "CL-USER", {
    namespace: Namespace.Value,
  });
  assert.equal(value.length, 1);
  assert.equal(value[0].kind, SymbolKind.Variable);
  const fn = idx.resolveReference(parseQualifiedName("thing"), "CL-USER", {
    namespace: Namespace.Function,
  });
  assert.equal(fn.length, 1);
  assert.equal(fn[0].kind, SymbolKind.Function);
});
