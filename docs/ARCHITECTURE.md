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
- `#+`/`#-` reader conditionals are parsed structurally: the feature expression
  (e.g. `SBCL` or `(and sbcl unix)`) is kept as uninterpreted syntax and the
  guarded datum is wrapped so the indexer can mark anything it defines as
  conditional. Features are **never evaluated** — static analysis cannot know
  the live feature set, so a guarded definition is only surfaced when no
  unconditional one exists.
- `#;` discards the following datum entirely; the discarded form never
  contributes a definition (it is treated like a comment).
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

## Workspace indexing

When an editor initializes the server, SexprScope discovers and statically
indexes the whole workspace (`server/src/lsp/workspace-fs.ts`):

- Every `.lisp` / `.cl` / `.lsp` / `.asd` file under each workspace folder is
  read **as text only** and parsed with the non-evaluating parser. Directories
  that never hold project source (`.git`, `node_modules`, `dist`, `out`,
  `build`) are skipped.
- An open editor buffer is authoritative: if a URI is open, its unsaved content
  is never clobbered by the on-disk copy.
- File creates/edits/deletes arrive through `workspace/didChangeWatchedFiles`
  and update the index incrementally (delete removes the document; create/modify
  re-reads it). Events for open buffers are ignored.

This keeps navigation consistent across files the user has not opened, while
preserving the hard guarantee that opening a workspace never executes code.

## Package awareness

Symbols are never treated as global strings. Every symbol carries its owning
package, parsed from `defpackage` and tracked through `in-package`. The model
understands `foo`, `package:foo`, `package::foo`, keyword `:foo`, and package
nicknames, so two symbols with the same print name in different packages never
collide (see `server/src/model/symbol.ts`). `defpackage` options understood in
M1: `:use`, `:nicknames`, `:export`, `:documentation`.

Package **identities are canonicalized**: a `defpackage` nickname is mapped back
to its defining package name, so an `in-package` using a nickname (`:pay`) does
not fork the identity of a symbol defined under the canonical name (`PAYMENT`).
Standard nicknames not declared by any workspace `defpackage` (e.g. `CL-USER`
for `COMMON-LISP-USER`) are left as written — the index only knows the packages
it has actually seen.

## The static symbol model

`SymbolDefinition` (`server/src/model/symbol.ts`) carries: `name`, `package`,
`kind`, `namespace`, binding `scope`, source `uri`, full `range`, name
`selectionRange`, `documentation`, `lambdaList`, `exported` status, `conditional`
(set when guarded by `#+`/`#-`), `methodImplementation` (set for `defmethod`),
and `origin` (static vs runtime). The indexer recognizes these definers in M1:

`defun`, `defmacro`, `define-compiler-macro`, `defgeneric`, `defmethod`,
`defclass`, `defstruct`, `defvar`, `defparameter`, `defconstant`, `deftype`,
`define-condition`, and `defpackage`.

### Lisp-2 namespaces

Common Lisp is a Lisp-2 (really Lisp-N): a name can denote a function, a value,
a type and a package independently. Each definition records which `Namespace`
it occupies (function / value / type / package), derived from its definer. A
reference is resolved using the namespace implied by its **syntactic position**
(`referenceNamespaceAt`): the head of a list and the target of `#'` / `(function
…)` require the function namespace; a quoted list head is plain data; other
positions are left as `any` so resolution considers every namespace rather than
guessing. Resolution is deliberately conservative — it never falls back to a
same-named symbol in an unrelated package, because a wrong Go-to-Definition
target is worse than none.

### Generic functions vs methods

A `defgeneric` is the definition a call site names; its `defmethod`s are
*implementations*, not peer definitions. When a generic function is present it is
preferred over its methods for Go-to-Definition; the methods remain queryable
(`methodsFor`) for future "go to implementations" support. No method dispatch is
performed — that requires a running image.

### Global vs lexical bindings

The symbol model distinguishes package-global definitions from lexical bindings
(`scope`), so lexical constructs can be added later **without** inventing a fake
package owner for a `let`/`flet`/`lambda` variable. M1 only indexes global
definitions; the shape is in place for M2 lexical scope.

## LSP features

Implemented in M1 (`server/src/lsp`): `textDocument/documentSymbol`,
`workspace/symbol`, `textDocument/definition`, `textDocument/hover`, plus
`workspace/didChangeWatchedFiles` and init-time workspace scanning. Definition
and hover use the Lisp-2 namespace of the reference position. The server speaks
LSP over stdio and has no VS Code dependency.

## Structural view (read-only)

The VS Code **Lisp Structure** tree groups a file's definitions by kind for
navigation only. Structural *editing* of source is intentionally out of scope;
the tree never rewrites the buffer.

## Implementation abstraction

Only SBCL is targeted now, but implementation-specific behaviour is kept behind
a boundary (`LispImplementation`, described in the runtime protocol) so CCL and
ECL can be added later without threading SBCL assumptions throughout the code.

## ASDF as a project model (planned)

`.asd` files are treated as a first-class, but **untrusted**, project model.
Static discovery parses them with the same non-evaluating parser and never
executes them. Runtime ASDF loading is a separate, explicitly trusted operation.
