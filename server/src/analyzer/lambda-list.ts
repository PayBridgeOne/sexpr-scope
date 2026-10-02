import {
  AtomNode,
  ListNode,
  SyntaxNode,
  isAtom,
  isList,
  stripPrefixes,
} from "../parser/reader";
import { parseQualifiedName } from "../model/symbol";
import { isLambdaListKeyword } from "../model/language";

/**
 * Static extraction of the *binding variables* introduced by a lambda list.
 *
 * This is deliberately a static binding analysis, not a full executable
 * lambda-list implementation. The goal is to locate the name tokens a lambda
 * list binds — with precise source ranges — so the scope model can make
 * Go-to-Definition and Find References correct. Default-value and specializer
 * forms are *not* variables and are left for the ordinary reference pass to
 * analyze.
 *
 * Supported: required parameters, `&optional`, `&rest`, `&body`, `&key`,
 * `&aux`, `&allow-other-keys`, `&whole`, `&environment`, supplied-p variables,
 * `((:keyword var) …)` key spellings, and (for macro/`destructuring-bind`
 * lambda lists) nested destructuring patterns.
 */

/** A single variable a lambda list introduces, with its name token. */
export interface LambdaListVariable {
  readonly node: AtomNode;
  readonly name: string;
  /**
   * Source offset at which this variable's binding becomes *visible*.
   *
   * Common Lisp lambda-list initialization is ordered (CLHS 3.4.1): each
   * parameter is bound sequentially, left to right, so an init/default form may
   * reference parameters to its left but never itself or ones to its right. The
   * scope therefore begins at the end of the parameter specifier that binds the
   * variable (a `&whole`/`&environment` variable is visible from the start of
   * the lambda list). The scope *end* is supplied by the caller (the enclosing
   * form). When omitted, the binding is treated as visible from the whole
   * lambda list (the legacy, non-ordered behavior).
   */
  readonly scopeStart?: number;
}

type Section =
  | "required"
  | "optional"
  | "rest"
  | "key"
  | "aux"
  | "whole"
  | "environment";

export interface ExtractOptions {
  /**
   * When true (macro / `destructuring-bind` lambda lists), nested lists in the
   * required and `&rest` positions are destructuring patterns whose contents
   * are all variables. When false (ordinary / method lambda lists), a required
   * list is `(var specializer)` and only its first element is a variable.
   */
  readonly destructuring: boolean;
}

function isVarAtom(node: SyntaxNode | undefined): node is AtomNode {
  if (!node || !isAtom(node)) return false;
  const q = parseQualifiedName(node.text);
  // Lambda-list keywords, NIL and T are never binding variables.
  if (isLambdaListKeyword(q.name)) return false;
  if (q.name === "NIL" || q.name === "T") return false;
  // Keywords (`:foo`) are not variables.
  if (q.qualification === "keyword") return false;
  return true;
}

function pushVar(
  out: LambdaListVariable[],
  node: SyntaxNode | undefined,
  scopeStart?: number,
): void {
  const inner = stripPrefixes(node);
  if (isVarAtom(inner)) {
    out.push({ node: inner, name: parseQualifiedName(inner.text).name, scopeStart });
  }
}

/**
 * Extracts the first element of a parameter spec as a variable, recursing into
 * nested destructuring patterns when requested.
 */
function extractPatternHead(
  node: SyntaxNode | undefined,
  out: LambdaListVariable[],
  options: ExtractOptions,
  scopeStart?: number,
): void {
  const inner = stripPrefixes(node);
  if (!inner) return;
  if (isAtom(inner)) {
    pushVar(out, inner, scopeStart);
    return;
  }
  if (isList(inner) && options.destructuring) {
    // A nested destructuring pattern: every variable inside it is bound. They
    // all become visible once the whole pattern has been destructured.
    collectVariables(inner, out, options, scopeStart);
  }
}

