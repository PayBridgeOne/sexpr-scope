# SexprScope Runtime Protocol (draft)

SexprScope deliberately separates **two sources of semantic information**:

| Source            | Transport            | Trust / safety                               | Status |
| ----------------- | -------------------- | -------------------------------------------- | ------ |
| **Static model**  | LSP (stdio)          | Never evaluates source; safe on open         | ✅ M1  |
| **Live runtime**  | Runtime RPC (this)   | Only via an explicitly started, trusted SBCL | 🔜     |

The static model is covered by the Language Server Protocol and is implemented
in `server/`. This document specifies the **separate** protocol used for
interactive operations against a running Lisp image. Runtime concerns are kept
out of LSP messages because they do not naturally belong there (evaluation,
inspection of live objects, REPL I/O, debugger interaction).

> ⚠️ The runtime protocol is **not** implemented in Milestone 1. This document
> establishes the contract so the static and runtime halves can evolve
> independently.

## Design goals

- **Inspectable:** newline-delimited JSON-RPC 2.0 over a stream (stdio or TCP),
  so traffic can be logged and debugged with ordinary tools.
- **Editor-agnostic:** no VS Code types cross the boundary.
- **Explicitly trusted:** a runtime connection only exists after the user starts
  an image. Static indexing never opens one.
- **Transport-pluggable:** the same message schema works over stdio for a child
  SBCL process or over a socket for an attached/remote image.

## Transport

- Framing: one JSON object per line (`\n`-delimited), UTF-8.
- Semantics: [JSON-RPC 2.0](https://www.jsonrpc.org/specification) — `request`,
  `response`, and `notification` objects.

## Lifecycle

| Method              | Direction        | Purpose                                    |
| ------------------- | ---------------- | ------------------------------------------ |
| `runtime/start`     | client → host    | Launch/attach an SBCL image for a workspace |
| `runtime/ready`     | host → client    | Image is up; includes implementation info   |
| `runtime/shutdown`  | client → host    | Request orderly shutdown                     |
| `runtime/exit`      | host → client    | Image has exited (with reason)               |

## Interactive methods (planned)

| Method               | Params                              | Result                                   |
| -------------------- | ----------------------------------- | ---------------------------------------- |
| `eval/form`          | `{ package, form }`                 | `{ values: RuntimeValue[], output }`     |
| `eval/interrupt`     | `{}`                                | `{}`                                     |
| `inspect/object`     | `{ handle }`                        | `{ title, parts: InspectPart[] }`        |
| `describe/symbol`    | `{ package, name }`                 | `{ kind, lambdaList, documentation, … }` |
| `completion/symbol`  | `{ package, prefix }`               | `{ items: RuntimeSymbol[] }`             |
| `debugger/enter`     | host → client                       | `{ condition, restarts, frames }`        |
| `debugger/invoke`    | `{ restart }`                       | `{}`                                     |

### `RuntimeValue`

A returned value is a Lisp object, not a string. The REPL uses this to offer
inspection and type-aware rendering:

```json
{
  "printed": "42.3",
  "type": "DOUBLE-FLOAT",
  "handle": "obj-128",
  "inspectable": true
}
```

`handle` is an opaque reference the host keeps alive for follow-up
`inspect/object` calls. `printed` is produced with printer safety settings
(bounded `*print-level*` / `*print-length*`).

## Relationship to ASDF

Runtime ASDF loading (`asdf:load-system`) is a **trusted** operation initiated
through `eval/form` or a dedicated `project/load-system` method. It must never
be triggered by static workspace discovery; static `.asd` analysis lives in the
static model and never evaluates the file.

## Backend abstraction

Methods are implementation-neutral. A `LispImplementation` boundary (SBCL today;
CCL/ECL later) provides the concrete image launch command and any
implementation-specific inspection hooks behind this same protocol.
