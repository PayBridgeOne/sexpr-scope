import {
  SymbolKind as LspSymbolKind,
  Range as LspRange,
} from "vscode-languageserver";
import { Range } from "../parser/position";
import { SymbolDefinition, SymbolKind } from "../model/symbol";

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
