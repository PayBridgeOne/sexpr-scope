import {
  AtomNode,
  Document,
  NodeKind,
  SyntaxNode,
  stripPrefixes,
} from "../parser/reader";
import { QualificationKind, parseQualifiedName } from "./symbol";

/**
 * The Lisp-2 context a reference occupies, implied purely by its syntactic
 * position. Common Lisp keeps function and value namespaces separate, and
 * quoted/literal data is not a binding reference at all, so Go-to-Definition
 * must classify a reference before resolving it.
 */
export enum ReferenceContext {
  /** Operator position `(foo …)`, `#'foo`, `(function foo)`: function namespace. */
  Function = "function",
  /** An ordinary evaluated value position `foo`, `(+ foo 1)`: value namespace. */
  Value = "value",
  /** Quoted/literal data `'foo`, `(quote foo)`, keywords: not a binding. */
  Data = "data",
}

/** A fully classified reference at a source position. */
export interface Reference {
  /** Canonical print name; may be `(SETF FOO)` for a setf-function designator. */
  readonly name: string;
  readonly packagePrefix?: string;
  readonly qualification: QualificationKind;
  readonly context: ReferenceContext;
}

type Ctx = "function" | "value" | "data";

function toContext(ctx: Ctx): ReferenceContext {
  switch (ctx) {
    case "function":
      return ReferenceContext.Function;
    case "value":
      return ReferenceContext.Value;
    case "data":
      return ReferenceContext.Data;
  }
}

/** Upper-cased operator name of a list head, if it is a bare atom. */
function operatorName(node: SyntaxNode | undefined): string | undefined {
  const inner = stripPrefixes(node);
  if (inner && inner.kind === NodeKind.Atom) {
    return parseQualifiedName(inner.text).name;
  }
  return undefined;
}

/** A classified reference together with the atom node it occupies. */
export interface ReferenceOccurrence {
  readonly node: AtomNode;
  readonly reference: Reference;
}

type Emit = (node: AtomNode, reference: Reference) => void;

/**
 * Visits every symbol occurrence in a document, classifying each by its Lisp-2
 * context. This is the single traversal shared by {@link referenceAt} (which
 * filters to the occurrence under a cursor) and {@link collectReferences} (which
 * returns every occurrence for Find References and semantic tokens), so the
 * classification logic is never duplicated.
 *
 * The traversal tracks whether a position is evaluated as a function, as a
 * value, or is inert quoted data:
 *  - a list head and the target of `#'` / `(function …)` are functions;
 *  - arguments and other evaluated forms are values;
 *  - `'`/`` ` ``-quoted data (and `(quote …)` arguments) are data, except that
 *    `,`/`,@` unquotes re-enter evaluation inside a quasiquote.
 */
export function forEachReference(doc: Document, emit: Emit): void {
  const recordAtom = (node: AtomNode, ctx: Ctx): void => {
    const q = parseQualifiedName(node.text);
    emit(node, {
      name: q.name,
      packagePrefix: q.packagePrefix,
      qualification: q.qualification,
      context: toContext(ctx),
    });
  };

  const visit = (node: SyntaxNode, ctx: Ctx): void => {
    switch (node.kind) {
      case NodeKind.Atom:
        recordAtom(node, ctx);
        return;
      case NodeKind.String:
        return;
      case NodeKind.Prefixed: {
        if (!node.child) return;
        switch (node.prefix) {
          case "#'":
            visit(node.child, "function");
            break;
          case "'":
          case "`":
            visit(node.child, "data");
            break;
          case ",":
          case ",@":
            // Unquote re-enters evaluation inside quasiquoted data.
            visit(node.child, ctx === "data" ? "value" : ctx);
            break;
          default:
            visit(node.child, ctx);
            break;
        }
        return;
      }
      case NodeKind.ReaderConditional:
        // The feature expression is inert data; the guarded datum keeps context.
        if (node.feature) visit(node.feature, "data");
        if (node.child) visit(node.child, ctx);
        return;
      case NodeKind.Discard:
        return;
      case NodeKind.List:
      case NodeKind.Vector: {
        const children = node.children;
        if (ctx === "data") {
          for (const child of children) visit(child, "data");
          return;
        }
        const op = operatorName(children[0]);
        if (op === "QUOTE") {
          // (quote x): the operator is a function, its arguments are data.
          visit(children[0], "function");
          for (let i = 1; i < children.length; i++) visit(children[i], "data");
          return;
        }
        if (op === "FUNCTION") {
          // (function x) / (function (setf x)): x is in the function namespace.
          for (const child of children) visit(child, "function");
          return;
        }
        if (op === "SETF" && ctx === "function" && children.length >= 2) {
          // `(setf place)` in a function-designator position names (SETF PLACE).
          visit(children[0], "function");
          const target = stripPrefixes(children[1]);
          if (target && target.kind === NodeKind.Atom) {
            const q = parseQualifiedName(target.text);
            emit(target, {
              name: `(SETF ${q.name})`,
              packagePrefix: q.packagePrefix,
              qualification: q.qualification,
              context: ReferenceContext.Function,
            });
            for (let i = 2; i < children.length; i++) visit(children[i], "value");
            return;
          }
          for (let i = 1; i < children.length; i++) visit(children[i], "value");
          return;
        }
        // Ordinary call: the head is a function, the rest are evaluated values.
        for (let i = 0; i < children.length; i++) {
          visit(children[i], i === 0 ? "function" : "value");
        }
        return;
      }
    }
  };

  for (const root of doc.roots) visit(root, "value");
}

/** Every classified symbol occurrence in a document, in source order. */
export function collectReferences(doc: Document): ReferenceOccurrence[] {
  const out: ReferenceOccurrence[] = [];
  forEachReference(doc, (node, reference) => out.push({ node, reference }));
  return out;
}

/** The occurrence (atom + classified reference) under `offset`, if any. */
export function referenceOccurrenceAt(
  doc: Document,
  offset: number,
): ReferenceOccurrence | undefined {
  let found: ReferenceOccurrence | undefined;
  forEachReference(doc, (node, reference) => {
    if (offset >= node.range.start.offset && offset <= node.range.end.offset) {
      found = { node, reference };
    }
  });
  return found;
}

/**
 * Classifies the reference at `offset`, returning its print name, package
 * qualification and Lisp-2 context. Returns `undefined` when no symbol sits
 * under the offset.
 */
export function referenceAt(doc: Document, offset: number): Reference | undefined {
  return referenceOccurrenceAt(doc, offset)?.reference;
}

/** Convenience wrapper returning only the Lisp-2 context at `offset`. */
export function referenceContextAt(
  doc: Document,
  offset: number,
): ReferenceContext | undefined {
  return referenceAt(doc, offset)?.context;
}
