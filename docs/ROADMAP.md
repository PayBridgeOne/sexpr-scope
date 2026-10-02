# SexprScope Roadmap

SexprScope aims to give Common Lisp a development experience closer to
Rider/Visual Studio, while preserving the interactive and structural strengths
that make Lisp unique. The vision is large; it is delivered incrementally.
Each milestone must be a real, testable vertical slice.

## Milestone 1 — Foundation (this milestone) ✅

A safe static-navigation slice that works **without** a running Lisp image.

- Monorepo with clearly separated components (`extension`, `server`,
  `protocol`, `fixtures`, `docs`).
- Safe, **non-evaluating** parser tolerant of incomplete files, including
  `#+`/`#-` reader conditionals (feature expressions kept inert) and `#;`
  reader discards.
- Real workspace indexing at startup plus incremental
  `workspace/didChangeWatchedFiles` updates; open buffers override disk.
- Package-aware static symbol index for the core definers, with nickname
  **canonicalization** so one package has one identity.
- Lisp-2 namespace model: references resolve by syntactic position, generic
  functions are preferred over their methods, and resolution never falls back to
  a wrong same-named symbol in another package. Global vs lexical bindings are
  modeled (lexical indexing deferred to M2).
- LSP server: `documentSymbol`, `workspace/symbol`, `definition`, `hover`.
- VS Code extension: LSP client + native, **read-only** **Lisp Structure** tree
  view, with the trace setting wired through standard LSP configuration.
- Sample ASDF fixture project and unit/integration tests (including
  workspace-scan and file-change coverage).
- CI building and testing both the server and the extension with `npm ci` and
  least-privilege `permissions: contents: read`.

### Milestone 1.1.1 — Semantic correctness cleanup ✅

A correctness pass hardening the static model before lexical scopes are added:

- Lisp-2 reference contexts are strongly typed as **function / value / data**
  (`server/src/model/reference.ts`); evaluated value positions no longer use an
  `"any"` fallback, and a value reference never resolves to a function-only
  definition.
- Function designators `#'foo` and `(function foo)` (including `(function (setf
  foo))`) resolve as function-namespace references.
- Quoted / quasiquoted symbols (`'foo`, `(quote foo)`, `'(foo bar)`) are treated
  as inert data and resolve to nothing.
- Standard packages `COMMON-LISP`/`CL`, `COMMON-LISP-USER`/`CL-USER`, and
  `KEYWORD` are seeded as builtin identities (no redeclaration needed).
- External vs internal qualification is enforced: `pkg:foo` resolves only to
  exported symbols, `pkg::foo` may reach internal symbols.
- Uninterned symbols (`#:foo`) carry explicit identity and never resolve to a
  global definition.
- Workspace initialization is deterministic: semantic requests await a readiness
  barrier so an unopened file's definitions are available immediately after init.
- File URI/path handling uses Node's standard `fileURLToPath` / `pathToFileURL`.
- A clean, in-process LSP integration test covers init → indexing → open → Go to
  Definition into an unopened file → shutdown with no dangling handles.

## Milestone 2 — Richer static intelligence ✅

All of M2 is implemented and surfaced through the LSP server; a dedicated
**M2.1** integration/correctness pass wired the completion, signature-help and
diagnostics engines through LSP, corrected ordered lambda-list scope and
package-aware definition identity, and added static `COMMON-LISP` knowledge.

### M2A — Lexical semantics + Find References ✅

- Index lexical constructs: `let`, `let*`, `flet`, `labels`, `macrolet`,
  `symbol-macrolet`, `lambda`, `multiple-value-bind`, `destructuring-bind`.
- Lambda-list parameters are bound with correct **ordered** visibility
  (required → `&optional` → supplied-p → `&rest` → `&key` → `&aux`): an
  initializer form sees only the parameters established before it, per ANSI
  lambda-list semantics. `defgeneric` contributes signature metadata but no
  lexical body bindings.
