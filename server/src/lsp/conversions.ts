import {
  SymbolKind as LspSymbolKind,
  Range as LspRange,
  CompletionItem,
  CompletionItemKind,
  InsertTextFormat,
  SignatureHelp,
  SignatureInformation,
  ParameterInformation,
  Diagnostic,
  DiagnosticSeverity,
} from "vscode-languageserver";
import { Range } from "../parser/position";
import { SymbolDefinition, SymbolKind } from "../model/symbol";
import { LexicalBinding, LexicalBindingKind } from "../model/scope";
import { CompletionCandidate, CompletionKind } from "../model/intelligence";
import { SignatureModel } from "../analyzer/signature";
import { DiagnosticInfo } from "../model/diagnostic";
import { StandardSymbolKind } from "../model/standard-library";

export function toLspRange(range: Range): LspRange {
  return {
    start: { line: range.start.line, character: range.start.character },
    end: { line: range.end.line, character: range.end.character },
  };
}

/** Maps SexprScope symbol kinds onto the closest LSP SymbolKind. */
export function toLspSymbolKind(kind: SymbolKind): LspSymbolKind {
  switch (kind) {
    case SymbolKind.Function:
      return LspSymbolKind.Function;
    case SymbolKind.Macro:
      return LspSymbolKind.Function;
    case SymbolKind.GenericFunction:
      return LspSymbolKind.Function;
    case SymbolKind.Method:
      return LspSymbolKind.Method;
    case SymbolKind.Class:
      return LspSymbolKind.Class;
    case SymbolKind.Struct:
      return LspSymbolKind.Struct;
    case SymbolKind.Condition:
      return LspSymbolKind.Class;
    case SymbolKind.Type:
      return LspSymbolKind.Interface;
    case SymbolKind.Variable:
      return LspSymbolKind.Variable;
    case SymbolKind.Parameter:
      return LspSymbolKind.Variable;
    case SymbolKind.Constant:
      return LspSymbolKind.Constant;
    case SymbolKind.Package:
      return LspSymbolKind.Namespace;
    default:
      return LspSymbolKind.Object;
  }
}

/** Human-readable label for a symbol kind, used in hovers and the tree view. */
export function kindLabel(kind: SymbolKind): string {
  switch (kind) {
    case SymbolKind.GenericFunction:
      return "generic function";
    default:
      return kind.replace(/-/g, " ");
  }
}

/** Builds a Markdown hover body for a symbol definition. */
export function hoverMarkdown(sym: SymbolDefinition): string {
  const lines: string[] = [];
  const qualified = `${sym.package}:${sym.name}`;
  const signature = sym.lambdaList ? ` ${sym.lambdaList}` : "";
  lines.push("```lisp");
  lines.push(`(${qualified}${signature})`);
  lines.push("```");
  const meta = `*${kindLabel(sym.kind)}${sym.exported ? ", exported" : ""}*`;
  lines.push(meta);
  if (sym.conditional) {
    // Be honest about uncertainty: a `#+`/`#-` guarded definition may or may not
    // exist in a given image. Static analysis never evaluates the feature test.
    const guard = sym.featureExpression ? ` \`#${sym.featureExpression}\`` : "";
    lines.push("");
    lines.push(
      `⚠️ Conditionally defined${guard}; availability depends on runtime features.`,
    );
  }
  if (sym.documentation) {
    lines.push("");
    lines.push(sym.documentation);
  }
  return lines.join("\n");
}

/** Human-readable label for a lexical binding kind. */
export function lexicalKindLabel(kind: LexicalBindingKind): string {
  switch (kind) {
    case LexicalBindingKind.Parameter:
      return "parameter";
    case LexicalBindingKind.LetVariable:
      return "lexical variable";
    case LexicalBindingKind.LocalFunction:
      return "local function";
    case LexicalBindingKind.LocalMacro:
      return "local macro";
    case LexicalBindingKind.SymbolMacro:
      return "symbol macro";
    case LexicalBindingKind.MultipleValue:
      return "lexical variable";
    case LexicalBindingKind.Destructuring:
      return "lexical variable";
  }
}

/** Builds a Markdown hover body for a lexical binding. */
export function lexicalHoverMarkdown(binding: LexicalBinding): string {
  const lines: string[] = [];
  const isLocalFn =
    binding.bindingKind === LexicalBindingKind.LocalFunction ||
    binding.bindingKind === LexicalBindingKind.LocalMacro;
  lines.push("```lisp");
  // A local function/macro reads as a call form; a variable is just its name.
  lines.push(
    isLocalFn
      ? `(${binding.name}${binding.lambdaList ? ` ${binding.lambdaList}` : ""})`
      : binding.name,
  );
  lines.push("```");
  // Lexical bindings are not package-owned; say so plainly.
  lines.push(`*${lexicalKindLabel(binding.bindingKind)} (lexical)*`);
  return lines.join("\n");
}

