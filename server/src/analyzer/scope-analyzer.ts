import {
  Document,
  ListNode,
  NodeKind,
  SyntaxNode,
  isAtom,
  isList,
  stripPrefixes,
} from "../parser/reader";
import { Range } from "../parser/position";
import { Namespace, parseQualifiedName } from "../model/symbol";
import {
  LexicalBinding,
  LexicalBindingKind,
  Scope,
  lexicalBindingId,
} from "../model/scope";
import {
  BindingFormKind,
  bindingFormKind,
  isParameterizedDefiner,
} from "../model/language";
import { collectVariables } from "./lambda-list";

/**
 * Builds a document's lexical scope tree from its syntax tree.
 *
 * The analyzer walks evaluated positions only: quoted/quasiquoted data never
 * introduces bindings (an unquote re-enters evaluation, mirroring the reference
 * model). It models the standard binding forms precisely enough that
 * Go-to-Definition, Find References and shadowing are correct:
 *
 *  - `let` binds in parallel: a variable is not visible in its own `let`'s
 *    initializer forms.
 *  - `let*` binds sequentially: a variable is visible from the following clause
 *    onward.
 *  - `flet` local functions are not visible inside the `flet`'s own function
 *    bodies; `labels` local functions are (so recursion/mutual recursion work).
 *  - lambda-list parameters (`defun`, `defmacro`, `defmethod`, `lambda`, `flet`,
 *    `labels`, `macrolet`) are visible over the function body.
 *
 * It never evaluates anything.
 */
export function analyzeScopes(doc: Document): Scope {
  const root = new Scope(
    rangeFrom(doc, 0, doc.text.length),
    undefined,
  );
  for (const node of doc.roots) {
    walk(doc, node, root, false);
  }
  return root;
}

function rangeFrom(doc: Document, start: number, end: number): Range {
  const lo = Math.min(start, end);
  const hi = Math.max(start, end);
  return {
    start: doc.lineMap.positionAt(lo),
    end: doc.lineMap.positionAt(hi),
  };
}

/** Walks a node for nested binding forms. `data` tracks quoted contexts. */
function walk(
  doc: Document,
  node: SyntaxNode,
  scope: Scope,
  data: boolean,
): void {
  switch (node.kind) {
    case NodeKind.Atom:
    case NodeKind.String:
      return;
    case NodeKind.Prefixed: {
      if (!node.child) return;
      switch (node.prefix) {
        case "'":
        case "`":
          walk(doc, node.child, scope, true);
          break;
        case ",":
        case ",@":
          // Unquote re-enters evaluation inside quasiquoted data.
          walk(doc, node.child, scope, false);
          break;
        default:
          walk(doc, node.child, scope, data);
          break;
      }
      return;
    }
    case NodeKind.ReaderConditional:
      // The feature expression is inert; the guarded datum keeps its context.
      if (node.child) walk(doc, node.child, scope, data);
      return;
    case NodeKind.Discard:
      return;
    case NodeKind.List:
    case NodeKind.Vector:
      walkList(doc, node, scope, data);
      return;
  }
}

function headOperator(form: ListNode): string | undefined {
  const head = stripPrefixes(form.children[0]);
  if (!head || !isAtom(head)) return undefined;
  return parseQualifiedName(head.text).name;
}

function walkList(
  doc: Document,
  form: ListNode,
  scope: Scope,
  data: boolean,
): void {
  if (data) {
    // Literal data: no bindings, but unquoted subforms may re-enter code.
    for (const child of form.children) walk(doc, child, scope, true);
    return;
  }

  const op = headOperator(form);
  if (op === "QUOTE") {
    for (let i = 1; i < form.children.length; i++) {
      walk(doc, form.children[i], scope, true);
    }
    return;
  }

  if (op) {
    const binding = bindingFormKind(op);
    if (binding !== undefined) {
      analyzeBindingForm(doc, form, scope, binding);
      return;
    }
    if (isParameterizedDefiner(op)) {
      analyzeDefiner(doc, form, scope, op);
      return;
    }
  }

  // Ordinary form: descend into every child looking for nested binding forms.
  for (const child of form.children) walk(doc, child, scope, false);
}