- `textDocument/references` (Find References) over the resulting scopes.

### M2B — Full package resolution ✅

- Resolve symbols through `:use`, `:import-from`, `:shadow`, and
  `:shadowing-import-from`, building on the M1.1.1 external/internal and builtin
  package foundations.
- Definition identity is package-correct: a bare definition name denotes the
  imported / shadowing-imported / inherited symbol it reads as, while `:shadow`
  creates a fresh local identity. Go to Definition and Find References agree on
  that identity across packages.

### M2C — Semantic Tokens ✅

- `textDocument/semanticTokens` distinguishing special operators, macros,
  functions, generic functions, methods, classes, types, constants, special
  vs lexical variables, parameters, packages, keywords, slots, and undefined
  symbols.
- Standardized `COMMON-LISP` symbols are classified from a static catalog
  (`format`, `mapcar`, `when`, …) and tagged `defaultLibrary`.
- Theme-aware decorations only; never hard-coded colors. Parentheses stay
  visible and editable.

### M2D — Completion, Signature Help, Diagnostics ✅

- `textDocument/completion`: Lisp-2- and package-aware candidates (lexical,
  workspace-global and standard-library) with deterministic ranking and
  replacement ranges that preserve `pkg:`/`pkg::` qualifiers.
- `textDocument/signatureHelp` from captured lambda lists, with the active
  parameter derived from source structure (nested argument forms do not throw
  it off).
- `textDocument/publishDiagnostics` for **statically provable** problems only
  (unknown explicit package, non-exported external access, ambiguous inherited
  symbol, clearly invalid duplicate binding); unknown functions/variables are
  never flagged. Diagnostics refresh on buffer edits, initial indexing and
  cross-file package changes, and are cleared when resolved or on close.

### M2.1 — Static intelligence integration & correctness ✅

- Completion, Signature Help and Diagnostics advertised and handled at the LSP
  boundary (previously engine-only).
- Ordered lambda-list scope and `defgeneric` scope corrected.
- Package-aware definition identity corrected for imported / inherited /
  shadowed / shadowing-imported symbols.
- Static `COMMON-LISP` symbol catalog added (no invented source locations, no
  evaluation) to improve completion and semantic classification.
- Real LSP integration tests added for every advertised capability.

## Milestone 3 — ASDF project model

- Detect `.asd` files and build a static (untrusted) project model.
- Understand `:components`, `:file`, `:module`, `:depends-on`, `:serial`,
  `:class`.
- Diagnose missing dependencies, impossible ordering, and dependency cycles.
- `package-inferred-system` support where practical.
- Project tree view; code actions to edit dependencies/reorder components —
  always with a preview, never rewriting `.asd` files automatically.

## Milestone 4 — Live SBCL runtime

- Implement the runtime RPC protocol (`protocol/RUNTIME-PROTOCOL.md`) against an
  explicitly started, trusted SBCL image.
- Merge runtime metadata with the static model (`origin` already distinguishes
  the two sources).
- `LispImplementation` boundary kept SBCL-only at first; CCL/ECL later.

## Milestone 5 — REPL + Inspector

- A first-class REPL that knows returned values are Lisp objects, offering
  type-aware rendering and `[Inspect]` affordances rather than a raw terminal.

## Milestone 6 — Debugger / Conditions / Restarts

- Surface the Common Lisp condition system interactively: break into the
  debugger, inspect the restart set, and choose restarts from the editor.

## Milestone 7 — Dependency UX

- Structural navigation beyond a flat definition tree.
- ASDF dependency graphs and cycle visualization (Webviews reserved for genuinely
  custom visualizations like these).
- Dependency management across Qlot, Quicklisp, Ultralisp, Git, and local
  systems.
- Refactoring support.

## Non-goals

- Changing Common Lisp or introducing a new dialect.
- Structural editing of source. Structural views are read-only projections of
  the Lisp source; navigation never rewrites the buffer.
- Hiding or replacing parentheses.
