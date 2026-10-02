import { AtomNode } from "../parser/reader";
import { Range } from "../parser/position";
import { Namespace, QualifiedName, SymbolKind } from "../model/symbol";
import { LexicalBindingKind } from "../model/scope";
import { OccurrenceRole, SemanticOccurrence } from "../model/resolution";
import { isSpecialOperator, isLambdaListKeyword } from "../model/language";

/**
 * The semantic-token legend. Order is significant: the index of each entry is
 * the integer the LSP wire protocol uses. Both the server capability
 * registration and the token encoder consume these arrays, so they are the one
 * source of truth for the legend.
 */
export const TOKEN_TYPES = [
  "namespace",
  "class",
  "struct",
  "type",
  "parameter",
  "variable",
  "function",
  "method",
  "macro",
  "keyword",
  "enumMember",
] as const;

export const TOKEN_MODIFIERS = [
  "declaration",
  "definition",
  "readonly",
  "defaultLibrary",
  "local",
  "special",
  "generic",
] as const;

export type TokenType = (typeof TOKEN_TYPES)[number];
export type TokenModifier = (typeof TOKEN_MODIFIERS)[number];

const TYPE_INDEX = new Map(TOKEN_TYPES.map((t, i) => [t, i]));
const MODIFIER_BIT = new Map(TOKEN_MODIFIERS.map((m, i) => [m, 1 << i]));

/** A classified token: a source range plus its semantic type and modifiers. */
export interface SemanticTokenInfo {
  readonly range: Range;
  readonly type: TokenType;
  readonly modifiers: TokenModifier[];
}

/** The index of a token type in the legend. */
export function tokenTypeIndex(type: TokenType): number {
  return TYPE_INDEX.get(type) ?? 0;
}

/** The bit-set encoding a list of token modifiers. */
export function tokenModifierBits(modifiers: readonly TokenModifier[]): number {
  let bits = 0;
  for (const m of modifiers) bits |= MODIFIER_BIT.get(m) ?? 0;
  return bits;
}

/**
 * Encodes classified tokens into the LSP semantic-tokens wire format: a flat
 * array of 5-tuples `(deltaLine, deltaStartChar, length, typeIndex, modBits)`,
 * each position relative to the previous token. Tokens must already be sorted
 * in source order. Atoms never span lines, so `length` is taken on one line.
 */
export function encodeSemanticTokens(tokens: readonly SemanticTokenInfo[]): number[] {
  const data: number[] = [];
  let prevLine = 0;
  let prevChar = 0;
  for (const token of tokens) {
    const line = token.range.start.line;
    const char = token.range.start.character;
    const length = token.range.end.character - token.range.start.character;
    if (length <= 0) continue;
    const deltaLine = line - prevLine;
    const deltaChar = deltaLine === 0 ? char - prevChar : char;
    data.push(
      deltaLine,
      deltaChar,
      length,
      tokenTypeIndex(token.type),
      tokenModifierBits(token.modifiers),
    );
    prevLine = line;
    prevChar = char;
  }
  return data;
}

/**
 * Classifies one resolved occurrence into a semantic-token type + modifiers, or
 * `undefined` when it should not be tokenized (quoted data, numbers, lambda-list
 * keywords, …).
 *
 * This consumes the *same* `SemanticOccurrence` the unified resolver produces
 * for Go-to-Definition and Find References, so highlighting always agrees with
 * navigation. It uses the central language-knowledge module (never regexes) to
 * recognise special operators and keyword symbols.
 */