/** Builds a Markdown hover body for a standardized COMMON-LISP symbol. */
export function builtinHoverMarkdown(target: {
  name: string;
  builtinKind: StandardSymbolKind;
}): string {
  const lines: string[] = [];
  lines.push("```lisp");
  lines.push(`(common-lisp:${target.name.toLowerCase()})`);
  lines.push("```");
  const kindText =
    target.builtinKind === "special-operator"
      ? "special operator"
      : target.builtinKind;
  lines.push(`*standard ${kindText} (COMMON-LISP)*`);
  return lines.join("\n");
}

/** Maps an internal completion kind onto the closest LSP CompletionItemKind. */
export function toCompletionItemKind(kind: CompletionKind): CompletionItemKind {
  switch (kind) {
    case CompletionKind.Function:
      return CompletionItemKind.Function;
    case CompletionKind.Macro:
      return CompletionItemKind.Keyword;
    case CompletionKind.GenericFunction:
      return CompletionItemKind.Function;
    case CompletionKind.Method:
      return CompletionItemKind.Method;
    case CompletionKind.Variable:
      return CompletionItemKind.Variable;
    case CompletionKind.Constant:
      return CompletionItemKind.Constant;
    case CompletionKind.Class:
      return CompletionItemKind.Class;
    case CompletionKind.Struct:
      return CompletionItemKind.Struct;
    case CompletionKind.Type:
      return CompletionItemKind.Interface;
    case CompletionKind.Package:
      return CompletionItemKind.Module;
    case CompletionKind.Parameter:
      return CompletionItemKind.Variable;
    case CompletionKind.LocalFunction:
      return CompletionItemKind.Function;
    case CompletionKind.LocalMacro:
      return CompletionItemKind.Keyword;
    default:
      return CompletionItemKind.Text;
  }
}

/**
 * Converts an internal completion candidate into an LSP completion item.
 *
 * The candidate's `replaceRange` covers only the symbol-name part of the token,
 * so the emitted `textEdit` preserves any package qualifier (`pay:aut|` →
 * replaces `aut`, keeping `pay:`). `sortText` is derived from the deterministic
 * `sortRank` so the editor keeps the engine's ranking.
 */
export function toCompletionItem(
  candidate: CompletionCandidate,
  index: number,
): CompletionItem {
  // Zero-pad so lexicographic client-side sorting matches numeric rank order.
  const sortText = `${String(candidate.sortRank).padStart(4, "0")}:${String(
    index,
  ).padStart(5, "0")}`;
  return {
    label: candidate.label,
    kind: toCompletionItemKind(candidate.kind),
    detail: candidate.detail,
    documentation: candidate.documentation,
    sortText,
    filterText: candidate.label,
    insertTextFormat: InsertTextFormat.PlainText,
    textEdit: {
      range: toLspRange(candidate.replaceRange),
      newText: candidate.insertText,
    },
  };
}

/** Converts an internal signature model into an LSP SignatureHelp payload. */
export function toSignatureHelp(model: SignatureModel): SignatureHelp {
  const parameters: ParameterInformation[] = model.parameters.map((label) => ({
    label,
  }));
  const info: SignatureInformation = {
    label: model.label,
    parameters,
    documentation: model.documentation,
  };
  // Clamp the active parameter so a client never highlights out of range.
  const activeParameter =
    parameters.length === 0
      ? 0
      : Math.max(0, Math.min(model.activeParameter, parameters.length - 1));
  return {
    signatures: [info],
    activeSignature: 0,
    activeParameter,
  };
}

/** Maps an internal diagnostic severity name onto the LSP severity. */
export function toLspDiagnosticSeverity(
  severity: DiagnosticInfo["severity"],
): DiagnosticSeverity {
  switch (severity) {
    case "error":
      return DiagnosticSeverity.Error;
    case "warning":
      return DiagnosticSeverity.Warning;
    case "information":
      return DiagnosticSeverity.Information;
    case "hint":
      return DiagnosticSeverity.Hint;
  }
}

/** Converts an internal diagnostic into an LSP diagnostic. */
export function toLspDiagnostic(info: DiagnosticInfo): Diagnostic {
  return {
    range: toLspRange(info.range),
    message: info.message,
    severity: toLspDiagnosticSeverity(info.severity),
    code: info.code,
    source: info.source,
  };
}
