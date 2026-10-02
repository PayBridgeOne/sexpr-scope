# SexprScope Architecture

SexprScope is an **IDE/tooling layer** for Common Lisp. It does not change the
language: source files stay ordinary `.lisp` / `.cl` files, and the original
source is always the authoritative representation.

This document describes the architecture established through Milestone 2 and the
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
  document symbols, workspace symbols, Go-to-Definition, Find References, hover,
  semantic tokens, completion, signature help and conservative diagnostics. It
  must keep working even when no Lisp image is available — static intelligence
  never depends on loading the project.
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
  the live feature set. A guarded definition is therefore treated as an
  *uncertain* candidate (Option B): it is still indexed and its feature test is
  preserved on the symbol (`featureExpression`), but it is only surfaced for
  Go-to-Definition when no unconditional definition exists, and hover annotates
  it as conditionally defined so the result is never presented as unquestionably
  active. Runtime feature evaluation is intentionally deferred to a later
  milestone.
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

Initialization is **deterministic**: the initial workspace scan runs during the
LSP `initialize` handshake behind an internal readiness barrier, and every
semantic request (`definition`, `hover`, `documentSymbol`, `workspace/symbol`)
awaits that barrier before answering. A definition in an unopened workspace file
is therefore available on the first request after initialization completes —
there is no race where an early request sees a partially built index. The
barrier never blocks forever on unreadable files (read errors are skipped), and
awaiting it triggers no rescans.

## Package awareness

Symbols are never treated as global strings. Every symbol carries its owning
package, parsed from `defpackage` and tracked through `in-package`. The model
understands `foo`, `package:foo`, `package::foo`, keyword `:foo`, and package
nicknames, so two symbols with the same print name in different packages never
collide (see `server/src/model/symbol.ts`). `defpackage` options understood:
`:use`, `:nicknames`, `:export`, `:documentation`, `:import-from`, `:shadow`
and `:shadowing-import-from`.

Package **identities are canonicalized**: a `defpackage` nickname is mapped back
to its defining package name, so an `in-package` using a nickname (`:pay`) does
not fork the identity of a symbol defined under the canonical name (`PAYMENT`).

The **standard packages** are seeded into the package model without requiring a
workspace `defpackage` (`BUILTIN_PACKAGES` in `server/src/model/symbol.ts`):
`COMMON-LISP` (nickname `CL`), `COMMON-LISP-USER` (nickname `CL-USER`, the
default package) and `KEYWORD`. So `CL` and `COMMON-LISP` are one identity,
`(in-package :cl-user)` and the default package are one identity, and users need
not redeclare these standard nicknames. Builtin aliases are seeded first, so a
workspace `defpackage` that reuses one of these names still overrides it.

**External vs internal qualification is enforced** during resolution
(`resolveReference` in `server/src/indexer/workspace-index.ts`): a single-colon
reference (`pkg:foo`) resolves only to symbols the package actually exports,
while a double-colon reference (`pkg::foo`) may reach internal symbols too.
`pkg:private-function` therefore yields no result rather than a non-exported
definition.

**Uninterned symbols** (`#:foo`) carry an explicit `uninterned` qualification
and never resolve to a global `FOO`; keyword references likewise never resolve
to a package definition.

## The static symbol model

`SymbolDefinition` (`server/src/model/symbol.ts`) carries: `name`, `package`,
`kind`, `namespace`, binding `scope`, source `uri`, full `range`, name
`selectionRange`, `documentation`, `lambdaList`, `exported` status, `conditional`
(set when guarded by `#+`/`#-`), `featureExpression` (the raw feature test, e.g.
`+sbcl`, preserved for future runtime reconciliation), `methodImplementation`
(set for `defmethod`), and `origin` (static vs runtime). Qualified references are
parsed into a `qualification` of `none` / `keyword` / `internal` / `external` /
`uninterned`, which drives package resolution. The indexer recognizes these
definers:

`defun`, `defmacro`, `define-compiler-macro`, `defgeneric`, `defmethod`,
`defclass`, `defstruct`, `defvar`, `defparameter`, `defconstant`, `deftype`,
`define-condition`, and `defpackage`.

### Lisp-2 namespaces and reference contexts

Common Lisp is a Lisp-2 (really Lisp-N): a name can denote a function, a value,
a type and a package independently. Each definition records which `Namespace`
it occupies (function / value / type / package), derived from its definer.

