import {
  Connection,
  DidChangeConfigurationNotification,
  DocumentSymbol,
  Hover,
  InitializeParams,
  InitializeResult,
  Location,
  SymbolInformation,
  TextDocumentSyncKind,
  TextDocuments,
  WorkspaceSymbol,
} from "vscode-languageserver";
import { TextDocument } from "vscode-languageserver-textdocument";
import { URI } from "vscode-languageserver";
import { WorkspaceIndex } from "../indexer/workspace-index";
import { atomAtOffset } from "../parser/reader";
import { parseQualifiedName } from "../model/symbol";
import {
  hoverMarkdown,
  kindLabel,
  toLspRange,
  toLspSymbolKind,
} from "./conversions";

/**
 * Wires the static language intelligence to an LSP connection.
 *
 * Only static, non-evaluating features are served here. Anything requiring a
 * live image belongs to the separate runtime protocol (see protocol/).
 */
export function createServer(connection: Connection): void {
  const index = new WorkspaceIndex();
  const documents = new TextDocuments(TextDocument);

  const reindex = (doc: TextDocument) => {
    index.setDocument(doc.uri, doc.getText());
  };

  documents.onDidOpen((e) => reindex(e.document));
  documents.onDidChangeContent((e) => reindex(e.document));
  documents.onDidClose((e) => {
    // Keep closed files in the index so workspace-wide navigation still works.
    // (Re-opening re-parses, so staleness is bounded.)
    void e;
  });

  connection.onInitialize((_params: InitializeParams): InitializeResult => {
    return {
      capabilities: {
        textDocumentSync: TextDocumentSyncKind.Incremental,
        documentSymbolProvider: true,
        workspaceSymbolProvider: true,
        definitionProvider: true,
        hoverProvider: true,
      },
      serverInfo: { name: "sexpr-scope-server", version: "0.1.0" },
    };
  });

  connection.onInitialized(() => {
    connection.client
      .register(DidChangeConfigurationNotification.type, undefined)
      .catch(() => undefined);
  });

  connection.onDocumentSymbol((params): DocumentSymbol[] => {
    const uri = params.textDocument.uri;
    const symbols = index.symbolsInDocument(uri);
    return symbols.map((sym) => ({
      name: sym.name,
      detail: kindLabel(sym.kind) + (sym.lambdaList ? ` ${sym.lambdaList}` : ""),
      kind: toLspSymbolKind(sym.kind),
      range: toLspRange(sym.range),
      selectionRange: toLspRange(sym.selectionRange),
    }));
  });

  connection.onWorkspaceSymbol((params): (SymbolInformation | WorkspaceSymbol)[] => {
    return index.searchSymbols(params.query).map((sym) => ({
      name: `${sym.package}:${sym.name}`,
      kind: toLspSymbolKind(sym.kind),
      location: { uri: sym.uri, range: toLspRange(sym.selectionRange) },
    }));
  });

  connection.onDefinition((params): Location[] => {
    const uri = params.textDocument.uri;
    const doc = index.getDocument(uri);
    if (!doc) return [];
    const offset = offsetOf(doc.text, params.position.line, params.position.character);
    const atom = atomAtOffset(doc, offset);
    if (!atom) return [];
    const ref = parseQualifiedName(atom.text);
    const currentPackage = index.packageAt(uri, offset);
    const defs = index.resolveReference(ref, currentPackage);
    return defs.map((sym) => ({
      uri: sym.uri,
      range: toLspRange(sym.selectionRange),
    }));
  });

  connection.onHover((params): Hover | null => {
    const uri = params.textDocument.uri;
    const doc = index.getDocument(uri);
    if (!doc) return null;
    const offset = offsetOf(doc.text, params.position.line, params.position.character);
    const atom = atomAtOffset(doc, offset);
    if (!atom) return null;
    const ref = parseQualifiedName(atom.text);
    const currentPackage = index.packageAt(uri, offset);
    const defs = index.resolveReference(ref, currentPackage);
    if (defs.length === 0) return null;
    return {
      contents: { kind: "markdown", value: hoverMarkdown(defs[0]) },
      range: toLspRange(atom.range),
    };
  });

  documents.listen(connection);
  connection.listen();
}

/** Converts an LSP line/character position into a flat UTF-16 offset. */
function offsetOf(text: string, line: number, character: number): number {
  let offset = 0;
  let currentLine = 0;
  while (currentLine < line && offset < text.length) {
    const nl = text.indexOf("\n", offset);
    if (nl === -1) return text.length;
    offset = nl + 1;
    currentLine++;
  }
  return Math.min(offset + character, text.length);
}

export { URI };
