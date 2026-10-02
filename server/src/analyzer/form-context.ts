import {
  Document,
  ListNode,
  SyntaxNode,
  isAtom,
  isList,
  stripPrefixes,
} from "../parser/reader";
import { parseQualifiedName } from "../model/symbol";

/**
 * The innermost list/compound form that contains a source offset, together with
 * whether a *new element* typed at that offset would be inert quoted data.
 *
 * Completion and signature help share this so neither re-derives Common Lisp's
 * quote/quasiquote evaluation contexts: a new atom inside `(quote …)`, `'(…)` or
 * a backquoted list is data (no code completion / no call signature), while a
 * normal call's arguments are evaluated.
 */
export interface EnclosingList {
  readonly list: ListNode;
  /** True when elements of this list are inert data rather than evaluated code. */
  readonly data: boolean;
}

/** Upper-cased operator name of a list head, if it is a bare atom. */
function operatorName(list: ListNode): string | undefined {
  const head = stripPrefixes(list.children[0]);
  if (head && isAtom(head)) return parseQualifiedName(head.text).name;
  return undefined;
}

function within(node: SyntaxNode, offset: number): boolean {
  return offset >= node.range.start.offset && offset <= node.range.end.offset;
}

/**
 * Finds the innermost list containing `offset`, propagating quote/quasiquote
 * data context from the enclosing forms. Returns `undefined` at top level.
 */
export function findEnclosingList(
  doc: Document,
  offset: number,
): EnclosingList | undefined {
  let best: EnclosingList | undefined;

  const visit = (node: SyntaxNode, data: boolean): void => {
    if (!within(node, offset)) return;
    if (isList(node)) {
      const op = data ? undefined : operatorName(node);
      // Whether elements inside this list are data: inherited data context, or a
      // `(quote …)` whose arguments are data.
      const childrenAreData = data || op === "QUOTE";
      best = { list: node, data: childrenAreData };
      for (let i = 0; i < node.children.length; i++) {
        const childData = data ? true : op === "QUOTE" ? i > 0 : false;
        visit(node.children[i], childData);
      }
      return;
    }
    if (node.kind === "prefixed") {
      if (!node.child) return;
      let childData = data;
      if (node.prefix === "'" || node.prefix === "`") childData = true;
      else if (node.prefix === "," || node.prefix === ",@") childData = false;
      visit(node.child, childData);
      return;
    }
    if (node.kind === "reader-conditional") {
      if (node.child) visit(node.child, data);
      return;
    }
    // Atoms, strings and discards never contain a completable position.
  };

  for (const root of doc.roots) visit(root, false);
  return best;
}