/** Collects the variables from one `&key` parameter spec. */
function extractKeyVar(
  spec: SyntaxNode | undefined,
  out: LambdaListVariable[],
  scopeStart?: number,
): void {
  const inner = stripPrefixes(spec);
  if (!inner) return;
  if (isAtom(inner)) {
    pushVar(out, inner, scopeStart);
    return;
  }
  if (isList(inner)) {
    const first = stripPrefixes(inner.children[0]);
    if (first && isList(first)) {
      // `((:keyword var) default supplied-p)` — var is the 2nd of the pair.
      pushVar(out, first.children[1], scopeStart);
    } else {
      // `(var default supplied-p)`.
      pushVar(out, inner.children[0], scopeStart);
    }
    // supplied-p variable (3rd element), if present.
    if (inner.children.length >= 3) pushVar(out, inner.children[2], scopeStart);
  }
}

/** Collects the variables from one `&optional` parameter spec. */
function extractOptionalVar(
  spec: SyntaxNode | undefined,
  out: LambdaListVariable[],
  options: ExtractOptions,
  scopeStart?: number,
): void {
  const inner = stripPrefixes(spec);
  if (!inner) return;
  if (isAtom(inner)) {
    pushVar(out, inner, scopeStart);
    return;
  }
  if (isList(inner)) {
    // `(var default supplied-p)` — var may itself be a destructuring pattern.
    extractPatternHead(inner.children[0], out, options, scopeStart);
    if (inner.children.length >= 3) pushVar(out, inner.children[2], scopeStart);
  }
}

/** Collects the variables from one `&aux` parameter spec. */
function extractAuxVar(
  spec: SyntaxNode | undefined,
  out: LambdaListVariable[],
  scopeStart?: number,
): void {
  const inner = stripPrefixes(spec);
  if (!inner) return;
  if (isAtom(inner)) {
    pushVar(out, inner, scopeStart);
    return;
  }
  if (isList(inner)) {
    // `(var init)` — only var binds.
    pushVar(out, inner.children[0], scopeStart);
  }
}

/** Collects every variable a lambda list introduces. */
export function collectVariables(
  lambdaList: ListNode,
  out: LambdaListVariable[] = [],
  options: ExtractOptions = { destructuring: false },
  /**
   * When provided, overrides the computed per-variable scope start. Used when a
   * nested destructuring pattern inherits its enclosing clause's scope start.
   */
  inheritedScopeStart?: number,
): LambdaListVariable[] {
  let section: Section = "required";
  const llStart = lambdaList.range.start.offset;
  for (const raw of lambdaList.children) {
    const node = stripPrefixes(raw);
    if (!node) continue;
    if (isAtom(node)) {
      const name = parseQualifiedName(node.text).name;
      if (isLambdaListKeyword(name)) {
        switch (name) {
          case "&OPTIONAL":
            section = "optional";
            break;
          case "&REST":
          case "&BODY":
            section = "rest";
            break;
          case "&KEY":
            section = "key";
            break;
          case "&AUX":
            section = "aux";
            break;
          case "&WHOLE":
            section = "whole";
            break;
          case "&ENVIRONMENT":
            section = "environment";
            break;
          case "&ALLOW-OTHER-KEYS":
            // No variables; stay in the key section.
            break;
        }
        continue;
      }
    }

    // A parameter's binding becomes visible at the end of its own specifier, so
    // init/default forms see only parameters to their left (ordered binding).
    // `&whole`/`&environment` variables are visible from the lambda-list start.
    const clauseScopeStart =
      inheritedScopeStart ??
      (section === "whole" || section === "environment"
        ? llStart
        : raw.range.end.offset);

    switch (section) {
      case "optional":
        extractOptionalVar(node, out, options, clauseScopeStart);
        break;
      case "key":
        extractKeyVar(node, out, clauseScopeStart);
        break;
      case "aux":
        extractAuxVar(node, out, clauseScopeStart);
        break;
      case "rest":
        // A single rest/body variable; a following lambda-list keyword switches
        // the section back out of `rest`.
        extractPatternHead(node, out, options, clauseScopeStart);
        break;
      case "whole":
      case "environment":
        // A single variable, then resume the ordinary required section.
        extractPatternHead(node, out, options, clauseScopeStart);
        section = "required";
        break;
      case "required":
      default:
        extractPatternHead(node, out, options, clauseScopeStart);
        break;
    }
  }
  return out;
}
