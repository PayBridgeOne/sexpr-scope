# SexprScope

A modern Common Lisp development environment for Visual Studio Code.

SexprScope is an **IDE/tooling layer** for Common Lisp — not a new dialect. Your
source stays in ordinary `.lisp` / `.cl` files; SexprScope adds reliable,
editor-grade navigation and understanding on top. The long-term goal is a
development experience closer to Rider/Visual Studio while keeping the
interactive and structural strengths that make Lisp unique.

> **Status:** Milestone 1 (foundation), hardened. A small but real vertical
> slice of *static* navigation that works even when no Lisp image is running.
> See [`docs/ROADMAP.md`](docs/ROADMAP.md) for what comes next.

## What works today

- **Safe static analysis** — a non-evaluating parser that **never executes your
  code** when a workspace is opened (even `#.` read-time evaluation is treated as
  inert data). Tolerant of incomplete/partially written files.
- **Reader conditionals & discards** — `#+`/`#-` feature tests are parsed
  structurally (never evaluated); a guarded definition is only used as a
  last resort and is marked conditional. `#;` discarded data never creates
  definitions.
- **Real workspace indexing** — on startup the server discovers and statically
  indexes every `.lisp` / `.cl` / `.lsp` / `.asd` file across all workspace
  folders (skipping `.git`, `node_modules`, `dist`, `out`, `build`). File
  creations, edits and deletions are picked up incrementally via
  `workspace/didChangeWatchedFiles`. Open editor buffers always override the
  on-disk copy.
- **Package-aware symbol index** — understands `defpackage`/`in-package`,
  qualified names (`pkg:foo`, `pkg::foo`, `:keyword`) and nicknames, so symbols
  with the same name in different packages don't collide. Nicknames are
  canonicalized so `pay:x` and `payment:x` resolve to one identity. The standard
  packages `COMMON-LISP` (`CL`), `COMMON-LISP-USER` (`CL-USER`) and `KEYWORD`
  are known without being redeclared, so `(in-package :cl-user)` and the default
  package are one identity. External qualification (`pkg:foo`) resolves **only**
  to exported symbols; internal qualification (`pkg::foo`) may reach any symbol.
  Uninterned symbols (`#:foo`) and keywords never resolve to a global
  definition.
- **Lisp-2 aware navigation** — references resolve in the namespace implied by
  their syntactic position: a list head or `#'name` / `(function name)` is a
  **function** reference; an ordinary evaluated position (e.g. `(+ process 1)`)
  is a **value** reference; quoted or quasiquoted symbols (`'foo`, `(quote
  foo)`, `'(foo bar)`) are inert **data** and resolve to nothing. A value
  reference never resolves to a function-only definition (and vice versa).
  Resolution is conservative: it never falls back to a same-named symbol in an
  unrelated package (no definition beats a wrong one).
- **Generic functions vs methods** — a call resolves to the `defgeneric`;
  `defmethod`s are modeled as its implementations, not peer definitions.
- **LSP features** — Document Symbols, Workspace Symbols, Go to Definition, and
  Hover (kind, lambda list, docstring, export status).
- **Lisp Structure view** — a native VS Code tree grouping the active file's
  definitions by kind; click to jump to the source. Structural editing is
  intentionally not part of SexprScope. Structural views are read-only
  projections of the Lisp source.

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
server first. CI and reproducible installs use `npm ci` against the committed
lockfiles.

```sh
# Language server
cd server
npm ci
npm run build
npm test        # unit + workspace/file-watching integration tests

# VS Code extension
cd ../extension
npm ci
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