A reference is classified by its **syntactic position** into a strongly typed
`ReferenceContext` (`server/src/model/reference.ts`) rather than a loose
`"any"` fallback:

- **Function** — the head of a call form, or the operand of `#'name` /
  `(function name)` (including `(function (setf name))`, normalized to the
  `(SETF NAME)` print name). Resolves in the function namespace only.
- **Value** — an ordinary evaluated position, such as an argument (`(+ process
  1)`) or a bare symbol. Resolves in the value namespace only; it never falls
  back to a function-only definition, so a `defun` without a matching `defvar`
  yields *no* value target.
- **Data** — a quoted or quasiquoted symbol (`'foo`, `` `foo ``, `(quote foo)`,
  and quoted list heads like `'(foo bar)`). These are literal data, not
  bindings, so they resolve to nothing. An unquote (`,x` / `,@x`) inside a
  quasiquote re-enters a value context.

Resolution is deliberately conservative — it never falls back to a same-named
symbol in an unrelated package, because a wrong Go-to-Definition target is worse
than none. When static analysis cannot know whether a position binds anything
(data positions, uninterned symbols, keywords), it returns no result instead of
guessing.

### Generic functions vs methods

A `defgeneric` is the definition a call site names; its `defmethod`s are
*implementations*, not peer definitions. When a generic function is present it is
preferred over its methods for Go-to-Definition; the methods remain queryable
(`methodsFor`) for future "go to implementations" support. No method dispatch is
performed — that requires a running image.

### Global vs lexical bindings

The symbol model distinguishes package-global definitions from lexical bindings
(`scope`), so a `let`/`flet`/`lambda` variable is never given a fake package
owner. M2 indexes lexical constructs — `let`, `let*`, `flet`, `labels`,
`macrolet`, `symbol-macrolet`, `lambda`, `multiple-value-bind`,
`destructuring-bind` and lambda-list parameters — as real bindings with their
own scope ranges, which is what powers Find References.

Lambda-list parameters are bound with **ordered** visibility rather than being
treated as simultaneously bound. ANSI specifies that lambda-list initialization
is sequential: required parameters are established first, then `&optional`
(each supplied-p after its value), then `&rest`, then `&key` (and their
supplied-p), then `&aux` (LET\*-like). Each `LambdaListVariable` therefore
carries a `scopeStart` offset, and an initializer/default form only sees the
parameters established before it. A new binding is *not* visible in its own
initializer merely because it shares a print name with an outer binding — e.g.
in `(lambda (&optional (x x)) x)` the init-form `x` refers to the outer `x`,
while the body `x` refers to the parameter. `defgeneric` is **not** treated as
a parameterized definer: it describes a generic function's congruence lambda
list, not a lexical body, so it contributes signature metadata but creates no
lexical bindings.

### Package-aware definition identity

A bare definition name is interned according to package accessibility, not
blindly homed in the current package. Common Lisp reads a symbol *before*
`defun`/`defvar` assign a binding, so if the source spelling already denotes an
imported, shadowing-imported or inherited symbol, the definition belongs to that
symbol's original home package. `WorkspaceIndex` resolves definition homes in a
circularity-free first pass (package accessibility is decided before raw
definitions are allowed to intern new local symbols): `:import-from` and
`:shadowing-import-from` keep the exporting package's identity, an inherited
symbol (via `:use`) stays homed in the used package, and `:shadow` creates a
fresh local identity. Go-to-Definition and Find References consult the same
`definitionHome` map, so they agree on identity across packages. Where static
information is genuinely ambiguous the model declines to guess.

### Static standard-library knowledge

`server/src/model/standard-library.ts` is a catalog of standardized
`COMMON-LISP` symbol names classified as function, macro, special operator,
type/class/condition, constant or special variable. It is pure factual language
metadata — **no** documentation bodies are copied, **no** source locations are
invented, and nothing is evaluated. A reference or completion in a context that
`:use`s `COMMON-LISP` (or an explicit `cl:` prefix) can therefore be classified
and completed statically: `(mapcar …)` and `(format …)` are known functions,
`(when …)` a known macro, while `if`/`let` remain special operators from the
central language knowledge. Resolution is Lisp-2-gated (function-ish kinds only
answer function positions; constants/variables only value positions) and
conservative — type specifiers are not resolved from value positions, to avoid
misclassifying ordinary variables named like a type. Builtin targets carry no
location, so Go-to-Definition never navigates to a fake file; they surface
through semantic tokens (tagged `defaultLibrary`), hover and completion.

## LSP features

Implemented through M2 (`server/src/lsp`): `textDocument/documentSymbol`,
`workspace/symbol`, `textDocument/definition`, `textDocument/references`,
`textDocument/hover`, `textDocument/semanticTokens`, `textDocument/completion`,
`textDocument/signatureHelp` and `textDocument/publishDiagnostics`, plus
`workspace/didChangeWatchedFiles` and init-time workspace scanning. Each
capability is advertised during `initialize` and has at least one real LSP
integration test driving the server boundary (`server/test/lsp-*.test.ts`).

All of these features consume **one** semantic resolution model: the LSP
handlers are thin adapters over `WorkspaceIndex` — `resolveAt`, `findReferences`,
`semanticTokens`, `completions`, `signatureHelp` and `diagnostics` — and the
internal `CompletionCandidate` / `SignatureModel` / diagnostic shapes are mapped
to LSP types in `server/src/lsp/conversions.ts`. The handlers never re-derive
resolution, re-parse lambda lists or re-run completion logic of their own, so
Definition, References, Hover, Semantic Tokens, Completion, Signature Help and
Diagnostics all agree on symbol identity.

- **Completion** classifies the cursor position (function vs value, package
  prefix) and returns lexical, workspace-global and standard-library candidates
  with deterministic ranking. It emits a `TextEdit` replacement range so
  `pay:aut|` replaces only `aut` and preserves the `pay:` (or `pay::`) qualifier
  instead of destroying it. Comments, strings and quoted data yield no semantic
  completion.
- **Signature Help** maps the callable's captured lambda list to
  `SignatureInformation`/`ParameterInformation`; the active parameter is computed
  from source structure (counting completed argument forms), so a nested form in
  an earlier argument does not shift it. Trigger characters are conservative and
  manual invocation always works.
- **Diagnostics** are published when an open document is first indexed, when it
  changes, and when package information in another workspace file changes (so
  editing a `defpackage`'s `:export` list refreshes dependent open files).
  Diagnostics are cleared when the issue is resolved or the document closes;
  stale diagnostics are never left behind. Only statically provable problems are
  reported (unknown explicit package, non-exported external access, ambiguous
  inherited symbol, clearly invalid duplicate binding) — an unresolved function
  or variable is never diagnosed, because Common Lisp legitimately establishes
  names at load or run time.

Definition and hover classify the reference position into a function / value /
data context (see *Lisp-2 namespaces and reference contexts*) and resolve in the
matching namespace; data positions resolve to nothing. Semantic requests await
the initialization readiness barrier so results are deterministic. The server
speaks LSP over stdio and has no VS Code dependency; `createServer` returns a
handle exposing `whenReady`, which also lets tests drive the server behind a
clean, in-process transport boundary (`server/test/lsp-integration.test.ts` and
`server/test/lsp-features.test.ts`) without leaving open handles.

File URI/path conversion (`server/src/lsp/workspace-fs.ts`) uses Node's standard
`fileURLToPath` / `pathToFileURL` helpers rather than a hand-rolled converter, so
paths with spaces, Unicode, and Windows drive letters round-trip correctly and
the server stays platform-neutral.

## Structural view (read-only)

The VS Code **Lisp Structure** tree groups a file's definitions by kind for
navigation, understanding, inspection and source reveal. Structural editing is
intentionally not part of SexprScope. Structural views are read-only projections
of the Lisp source: the `.lisp` source remains the only editable representation,
and the tree never rewrites the buffer. AST editing, drag-and-drop source
manipulation, alternate visual syntax, and graphical source generation are
explicit non-goals.

## Implementation abstraction

Only SBCL is targeted now, but implementation-specific behaviour is kept behind
a boundary (`LispImplementation`, described in the runtime protocol) so CCL and
ECL can be added later without threading SBCL assumptions throughout the code.

## ASDF as a project model (planned)

`.asd` files are treated as a first-class, but **untrusted**, project model.
Static discovery parses them with the same non-evaluating parser and never
executes them. Runtime ASDF loading is a separate, explicitly trusted operation.
