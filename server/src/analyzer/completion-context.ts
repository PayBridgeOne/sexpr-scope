import { Document } from "../parser/reader";
import { Range } from "../parser/position";
import { Namespace, canonicalizeName } from "../model/symbol";
import { ReferenceContext, referenceOccurrenceAt } from "../model/reference";
import { findEnclosingList } from "./form-context";

/**
 * The static context in which a completion was requested.
 *
 * It captures everything the candidate gatherer needs — the partial print name,
 * any package qualifier, the Lisp-2 namespace implied by the cursor position,
 * and the source range the completion should replace — without the gatherer
 * having to re-parse the surrounding form.
 */
export interface CompletionContext {
  /** Upper-cased symbol-name prefix typed so far (may be empty). */
  readonly prefix: string;
  /** Present when the token is package-qualified (`pkg:` / `pkg::`). */
  readonly packagePrefix?: string;
  /** `external` = single colon (exported only); `internal` = double colon. */
  readonly qualification: "none" | "external" | "internal";
  /** The Lisp-2 namespace implied by the cursor position. */
  readonly namespace: Namespace.Function | Namespace.Value;
  /** Source range the completion should replace (the symbol-name part). */
  readonly replaceRange: Range;
}

/** Symbol-token constituents stop at whitespace and these reader delimiters. */
const DELIMITER = /[\s()[\]{}"'`,;]/;

/** Scans backwards from `offset` over the symbol token being typed. */
function tokenStartOffset(text: string, offset: number): number {
  let i = offset;
  while (i > 0 && !DELIMITER.test(text[i - 1])) i--;
  return i;
}

/** True when `offset` sits inside a string literal's content. */
function insideString(doc: Document, offset: number): boolean {
  for (const node of iterNodes(doc)) {
    if (
      node.kind === "string" &&
      offset > node.range.start.offset &&
      offset < node.range.end.offset
    ) {
      return true;
    }
  }
  return false;
}

function* iterNodes(doc: Document): Generator<import("../parser/reader").SyntaxNode> {
  const stack = [...doc.roots];
  while (stack.length) {
    const node = stack.pop()!;
    yield node;
    if (node.kind === "list" || node.kind === "vector") stack.push(...node.children);
    else if (node.kind === "prefixed" && node.child) stack.push(node.child);
    else if (node.kind === "reader-conditional") {
      if (node.feature) stack.push(node.feature);
      if (node.child) stack.push(node.child);
    } else if (node.kind === "discard" && node.child) stack.push(node.child);
  }
}

/** True when a line comment (`;`) begins before `offset` on the same line. */
function insideLineComment(text: string, offset: number): boolean {
  let lineStart = offset;
  while (lineStart > 0 && text[lineStart - 1] !== "\n") lineStart--;
  let inString = false;
  for (let i = lineStart; i < offset; i++) {
    const c = text[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === '"') inString = !inString;
    else if (c === ";" && !inString) return true;
  }
  return false;
}

/** Splits a (possibly qualified) raw token into its package and symbol parts. */
function splitQualifier(raw: string): {
  packagePrefix?: string;
  symbolStart: number;
  qualification: "none" | "external" | "internal" | "keyword";
} {
  // Find the first unescaped colon run (ignoring |…| escapes, as the reader does).
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "|") {
      i++;
      while (i < raw.length && raw[i] !== "|") i++;
      continue;
    }
    if (c === ":") {
      let j = i;
      while (j < raw.length && raw[j] === ":") j++;
      const prefix = raw.slice(0, i);
      if (prefix.length === 0) return { symbolStart: j, qualification: "keyword" };
      return {
        packagePrefix: canonicalizeName(prefix),
        symbolStart: j,
        qualification: j - i >= 2 ? "internal" : "external",
      };
    }
  }
  return { symbolStart: 0, qualification: "none" };
}

/**
 * Computes the completion context at a source offset, or `undefined` when
 * completion should be suppressed (inside a string, a comment, quoted data, or
 * after a keyword/uninterned marker where symbol completion is meaningless).
 */
export function completionContextAt(
  doc: Document,
  offset: number,
): CompletionContext | undefined {
  const text = doc.text;
  if (insideString(doc, offset) || insideLineComment(text, offset)) return undefined;

  const start = tokenStartOffset(text, offset);
  const raw = text.slice(start, offset);

  if (raw.length > 0) {
    // A partial token exists: reuse the reference classifier for its Lisp-2
    // context (function / value / data) and package qualification.
    const occ = referenceOccurrenceAt(doc, start);
    if (occ && occ.reference.context === ReferenceContext.Data) return undefined;

    const split = splitQualifier(raw);
    if (split.qualification === "keyword") return undefined;
    // `#:foo` uninterned marker — the `#` is a delimiter, so `raw` is `:foo`?
    // No: `#` stops the scan, leaving `raw` without it; uninterned completion is
    // not meaningful, and such tokens classify as data/keyword above.

    const namespace =
      occ && occ.reference.context === ReferenceContext.Function
        ? Namespace.Function
        : Namespace.Value;

    const symbolStart = start + split.symbolStart;
    return {
      prefix: canonicalizeName(text.slice(symbolStart, offset)),
      packagePrefix: split.packagePrefix,
      qualification: split.qualification,
      namespace,
      replaceRange: rangeBetween(doc, symbolStart, offset),
    };
  }

  // Empty prefix: derive the namespace from the enclosing form. A new element in
  // operator position is a function; elsewhere it is a value. Data lists suppress.
  const enclosing = findEnclosingList(doc, offset);
  if (!enclosing) {
    // Top level: offer value-namespace completions (e.g. a bare symbol).
    return {
      prefix: "",
      qualification: "none",
      namespace: Namespace.Value,
      replaceRange: rangeBetween(doc, offset, offset),
    };
  }
  if (enclosing.data) return undefined;
  const childrenBefore = enclosing.list.children.filter(
    (c) => c.range.start.offset < offset,
  ).length;
  const namespace = childrenBefore === 0 ? Namespace.Function : Namespace.Value;
  return {
    prefix: "",
    qualification: "none",
    namespace,
    replaceRange: rangeBetween(doc, offset, offset),
  };
}

function rangeBetween(doc: Document, start: number, end: number): Range {
  return {
    start: doc.lineMap.positionAt(start),
    end: doc.lineMap.positionAt(end),
  };
}
