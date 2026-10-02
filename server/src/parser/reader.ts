import { LineMap } from "./line-map";
import { Range, rangeContainsOffset } from "./position";
import { Token, TokenType, tokenize } from "./tokenizer";

/**
 * A node in the safe, non-evaluating syntax tree.
 *
 * The tree mirrors the s-expression structure of the source. It deliberately
 * carries no evaluated meaning — a `#.` form is represented as a `Prefixed`
 * node wrapping an inert datum, exactly like a quote.
 */
export type SyntaxNode = ListNode | AtomNode | StringNode | PrefixedNode;

export enum NodeKind {
  List = "list",
  Vector = "vector",
  Atom = "atom",
  String = "string",
  Prefixed = "prefixed",
}

export interface BaseNode {
  readonly kind: NodeKind;
  readonly range: Range;
}

export interface ListNode extends BaseNode {
  readonly kind: NodeKind.List | NodeKind.Vector;
  readonly children: SyntaxNode[];
  /** True when the closing paren was missing (tolerated for partial files). */
  readonly unclosed: boolean;
}

export interface AtomNode extends BaseNode {
  readonly kind: NodeKind.Atom;
  readonly text: string;
}

export interface StringNode extends BaseNode {
  readonly kind: NodeKind.String;
  /** Raw text including the surrounding quotes. */
  readonly text: string;
  /** The string contents with surrounding quotes and escapes resolved. */
  readonly value: string;
}

export interface PrefixedNode extends BaseNode {
  readonly kind: NodeKind.Prefixed;
  readonly prefix: string;
  readonly child: SyntaxNode | undefined;
}

export interface Document {
  readonly uri: string;
  readonly text: string;
  readonly lineMap: LineMap;
  readonly roots: SyntaxNode[];
}

function decodeString(raw: string): string {
  // Strip surrounding quotes if present, then resolve backslash escapes.
  let body = raw;
  if (body.startsWith('"')) body = body.slice(1);
  if (body.endsWith('"') && body.length > 0) body = body.slice(0, -1);
  let out = "";
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "\\" && i + 1 < body.length) {
      out += body[i + 1];
      i++;
    } else {
      out += body[i];
    }
  }
  return out;
}

class Reader {
  private pos = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly lineMap: LineMap,
    private readonly textLength: number,
  ) {}

  parseAll(): SyntaxNode[] {
    const roots: SyntaxNode[] = [];
    while (this.pos < this.tokens.length) {
      const node = this.parseDatum();
      if (node) roots.push(node);
    }
    return roots;
  }

  private range(start: number, end: number): Range {
    return {
      start: this.lineMap.positionAt(start),
      end: this.lineMap.positionAt(end),
    };
  }

  /** Reads one datum, skipping comments. Returns undefined at EOF / stray `)`. */
  private parseDatum(): SyntaxNode | undefined {
    while (this.pos < this.tokens.length) {
      const tok = this.tokens[this.pos];
      switch (tok.type) {
        case TokenType.LineComment:
        case TokenType.BlockComment:
          this.pos++;
          continue;
        case TokenType.RParen:
          // Unbalanced close paren: consume and ignore so we stay tolerant.
          this.pos++;
          continue;
        case TokenType.LParen:
          return this.parseList(tok, TokenType.LParen, NodeKind.List);
        case TokenType.VectorOpen:
          return this.parseList(tok, TokenType.VectorOpen, NodeKind.Vector);
        case TokenType.String:
          this.pos++;
          return {
            kind: NodeKind.String,
            range: this.range(tok.start, tok.end),
            text: tok.text,
            value: decodeString(tok.text),
          };
        case TokenType.Prefix:
          return this.parsePrefixed(tok);
        case TokenType.Atom:
          this.pos++;
          return {
            kind: NodeKind.Atom,
            range: this.range(tok.start, tok.end),
            text: tok.text,
          };
        default:
          this.pos++;
          continue;
      }
    }
    return undefined;
  }

  private parsePrefixed(tok: Token): PrefixedNode {
    this.pos++;
    const child = this.parseDatum();
    const end = child ? child.range.end.offset : tok.end;
    return {
      kind: NodeKind.Prefixed,
      range: this.range(tok.start, end),
      prefix: tok.prefix ?? tok.text,
      child,
    };
  }

  private parseList(open: Token, _openType: TokenType, kind: NodeKind.List | NodeKind.Vector): ListNode {
    this.pos++; // consume opener
    const children: SyntaxNode[] = [];
    let unclosed = true;
    let end = open.end;
    while (this.pos < this.tokens.length) {
      const tok = this.tokens[this.pos];
      if (tok.type === TokenType.RParen) {
        end = tok.end;
        this.pos++;
        unclosed = false;
        break;
      }
      if (tok.type === TokenType.LineComment || tok.type === TokenType.BlockComment) {
        this.pos++;
        continue;
      }
      const child = this.parseDatum();
      if (!child) break;
      children.push(child);
      end = child.range.end.offset;
    }
    if (unclosed) {
      // Extend an unterminated list to end of file so it still has a range.
      end = children.length ? children[children.length - 1].range.end.offset : open.end;
      if (this.pos >= this.tokens.length) end = Math.max(end, this.textLength);
    }
    return {
      kind,
      range: this.range(open.start, end),
      children,
      unclosed,
    };
  }
}

/** Parses source text into a tolerant syntax tree. Never throws, never evaluates. */
export function parseDocument(uri: string, text: string): Document {
  const lineMap = new LineMap(text);
  const tokens = tokenize(text);
  const roots = new Reader(tokens, lineMap, text.length).parseAll();
  return { uri, text, lineMap, roots };
}

export function isList(node: SyntaxNode | undefined): node is ListNode {
  return !!node && (node.kind === NodeKind.List || node.kind === NodeKind.Vector);
}

export function isAtom(node: SyntaxNode | undefined): node is AtomNode {
  return !!node && node.kind === NodeKind.Atom;
}

/** Unwraps reader prefixes (quote, `#'`, `#.`, …) to reach the inner datum. */
export function stripPrefixes(node: SyntaxNode | undefined): SyntaxNode | undefined {
  let current = node;
  while (current && current.kind === NodeKind.Prefixed) {
    current = current.child;
  }
  return current;
}

/** Finds the innermost atom node whose range contains `offset`, if any. */
export function atomAtOffset(doc: Document, offset: number): AtomNode | undefined {
  let found: AtomNode | undefined;
  const visit = (node: SyntaxNode) => {
    if (!rangeContainsOffset(node.range, offset) && node.range.end.offset !== offset) {
      // Allow the end position to match for cursor-at-end-of-symbol hovers.
      if (!(offset >= node.range.start.offset && offset <= node.range.end.offset)) {
        return;
      }
    }
    if (node.kind === NodeKind.Atom) {
      found = node;
      return;
    }
    if (node.kind === NodeKind.Prefixed) {
      if (node.child) visit(node.child);
      return;
    }
    if (isList(node)) {
      for (const child of node.children) visit(child);
    }
  };
  for (const root of doc.roots) visit(root);
  return found;
}

export { tokenize };