function analyzeBindingForm(
  doc: Document,
  form: ListNode,
  parent: Scope,
  kind: BindingFormKind,
): void {
  switch (kind) {
    case BindingFormKind.Let:
      analyzeLet(doc, form, parent, false);
      return;
    case BindingFormKind.LetStar:
      analyzeLet(doc, form, parent, true);
      return;
    case BindingFormKind.Flet:
      analyzeFletLabels(doc, form, parent, false, LexicalBindingKind.LocalFunction);
      return;
    case BindingFormKind.Labels:
      analyzeFletLabels(doc, form, parent, true, LexicalBindingKind.LocalFunction);
      return;
    case BindingFormKind.Macrolet:
      analyzeFletLabels(doc, form, parent, false, LexicalBindingKind.LocalMacro);
      return;
    case BindingFormKind.SymbolMacrolet:
      analyzeSymbolMacrolet(doc, form, parent);
      return;
    case BindingFormKind.MultipleValueBind:
      analyzeMultipleValueBind(doc, form, parent);
      return;
    case BindingFormKind.DestructuringBind:
      analyzeDestructuringBind(doc, form, parent);
      return;
    case BindingFormKind.Lambda:
      analyzeLambda(doc, form, parent);
      return;
  }
}

/** The name token introduced by a `let`/`let*` binding clause. */
function letClauseVar(clause: SyntaxNode): SyntaxNode | undefined {
  const inner = stripPrefixes(clause);
  if (!inner) return undefined;
  if (isAtom(inner)) return inner;
  if (isList(inner)) return stripPrefixes(inner.children[0]);
  return undefined;
}

function makeBinding(
  doc: Document,
  nameNode: SyntaxNode,
  namespace: Namespace.Function | Namespace.Value,
  bindingKind: LexicalBindingKind,
  scopeRange: Range,
  lambdaList?: string,
): LexicalBinding {
  const name = isAtom(nameNode)
    ? parseQualifiedName(nameNode.text).name
    : "";
  return {
    name,
    namespace,
    bindingKind,
    uri: doc.uri,
    selectionRange: nameNode.range,
    scopeRange,
    lambdaList,
    id: lexicalBindingId(doc.uri, nameNode.range, namespace),
  };
}

function bodyStartOffset(form: ListNode, fromIndex: number): number {
  const body = form.children[fromIndex];
  if (body) return body.range.start.offset;
  return form.range.end.offset;
}

function analyzeLet(
  doc: Document,
  form: ListNode,
  parent: Scope,
  sequential: boolean,
): void {
  const bindings = stripPrefixes(form.children[1]);
  const scope = parent.newChild(form.range);
  const formEnd = form.range.end.offset;
  const bodyStart = bodyStartOffset(form, 2);

  if (bindings && isList(bindings)) {
    for (const clause of bindings.children) {
      const varNode = letClauseVar(clause);
      if (!varNode || !isAtom(varNode)) continue;
      const scopeRange = sequential
        ? rangeFrom(doc, clause.range.end.offset, formEnd)
        : rangeFrom(doc, bodyStart, formEnd);
      scope.addBinding(
        makeBinding(
          doc,
          varNode,
          Namespace.Value,
          LexicalBindingKind.LetVariable,
          scopeRange,
        ),
      );
    }
    // Walk initializer forms inside the scope; binding visibility is gated by
    // each binding's scopeRange, which encodes the let vs let* difference.
    for (const clause of bindings.children) {
      const inner = stripPrefixes(clause);
      if (inner && isList(inner)) {
        for (let i = 1; i < inner.children.length; i++) {
          walk(doc, inner.children[i], scope, false);
        }
      }
    }
  }

  for (let i = 2; i < form.children.length; i++) {
    walk(doc, form.children[i], scope, false);
  }
}

