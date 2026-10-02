/**
 * A non-evaluating tokenizer for Common Lisp source text.
 *
 * SAFETY CONTRACT
 * ---------------
 * This tokenizer NEVER invokes the Common Lisp reader and NEVER evaluates any
 * part of the source. Constructs that can trigger evaluation in a real reader
 * (most notably `#.` read-time evaluation, and arbitrary user reader macros)
 * are recognized purely as lexical tokens and left as inert data. Opening a
 * workspace must never execute code; this module is where that guarantee
 * begins.
 *
 * The tokenizer is intentionally tolerant: unterminated strings, unterminated
 * block comments and stray characters produce tokens (optionally flagged) and
 * never throw, so partially written files still yield a usable token stream.
 */

export enum TokenType {
  LParen = "lparen",
  RParen = "rparen",
  String = "string",
  LineComment = "line-comment",
  BlockComment = "block-comment",
  /** ' ` , ,@ #' and the #. read-eval marker: structural prefixes only. */
  Prefix = "prefix",
  /** `#(` vector open; closed by a normal RParen. */
  VectorOpen = "vector-open",
  /** Any atom: symbols, numbers, characters (`#\\x`), keywords, etc. */
  Atom = "atom",
}

export interface Token {
  readonly type: TokenType;
  readonly start: number;
  readonly end: number;
  readonly text: string;
  /** Prefix spelling (e.g. "'", "#'", "#.") for Prefix tokens. */
  readonly prefix?: string;
  /** True when a string or block comment ran to EOF without closing. */
  readonly unterminated?: boolean;
}

const WHITESPACE = new Set([" ", "\t", "\n", "\r", "\f"]);

function isTerminating(ch: string): boolean {
  return (
    WHITESPACE.has(ch) ||
    ch === "(" ||
    ch === ")" ||
    ch === '"' ||
    ch === ";" ||
    ch === "'" ||
    ch === "`" ||
    ch === ","
  );
}

export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = text.length;

  const push = (t: Token) => tokens.push(t);

  while (i < n) {
    const ch = text[i];

    if (WHITESPACE.has(ch)) {
      i++;
      continue;
    }

    if (ch === "(") {
      push({ type: TokenType.LParen, start: i, end: i + 1, text: "(" });
      i++;
      continue;
    }

    if (ch === ")") {
      push({ type: TokenType.RParen, start: i, end: i + 1, text: ")" });
      i++;
      continue;
    }

    // Line comment: ; ... end of line
    if (ch === ";") {
      const start = i;
      while (i < n && text[i] !== "\n") i++;
      push({
        type: TokenType.LineComment,
        start,
        end: i,
        text: text.slice(start, i),
      });
      continue;
    }

    // String literal with \ escapes.
    if (ch === '"') {
      const start = i;
      i++;
      let unterminated = true;
      while (i < n) {
        if (text[i] === "\\") {
          i += 2;
          continue;
        }
        if (text[i] === '"') {
          i++;
          unterminated = false;
          break;
        }
        i++;
      }
      push({
        type: TokenType.String,
        start,
        end: i,
        text: text.slice(start, i),
        unterminated: unterminated || undefined,
      });
      continue;
    }

    // Reader-prefix characters.
    if (ch === "'" || ch === "`") {
      push({ type: TokenType.Prefix, start: i, end: i + 1, text: ch, prefix: ch });
      i++;
      continue;
    }
    if (ch === ",") {
      if (text[i + 1] === "@") {
        push({ type: TokenType.Prefix, start: i, end: i + 2, text: ",@", prefix: ",@" });
        i += 2;
      } else {
        push({ type: TokenType.Prefix, start: i, end: i + 1, text: ",", prefix: "," });
        i++;
      }
      continue;
    }

    // Sharpsign dispatch.
    if (ch === "#") {
      const next = text[i + 1];

      // Block comment #| ... |# with nesting.
      if (next === "|") {
        const start = i;
        i += 2;
        let depth = 1;
        let unterminated = true;
        while (i < n) {
          if (text[i] === "#" && text[i + 1] === "|") {
            depth++;
            i += 2;
            continue;
          }
          if (text[i] === "|" && text[i + 1] === "#") {
            depth--;
            i += 2;
            if (depth === 0) {
              unterminated = false;
              break;
            }
            continue;
          }
          i++;
        }
        push({
          type: TokenType.BlockComment,
          start,
          end: i,
          text: text.slice(start, i),
          unterminated: unterminated || undefined,
        });
        continue;
      }

      // Character literal #\x (including #\Space, #\( etc.).
      if (next === "\\") {
        const start = i;
        i += 2;
        if (i < n) i++; // always consume at least one character glyph
        while (i < n && !isTerminating(text[i])) i++;
        push({
          type: TokenType.Atom,
          start,
          end: i,
          text: text.slice(start, i),
        });
        continue;
      }

      // Vector literal #( ... )
      if (next === "(") {
        push({ type: TokenType.VectorOpen, start: i, end: i + 2, text: "#(" });
        i += 2;
        continue;
      }

      // Function abbreviation #'form
      if (next === "'") {
        push({ type: TokenType.Prefix, start: i, end: i + 2, text: "#'", prefix: "#'" });
        i += 2;
        continue;
      }

      // Read-time evaluation #.form — recognized, NEVER evaluated.
      if (next === ".") {
        push({ type: TokenType.Prefix, start: i, end: i + 2, text: "#.", prefix: "#." });
        i += 2;
        continue;
      }

      // Feature expressions #+feature / #-feature behave as prefixes wrapping
      // the following test form; keep the whole #+/#- as a prefix token.
      if (next === "+" || next === "-") {
        push({
          type: TokenType.Prefix,
          start: i,
          end: i + 2,
          text: "#" + next,
          prefix: "#" + next,
        });
        i += 2;
        continue;
      }

      // Any other sharpsign form (#b101, #xFF, #:g, #*101, #S(...), etc.):
      // fall through and read as a single atom token (the reader dispatch is
      // not interpreted, only lexed).
    }

    // Default: an atom. Symbols may contain escaped characters via `\` and
    // multiple-escape regions delimited by vertical bars.
    {
      const start = i;
      while (i < n) {
        const c = text[i];
        if (c === "\\") {
          i += 2;
          continue;
        }
        if (c === "|") {
          // Multiple-escape: everything up to the matching bar is literal.
          i++;
          while (i < n && text[i] !== "|") {
            if (text[i] === "\\") i++;
            i++;
          }
          if (i < n) i++; // consume closing bar
          continue;
        }
        if (isTerminating(c)) break;
        i++;
      }
      if (i === start) {
        // Defensive: ensure forward progress on an unexpected character.
        i++;
      }
      push({
        type: TokenType.Atom,
        start,
        end: i,
        text: text.slice(start, i),
      });
    }
  }

  return tokens;
}
