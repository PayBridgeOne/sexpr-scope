# SexprScope

A modern Common Lisp development environment for Visual Studio Code.

SexprScope is an **IDE/tooling layer** for Common Lisp — not a new dialect. Your
source stays in ordinary `.lisp` / `.cl` files; SexprScope adds reliable,
editor-grade navigation and understanding on top. The long-term goal is a
development experience closer to Rider/Visual Studio while keeping the
interactive and structural strengths that make Lisp unique.

> **Status:** Milestone 1 (foundation). A small but real vertical slice of
> *static* navigation that works even when no Lisp image is running. See
> [`docs/ROADMAP.md`](docs/ROADMAP.md) for what comes next.

## What works today

- **Safe static analysis** — a non-evaluating parser that **never executes your
  code** when a workspace is opened (even `#.` read-time evaluation is treated as
  inert data). Tolerant of incomplete/partially written files.
- **Package-aware symbol index** — understands `defpackage`/`in-package`,
  qualified names (`pkg:foo`, `pkg::foo`, `:keyword`) and nicknames, so symbols
  with the same name in different packages don't collide.
- **LSP features** — Document Symbols, Workspace Symbols, Go to Definition, and
  Hover (kind, lambda list, docstring, export status).
- **Lisp Structure view** — a native VS Code tree grouping the active file's
  definitions by kind; click to jump to the source.

Recognized definitions: `defun`, `defmacro`, `define-compiler-macro`,
`defgeneric`, `defmethod`, `defclass`, `defstruct`, `defvar`, `defparameter`,
`defconstant`, `deftype`, `define-condition`, `defpackage`.

## Repository layout

```
sexpr-scope/
├── extension/   VS Code extension (TypeScript): LSP client + Lisp Structure view
├── server/      Language server (TypeScript): safe parser, index, LSP features
├── protocol/    Runtime RPC protocol (static vs live-image boundary)
├── fixtures/    Sample ASDF project used by tests
└── docs/        ARCHITECTURE.md, ROADMAP.md
```

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the design, including the
static-vs-runtime split and the parser-safety rationale.

## Building

Requires Node.js ≥ 18. The extension depends on the built server, so build the
server first.

```sh
# Language server
cd server
npm install
npm run build
npm test        # 28 unit + integration tests

# VS Code extension
cd ../extension
npm install
npm run build
```

Then open the repository in VS Code and launch the extension (Run and Debug →
*Run Extension*), or open `fixtures/sample-project` to try navigation on the
sample system.

## Design principles

- **Never evaluate on open.** Static analysis uses a dedicated non-evaluating
  parser; evaluation only ever happens through an explicitly started, trusted
  runtime (future).
- **Separation of concerns.** The language server holds all language
  intelligence and is editor-agnostic; the VS Code extension is a thin client.
- **Package-correct from the start.** Symbols are modeled with their package,
  never as bare strings.
- **Respect the editor.** Native VS Code UI (tree views, semantic tokens) over
  Webviews; theme-aware, no hard-coded colors; parentheses stay visible.
- **Supported implementation:** SBCL (2.6.9+) first, behind an abstraction so
  CCL/ECL can follow.

## Current target implementation

SBCL. Other implementations are intentionally deferred (see the roadmap) but the
architecture keeps implementation-specific behaviour behind a boundary.

## License

MIT — see [`LICENSE`](LICENSE).
