import { Range } from "../parser/position";

/** The kinds of definitions the static model recognizes. */
export enum SymbolKind {
  Function = "function",
  Macro = "macro",
  GenericFunction = "generic-function",
  Method = "method",
  Class = "class",
  Struct = "struct",
  Variable = "variable",
  Parameter = "parameter",
  Constant = "constant",
  Type = "type",
  Package = "package",
  Condition = "condition",
}

/** Where a piece of semantic information came from. */
export enum SymbolOrigin {
  Static = "static",
  Runtime = "runtime",
}

/**
 * A definition discovered by the static indexer.
 *
 * Names are stored unqualified; the owning package is tracked separately so
 * that symbols with the same print name in different packages never collide.
 */
export interface SymbolDefinition {
  readonly name: string;
  /** Upper-cased package name that owns this symbol (CL default readtable). */
  readonly package: string;
  readonly kind: SymbolKind;
  readonly uri: string;
  /** Range of the whole defining form. */
  readonly range: Range;
  /** Range of the name token (used as the Go-to-Definition target). */
  readonly selectionRange: Range;
  readonly documentation?: string;
  /** Raw source of the lambda list, when applicable. */
  readonly lambdaList?: string;
  /** True when the package's defpackage exports this symbol. */
  readonly exported?: boolean;
  readonly origin: SymbolOrigin;
}

/** A parsed package model derived from a `defpackage` form. */
export interface PackageDefinition {
  readonly name: string;
  readonly nicknames: string[];
  readonly uses: string[];
  readonly exports: string[];
  readonly uri: string;
  readonly range: Range;
  readonly selectionRange: Range;
  readonly documentation?: string;
}

/**
 * How a symbol reference spells its package qualification.
 *  - keyword:   leading colon, e.g. `:foo`
 *  - external:  `pkg:foo`
 *  - internal:  `pkg::foo`
 *  - none:      bare `foo`, resolved against the current package
 */
export type QualificationKind = "none" | "keyword" | "external" | "internal";

export interface QualifiedName {
  readonly packagePrefix?: string;
  readonly name: string;
  readonly qualification: QualificationKind;
}

/** Common Lisp upcases unescaped symbol text under the standard readtable. */
export function canonicalizeName(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === "\\" && i + 1 < raw.length) {
      out += raw[i + 1];
      i++;
    } else if (c === "|") {
      i++;
      while (i < raw.length && raw[i] !== "|") {
        if (raw[i] === "\\") i++;
        out += raw[i];
        i++;
      }
    } else {
      out += c.toUpperCase();
    }
  }
  return out;
}

/**
 * Parses a possibly package-qualified symbol token.
 *
 * Handles `foo`, `pkg:foo`, `pkg::foo`, `:keyword`, and `#:uninterned`.
 * Escaped colons (inside `|...|` or after `\`) are preserved as part of names.
 */
export function parseQualifiedName(token: string): QualifiedName {
  let text = token;
  // Drop an uninterned-symbol marker.
  if (text.startsWith("#:")) {
    return { name: canonicalizeName(text.slice(2)), qualification: "none" };
  }

  // Locate the first unescaped colon run, respecting |...| escapes.
  let colonStart = -1;
  let colonEnd = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "|") {
      i++;
      while (i < text.length && text[i] !== "|") {
        if (text[i] === "\\") i++;
        i++;
      }
      continue;
    }
    if (c === ":") {
      colonStart = i;
      let j = i;
      while (j < text.length && text[j] === ":") j++;
      colonEnd = j;
      break;
    }
  }

  if (colonStart === -1) {
    return { name: canonicalizeName(text), qualification: "none" };
  }

  const colonCount = colonEnd - colonStart;
  const prefix = text.slice(0, colonStart);
  const rest = text.slice(colonEnd);

  // Leading colon → keyword symbol in the KEYWORD package.
  if (prefix.length === 0) {
    return {
      packagePrefix: "KEYWORD",
      name: canonicalizeName(rest),
      qualification: "keyword",
    };
  }

  return {
    packagePrefix: canonicalizeName(prefix),
    name: canonicalizeName(rest),
    qualification: colonCount >= 2 ? "internal" : "external",
  };
}