function analyzeFletLabels(
  doc: Document,
  form: ListNode,
  parent: Scope,
  recursive: boolean,
  bindingKind: LexicalBindingKind,
): void {
  const bindings = stripPrefixes(form.children[1]);
  const scope = parent.newChild(form.range);
  const formEnd = form.range.end.offset;
  const bodyStart = bodyStartOffset(form, 2);
  const definer = bindingKind === LexicalBindingKind.LocalMacro ? "MACROLET" : "FLET";

  if (bindings && isList(bindings)) {
    const bindingsStart = bindings.range.start.offset;
    for (const clause of bindings.children) {
      const inner = stripPrefixes(clause);
      if (!inner || !isList(inner)) continue;
      const nameNode = stripPrefixes(inner.children[0]);
      if (!nameNode || !isAtom(nameNode)) continue;
      const lambdaListNode = stripPrefixes(inner.children[1]);
      const lambdaList =
        lambdaListNode && isList(lambdaListNode)
          ? doc.text.slice(
              lambdaListNode.range.start.offset,
              lambdaListNode.range.end.offset,
            )
          : undefined;
      // labels: functions see each other (recursion); flet: body only.
      const fnScopeRange = recursive
        ? rangeFrom(doc, bindingsStart, formEnd)
        : rangeFrom(doc, bodyStart, formEnd);
      scope.addBinding(
        makeBinding(
          doc,
          nameNode,
          Namespace.Function,
          bindingKind,
          fnScopeRange,
          lambdaList,
        ),
      );
      // Each local function/macro gets its own parameter scope over its body.
      analyzeLocalFunctionBody(doc, inner, scope, definer === "MACROLET");
    }
  }

  for (let i = 2; i < form.children.length; i++) {
    walk(doc, form.children[i], scope, false);
  }
}

/** Parameter scope + body for one `flet`/`labels`/`macrolet` clause. */
function analyzeLocalFunctionBody(
  doc: Document,
  clause: ListNode,
  parent: Scope,
  macro: boolean,
): void {
  const lambdaListNode = stripPrefixes(clause.children[1]);
  const fnScope = parent.newChild(clause.range);
  const clauseEnd = clause.range.end.offset;
  if (lambdaListNode && isList(lambdaListNode)) {
    const vars = collectVariables(lambdaListNode, [], { destructuring: macro });
    const scopeRange = rangeFrom(doc, lambdaListNode.range.start.offset, clauseEnd);
    for (const v of vars) {
      fnScope.addBinding(
        makeBinding(
          doc,
          v.node,
          Namespace.Value,
          LexicalBindingKind.Parameter,
          scopeRange,
        ),
      );
    }
  }
  for (let i = 2; i < clause.children.length; i++) {
    walk(doc, clause.children[i], fnScope, false);
  }
  // Walk default-value forms in the lambda list for nested binding forms.
  if (lambdaListNode && isList(lambdaListNode)) {
    walkLambdaListDefaults(doc, lambdaListNode, fnScope);
  }
}

function analyzeLambda(doc: Document, form: ListNode, parent: Scope): void {
  const lambdaListNode = stripPrefixes(form.children[1]);
  const scope = parent.newChild(form.range);
  const formEnd = form.range.end.offset;
  if (lambdaListNode && isList(lambdaListNode)) {
    const vars = collectVariables(lambdaListNode, [], { destructuring: false });
    const scopeRange = rangeFrom(doc, lambdaListNode.range.start.offset, formEnd);
    for (const v of vars) {
      scope.addBinding(
        makeBinding(
          doc,
          v.node,
          Namespace.Value,
          LexicalBindingKind.Parameter,
          scopeRange,
        ),
      );
    }
    walkLambdaListDefaults(doc, lambdaListNode, scope);
  }
  for (let i = 2; i < form.children.length; i++) {
    walk(doc, form.children[i], scope, false);
  }
}

function analyzeDefiner(
  doc: Document,
  form: ListNode,
  parent: Scope,
  op: string,
): void {
  const lambdaListNode = firstListFrom(form, 2);
  const scope = parent.newChild(form.range);
  const formEnd = form.range.end.offset;
  const destructuring = op === "DEFMACRO" || op === "DEFINE-COMPILER-MACRO";
  if (lambdaListNode) {
    const vars = collectVariables(lambdaListNode, [], { destructuring });
    const scopeRange = rangeFrom(doc, lambdaListNode.range.start.offset, formEnd);
    for (const v of vars) {
      scope.addBinding(
        makeBinding(
          doc,
          v.node,
          Namespace.Value,
          LexicalBindingKind.Parameter,
          scopeRange,
        ),
      );
    }
    walkLambdaListDefaults(doc, lambdaListNode, scope);
  }
  // Walk the body (forms after the lambda list) for nested binding forms.
  const startIndex = lambdaListNode
    ? form.children.indexOf(lambdaListNode) + 1
    : 2;
  for (let i = startIndex; i < form.children.length; i++) {
    walk(doc, form.children[i], scope, false);
  }
}

