# SexprScope Architecture

SexprScope is an **IDE/tooling layer** for Common Lisp. It does not change the
language: source files stay ordinary `.lisp` / `.cl` files, and the original
source is always the authoritative representation.

This document describes the architecture established by Milestone 1 and the
boundaries that let future milestones grow cleanly.

## Components

```
                         VS CODE
                            │
        ┌───────────────────┼────────────────────┐
        ▼                   ▼                    ▼
  VS Code Extension    Language Server      Runtime Client
    (TypeScript)        (static model)       (future)
        │                   │                    │
   editor UI,          safe parsing,        live Lisp RPC
   Lisp Structure      package-aware         ───────────────▶  SBCL
   tree view, LSP      symbol index,
   client              LSP features
```

| Directory    | Responsibility                                                        |
| ------------ | --------------------------------------------------------------------- |
| `extension/` | VS Code integration only: LSP client + native **Lisp Structure** view |
| `server/`    | Reusable language intelligence behind LSP (editor-agnostic)           |
| `protocol/`  | The separate **runtime** RPC contract (static vs live boundary)       |
| `fixtures/`  | A sample ASDF project used by tests and manual exercise               |
| `docs/`      | Architecture and roadmap                                              |

The extension is intentionally thin. All language intelligence lives in the
language server so that another editor could reuse it; VS Code is the *first*
client, not an architectural dependency.

## Two sources of semantic information

SexprScope distinguishes a **static model** from a **live runtime model**:

- The **static model** understands source code *without executing it*. It powers
  document symbols, workspace symbols, Go-to-Definition and hover. It must keep
  working even when no Lisp image is available — basic navigation never depends
  on loading the project.
- The **live runtime model** (future) obtains information from a running SBCL
  image over the dedicated runtime protocol (`protocol/RUNTIME-PROTOCOL.md`).

```
source files
    │
    ▼
safe, non-evaluating parser          (server/src/parser)
    │
    ▼
package-aware static symbol index    (server/src/indexer)
    │
    ├───────────────┐
    ▼               ▼
LSP features     SBCL image (future)
                     │
                     ▼
              runtime metadata
```

## Static parsing safety

This is a hard safety requirement. **Opening a workspace must never execute
arbitrary source code.**

Common Lisp's standard reader can run code at read time (`#.`), via custom
reader macros, or through modified readtables. Therefore SexprScope does **not**
use the Lisp reader as its static parser. Instead `server/src/parser` implements
a self-contained, non-evaluating tokenizer and tolerant tree reader:

- `#.` read-time evaluation is recognized as an inert prefix and **never
  evaluated**; it is treated as ordinary structural data.
- Strings, nested `#| |#` block comments, `#\` character literals, quotes and
  sharpsign forms are lexed structurally.
- The reader tolerates partially written / syntactically incomplete files
  (unbalanced parentheses, unterminated strings) and never throws.

### Why not tree-sitter (yet)?

Tree-sitter was evaluated as the suggested default. `tree-sitter-commonlisp`
exists and is safe (it only parses, never evaluates), but as of this writing it
is lightly maintained and would introduce a native build dependency. For
Milestone 1 a small hand-written parser keeps the toolchain pure-TypeScript,
fully unit-testable in CI, and gives precise control over error tolerance and
the non-evaluation guarantee. The parser is isolated behind a narrow interface
(`parseDocument`), so swapping in tree-sitter later — if its maintenance and
safety profile justify it — is a contained change.

## Package awareness

Symbols are never treated as global strings. Every symbol carries its owning
package, parsed from `defpackage` and tracked through `in-package`. The model
understands `foo`, `package:foo`, `package::foo`, keyword `:foo`, and package
nicknames, so two symbols with the same print name in different packages never
collide (see `server/src/model/symbol.ts`). `defpackage` options understood in
M1: `:use`, `:nicknames`, `:export`, `:documentation`.

## The static symbol model

`SymbolDefinition` (`server/src/model/symbol.ts`) carries: `name`, `package`,
`kind`, source `uri`, full `range`, name `selectionRange`, `documentation`,
`lambdaList`, `exported` status, and `origin` (static vs runtime). The indexer
recognizes these definers in M1:

`defun`, `defmacro`, `define-compiler-macro`, `defgeneric`, `defmethod`,
`defclass`, `defstruct`, `defvar`, `defparameter`, `defconstant`, `deftype`,
`define-condition`, and `defpackage`.

Lexical constructs (`let`, `flet`, `labels`, `lambda`, `multiple-value-bind`,
…) are not yet indexed; the model is shaped so they can be added without
reworking the symbol type.

## LSP features

Implemented in M1 (`server/src/lsp`): `textDocument/documentSymbol`,
`workspace/symbol`, `textDocument/definition`, `textDocument/hover`. The server
speaks LSP over stdio and has no VS Code dependency.

## Implementation abstraction

Only SBCL is targeted now, but implementation-specific behaviour is kept behind
a boundary (`LispImplementation`, described in the runtime protocol) so CCL and
ECL can be added later without threading SBCL assumptions throughout the code.

## ASDF as a project model (planned)

`.asd` files are treated as a first-class, but **untrusted**, project model.
Static discovery parses them with the same non-evaluating parser and never
executes them. Runtime ASDF loading is a separate, explicitly trusted operation.
