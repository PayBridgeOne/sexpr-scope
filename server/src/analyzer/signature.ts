import { isLambdaListKeyword } from "../model/language";
import { canonicalizeName } from "../model/symbol";

/**
 * A static, presentation-only model of a callable's signature.
 *
 * Milestone 2 presents the lambda list captured from a definition; it never
 * executes a macro or consults a running image to validate arguments.
 */
export interface SignatureModel {
  /** The full signature label, e.g. `(charge-fee transaction amount &key currency)`. */
  readonly label: string;
  /** Parameter substrings of `label`, excluding lambda-list keywords. */
  readonly parameters: string[];
  /** Index into `parameters` of the argument under the cursor. */
  readonly activeParameter: number;
  readonly documentation?: string;
}

/**
 * Splits a lambda-list body (the text *inside* the outer parentheses) into its
 * top-level parameter tokens, respecting nested parentheses so that
 * `(x default)` optional/key specs stay intact.
 */
export function splitLambdaListTokens(body: string): string[] {
  const tokens: string[] = [];
  let depth = 0;
  let current = "";
  const flush = () => {
    if (current.length > 0) tokens.push(current);
    current = "";
  };
  for (const c of body) {
    if (c === "(" || c === "[") {
      depth++;
      current += c;
    } else if (c === ")" || c === "]") {
      depth = Math.max(0, depth - 1);
      current += c;
    } else if (/\s/.test(c) && depth === 0) {
      flush();
    } else {
      current += c;
    }
  }
  flush();
  return tokens;
}

/** The parameter tokens of a lambda-list body, excluding lambda-list keywords. */
export function lambdaListParameters(body: string): string[] {
  return splitLambdaListTokens(body).filter(
    (t) => !isLambdaListKeyword(canonicalizeName(firstAtomOf(t))),
  );
}

/** The leading atom of a token (`x` from `(x 1)`), used to spot `&key` etc. */
function firstAtomOf(token: string): string {
  let t = token;
  if (t.startsWith("(")) t = t.slice(1);
  const m = /^[^\s()]*/.exec(t);
  return m ? m[0] : t;
}

/**
 * Strips the outer parentheses from a captured lambda list (`(a b)` → `a b`).
 * A captured lambda list always includes its surrounding parens.
 */
export function lambdaListBody(lambdaList: string): string {
  const t = lambdaList.trim();
  if (t.startsWith("(") && t.endsWith(")")) return t.slice(1, -1).trim();
  return t;
}

/**
 * Builds a {@link SignatureModel} from a callable name, its captured lambda list
 * and the active argument index.
 */
export function buildSignature(
  name: string,
  lambdaList: string | undefined,
  activeArgument: number,
  documentation?: string,
): SignatureModel {
  const body = lambdaList ? lambdaListBody(lambdaList) : "";
  const parameters = body ? lambdaListParameters(body) : [];
  const label = body ? `(${name} ${body})` : `(${name})`;
  const activeParameter =
    parameters.length === 0
      ? 0
      : Math.min(Math.max(activeArgument, 0), parameters.length - 1);
  return { label, parameters, activeParameter, documentation };
}
