# SexprScope Roadmap

SexprScope aims to give Common Lisp a development experience closer to
Rider/Visual Studio, while preserving the interactive and structural strengths
that make Lisp unique. The vision is large; it is delivered incrementally.
Each milestone must be a real, testable vertical slice.

## Milestone 1 — Foundation (this milestone) ✅

A safe static-navigation slice that works **without** a running Lisp image.

- Monorepo with clearly separated components (`extension`, `server`,
  `protocol`, `fixtures`, `docs`).
- Safe, **non-evaluating** parser tolerant of incomplete files.
- Package-aware static symbol index for the core definers.
- LSP server: `documentSymbol`, `workspace/symbol`, `definition`, `hover`.
- VS Code extension: LSP client + native **Lisp Structure** tree view.
- Sample ASDF fixture project and unit/integration tests.
- CI building and testing both the server and the extension.

## Milestone 2 — Richer static intelligence

- Index lexical constructs: `let`, `let*`, `flet`, `labels`, `macrolet`,
  `symbol-macrolet`, `lambda`, `multiple-value-bind`, `destructuring-bind`.
- `textDocument/references` and `textDocument/completion`.
- `textDocument/signatureHelp` from captured lambda lists.
- `textDocument/publishDiagnostics` for clearly static problems (e.g. duplicate
  definitions, unbalanced forms).
- Full package resolution through `:import-from`, `:shadow`,
  `:shadowing-import-from`.

## Milestone 3 — Semantic highlighting

- `textDocument/semanticTokens` distinguishing special operators, macros,
  functions, generic functions, methods, classes, types, constants, special
  vs lexical variables, parameters, packages, keywords, slots, and undefined
  symbols.
- Theme-aware decorations only; never hard-coded colors. Parentheses stay
  visible and editable.

## Milestone 4 — ASDF project model

- Detect `.asd` files and build a static (untrusted) project model.
- Understand `:components`, `:file`, `:module`, `:depends-on`, `:serial`,
  `:class`.
- Diagnose missing dependencies, impossible ordering, and dependency cycles.
- `package-inferred-system` support where practical.
- Project tree view; code actions to edit dependencies/reorder components —
  always with a preview, never rewriting `.asd` files automatically.

## Milestone 5 — Live runtime

- Implement the runtime RPC protocol (`protocol/RUNTIME-PROTOCOL.md`) against an
  explicitly started, trusted SBCL image.
- Merge runtime metadata with the static model (`origin` already distinguishes
  the two sources).
- `LispImplementation` boundary kept SBCL-only for now; CCL/ECL later.

## Milestone 6 — Integrated REPL

- A first-class REPL that knows returned values are Lisp objects, offering
  type-aware rendering and `[Inspect]` affordances rather than a raw terminal.

## Milestone 7 — Structural & dependency visualization

- Structural navigation beyond a flat definition tree.
- ASDF dependency graphs and cycle visualization (Webviews reserved for genuinely
  custom visualizations like these).
- Refactoring support.

## Non-goals

- Changing Common Lisp or introducing a new dialect.
- Structural *editing* of source (navigation is read-only for now).
- Hiding or replacing parentheses.