export function classifyToken(
  occ: SemanticOccurrence,
  ref: QualifiedName,
): { type: TokenType; modifiers: TokenModifier[] } | undefined {
  const isDecl = occ.role === OccurrenceRole.Definition;
  const target = occ.target;

  if (target.kind === "lexical") {
    const mods: TokenModifier[] = ["local"];
    if (isDecl) mods.push("definition", "declaration");
    const kind = target.binding.bindingKind;
    switch (kind) {
      case LexicalBindingKind.Parameter:
        return { type: "parameter", modifiers: mods };
      case LexicalBindingKind.LocalFunction:
        return { type: "function", modifiers: mods };
      case LexicalBindingKind.LocalMacro:
        return { type: "macro", modifiers: mods };
      case LexicalBindingKind.SymbolMacro:
        return { type: "macro", modifiers: mods };
      default:
        // let / let* / multiple-value-bind / destructuring-bind variables.
        return { type: "variable", modifiers: mods };
    }
  }

  if (target.kind === "global") {
    const mods: TokenModifier[] = [];
    if (isDecl) mods.push("definition", "declaration");
    const sym = target.symbols[0];
    switch (sym.kind) {
      case SymbolKind.Function:
        return { type: "function", modifiers: mods };
      case SymbolKind.Macro:
        return { type: "macro", modifiers: mods };
      case SymbolKind.GenericFunction:
        return { type: "function", modifiers: [...mods, "generic"] };
      case SymbolKind.Method:
        return { type: "method", modifiers: mods };
      case SymbolKind.Class:
      case SymbolKind.Condition:
        return { type: "class", modifiers: mods };
      case SymbolKind.Struct:
        return { type: "struct", modifiers: mods };
      case SymbolKind.Type:
        return { type: "type", modifiers: mods };
      case SymbolKind.Constant:
        return { type: "variable", modifiers: [...mods, "readonly"] };
      case SymbolKind.Variable:
      case SymbolKind.Parameter:
        // A global `defvar`/`defparameter` names a special variable (the
        // indexer records `defparameter` as `Parameter`); lexical parameters
        // are modelled as lexical bindings, not global symbols.
        return { type: "variable", modifiers: [...mods, "special"] };
      case SymbolKind.Package:
        return { type: "namespace", modifiers: mods };
      default:
        return { type: "variable", modifiers: mods };
    }
  }

  if (target.kind === "builtin") {
    // A standardized COMMON-LISP symbol known from the static catalog. It is
    // never a definition; `defaultLibrary` marks it as standard-library origin.
    const mods: TokenModifier[] = ["defaultLibrary"];
    switch (target.builtinKind) {
      case "special-operator":
        return { type: "keyword", modifiers: [] };
      case "macro":
        return { type: "macro", modifiers: mods };
      case "function":
        return { type: "function", modifiers: mods };
      case "type":
        return { type: "type", modifiers: mods };
      case "constant":
        return { type: "variable", modifiers: [...mods, "readonly"] };
      case "variable":
        return { type: "variable", modifiers: [...mods, "special"] };
      default:
        return { type: "variable", modifiers: mods };
    }
  }

  // Unresolved or non-navigable (`none`) occurrences. These are classified from
  // syntax + language knowledge alone, conservatively.
  if (isLambdaListKeyword(ref.name)) return undefined;

  // A Lisp keyword symbol (`:foo`) is a self-evaluating constant.
  if (ref.qualification === "keyword") {
    return { type: "enumMember", modifiers: ["readonly"] };
  }

  // Special operators / core forms (if, let, progn, …) read as keywords.
  if (ref.qualification === "none" && isSpecialOperator(ref.name)) {
    return { type: "keyword", modifiers: [] };
  }

  if (target.kind === "none") return undefined;

  // An unresolved but well-formed reference still gets namespace-appropriate
  // colouring (most are calls to builtins we do not index); never a definition.
  return {
    type: target.namespace === Namespace.Function ? "function" : "variable",
    modifiers: [],
  };
}

/**
 * The portion of an atom's source range covering just its symbol name, after a
 * package qualifier (`pkg:` / `pkg::`), together with the qualifier range when
 * present. Lets highlighting colour the package prefix as a namespace and the
 * symbol separately.
 */
export function splitQualifiedRanges(
  node: AtomNode,
  ref: QualifiedName,
): { packageRange?: Range; symbolRange: Range } {
  if (!ref.packagePrefix) return { symbolRange: node.range };
  const text = node.text;
  const firstColon = text.indexOf(":");
  if (firstColon <= 0) return { symbolRange: node.range };
  let symStart = firstColon;
  while (symStart < text.length && text[symStart] === ":") symStart++;

  const start = node.range.start;
  const mk = (from: number, to: number): Range => ({
    start: {
      offset: start.offset + from,
      line: start.line,
      character: start.character + from,
    },
    end: {
      offset: start.offset + to,
      line: start.line,
      character: start.character + to,
    },
  });
  return {
    packageRange: mk(0, firstColon),
    symbolRange: mk(symStart, text.length),
  };
}

/**
 * Recognises a Common Lisp numeric token (integer, ratio, float, or radixed
 * literal). Numeric atoms are never symbol references and must not be tokenized
 * as variables.
 */
export function isNumericToken(text: string): boolean {
  return NUMERIC.test(text);
}

const NUMERIC =
  /^[+-]?(\d+\.?|\d+\/\d+|\d*\.\d+(?:[esfdlESFDL][+-]?\d+)?|\d+(?:\.\d*)?[esfdlESFDL][+-]?\d+|#[bBoOxX][0-9a-fA-F]+|#\d+[rR][0-9a-zA-Z]+)$/;