function analyzeSymbolMacrolet(
  doc: Document,
  form: ListNode,
  parent: Scope,
): void {
  const bindings = stripPrefixes(form.children[1]);
  const scope = parent.newChild(form.range);
  const formEnd = form.range.end.offset;
  const bodyStart = bodyStartOffset(form, 2);
  if (bindings && isList(bindings)) {
    for (const clause of bindings.children) {
      const inner = stripPrefixes(clause);
      if (!inner || !isList(inner)) continue;
      const nameNode = stripPrefixes(inner.children[0]);
      if (!nameNode || !isAtom(nameNode)) continue;
      scope.addBinding(
        makeBinding(
          doc,
          nameNode,
          Namespace.Value,
          LexicalBindingKind.SymbolMacro,
          rangeFrom(doc, bodyStart, formEnd),
        ),
      );
    }
  }
  for (let i = 2; i < form.children.length; i++) {
    walk(doc, form.children[i], scope, false);
  }
}

function analyzeMultipleValueBind(
  doc: Document,
  form: ListNode,
  parent: Scope,
): void {
  const varsNode = stripPrefixes(form.children[1]);
  const scope = parent.newChild(form.range);
  const formEnd = form.range.end.offset;
  const bodyStart = bodyStartOffset(form, 3);
  if (varsNode && isList(varsNode)) {
    for (const varNode of varsNode.children) {
      const inner = stripPrefixes(varNode);
      if (!inner || !isAtom(inner)) continue;
      scope.addBinding(
        makeBinding(
          doc,
          inner,
          Namespace.Value,
          LexicalBindingKind.MultipleValue,
          rangeFrom(doc, bodyStart, formEnd),
        ),
      );
    }
  }
  // The values form (children[2]) is evaluated in the parent environment; walk
  // it (and the body) inside the scope — the new vars' scopeRange excludes it.
  for (let i = 2; i < form.children.length; i++) {
    walk(doc, form.children[i], scope, false);
  }
}

function analyzeDestructuringBind(
  doc: Document,
  form: ListNode,
  parent: Scope,
): void {
  const lambdaListNode = stripPrefixes(form.children[1]);
  const scope = parent.newChild(form.range);
  const formEnd = form.range.end.offset;
  const bodyStart = bodyStartOffset(form, 3);
  if (lambdaListNode && isList(lambdaListNode)) {
    const vars = collectVariables(lambdaListNode, [], { destructuring: true });
    for (const v of vars) {
      scope.addBinding(
        makeBinding(
          doc,
          v.node,
          Namespace.Value,
          LexicalBindingKind.Destructuring,
          rangeFrom(doc, bodyStart, formEnd),
        ),
      );
    }
  }
  for (let i = 2; i < form.children.length; i++) {
    walk(doc, form.children[i], scope, false);
  }
}

/** Walks the default-value forms of a lambda list for nested binding forms. */
function walkLambdaListDefaults(
  doc: Document,
  lambdaList: ListNode,
  scope: Scope,
): void {
  for (const child of lambdaList.children) {
    const inner = stripPrefixes(child);
    if (inner && isList(inner)) {
      // `(var default [supplied-p])` — walk everything after the var.
      for (let i = 1; i < inner.children.length; i++) {
        walk(doc, inner.children[i], scope, false);
      }
    }
  }
}

/** Finds the first list child at or after `fromIndex` (the lambda list). */
function firstListFrom(form: ListNode, fromIndex: number): ListNode | undefined {
  for (let i = fromIndex; i < form.children.length; i++) {
    const node = stripPrefixes(form.children[i]);
    if (node && isList(node)) return node as ListNode;
  }
  return undefined;
}
