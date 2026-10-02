import {
  Connection,
  DidChangeConfigurationNotification,
  DidChangeWatchedFilesParams,
  DocumentSymbol,
  FileChangeType,
  Hover,
  InitializeParams,
  InitializeResult,
  Location,
  ReferenceParams,
  SymbolInformation,
  TextDocumentSyncKind,
  TextDocuments,
  WorkspaceFolder,
  WorkspaceSymbol,
} from "vscode-languageserver";
import { TextDocument } from "vscode-languageserver-textdocument";
import { URI } from "vscode-languageserver";
import { WorkspaceIndex } from "../indexer/workspace-index";
import {
  isSourceUri,
  reindexUriFromDisk,
  scanRoots,
  uriToFsPath,
} from "./workspace-fs";
import {
  hoverMarkdown,
  kindLabel,
  lexicalHoverMarkdown,
  toLspRange,
  toLspSymbolKind,
} from "./conversions";

/** Handle returned by {@link createServer}, exposing the init readiness barrier. */
export interface ServerHandle {
  /**
   * Resolves once the initial workspace scan has completed (or failed safely).
   * Semantic requests await this so navigation is never served against a
   * half-built index.
   */
  readonly whenReady: Promise<void>;
}

/**
 * Wires the static language intelligence to an LSP connection.
 *
 * Only static, non-evaluating features are served here. Anything requiring a
 * live image belongs to the separate runtime protocol (see protocol/).
 */
export function createServer(connection: Connection): ServerHandle {
  const index = new WorkspaceIndex();
  const documents = new TextDocuments(TextDocument);
  // URIs whose content is currently owned by an open editor buffer. On-disk
  // changes to these files are ignored; the buffer is the source of truth.
  const openDocuments = new Set<string>();

  // Readiness barrier: the initial workspace scan runs during initialization,
  // but init itself does not block. Semantic requests await `ready`, so by the
  // time any navigation is served the initial static index is complete.
  let markReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });

  const reindexOpen = (doc: TextDocument) => {
    openDocuments.add(doc.uri);
    index.setDocument(doc.uri, doc.getText());
  };

  const reindexFromDisk = (uri: string): Promise<void> =>
    reindexUriFromDisk(uri, index);

  documents.onDidOpen((e) => reindexOpen(e.document));
  documents.onDidChangeContent((e) => reindexOpen(e.document));
  documents.onDidClose((e) => {
    // The buffer no longer overrides disk; fall back to the on-disk version so
    // workspace-wide navigation stays consistent with what the user sees.
    openDocuments.delete(e.document.uri);
    void reindexFromDisk(e.document.uri);
  });

  connection.onInitialize((params: InitializeParams): InitializeResult => {
    // Kick off the initial scan without blocking initialization, but signal
    // readiness only once it settles. Unreadable files are skipped inside the
    // scan, so this always completes rather than blocking forever.
    scanWorkspace(index, params, openDocuments)
      .catch(() => undefined)
      .finally(() => markReady());
    return {
      capabilities: {
        textDocumentSync: TextDocumentSyncKind.Incremental,
        documentSymbolProvider: true,
        workspaceSymbolProvider: true,
        definitionProvider: true,
        referencesProvider: true,
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

  connection.onDidChangeWatchedFiles((params: DidChangeWatchedFilesParams) => {
    for (const change of params.changes) {
      const uri = change.uri;
      // Open buffers are authoritative; ignore disk events for them.
      if (openDocuments.has(uri)) continue;
      if (!isSourceUri(uri)) continue;
      if (change.type === FileChangeType.Deleted) {
        index.removeDocument(uri);
      } else {
        void reindexFromDisk(uri);
      }
    }
  });

  connection.onDocumentSymbol(async (params): Promise<DocumentSymbol[]> => {
    await ready;
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

  connection.onWorkspaceSymbol(
    async (params): Promise<(SymbolInformation | WorkspaceSymbol)[]> => {
      await ready;
      return index.searchSymbols(params.query).map((sym) => ({
        name: `${sym.package}:${sym.name}`,
        kind: toLspSymbolKind(sym.kind),
        location: { uri: sym.uri, range: toLspRange(sym.selectionRange) },
      }));
    },
  );

  connection.onDefinition(async (params): Promise<Location[]> => {
    await ready;
    const uri = params.textDocument.uri;
    const doc = index.getDocument(uri);
    if (!doc) return [];
    const offset = offsetOf(doc.text, params.position.line, params.position.character);
    const resolution = index.resolveAt(uri, offset);
    if (!resolution) return [];
    const target = resolution.target;
    if (target.kind === "lexical") {
      return [{ uri: target.binding.uri, range: toLspRange(target.binding.selectionRange) }];
    }
    if (target.kind === "global") {
      return target.symbols.map((sym) => ({
        uri: sym.uri,
        range: toLspRange(sym.selectionRange),
      }));
    }
    // `unresolved` / `none`: no location to navigate to (conservative).
    return [];
  });

  connection.onReferences(async (params: ReferenceParams): Promise<Location[]> => {
    await ready;
    const uri = params.textDocument.uri;
    const doc = index.getDocument(uri);
    if (!doc) return [];
    const offset = offsetOf(doc.text, params.position.line, params.position.character);
    const includeDeclaration = params.context?.includeDeclaration ?? true;
    const refs = index.findReferences(uri, offset, includeDeclaration);
    return refs.map((r) => ({ uri: r.uri, range: toLspRange(r.range) }));
  });

  connection.onHover(async (params): Promise<Hover | null> => {
    await ready;
    const uri = params.textDocument.uri;
    const doc = index.getDocument(uri);
    if (!doc) return null;
    const offset = offsetOf(doc.text, params.position.line, params.position.character);
    const resolution = index.resolveAt(uri, offset);
    if (!resolution) return null;
    const target = resolution.target;
    const range = toLspRange(resolution.occurrence.node.range);
    if (target.kind === "lexical") {
      return {
        contents: { kind: "markdown", value: lexicalHoverMarkdown(target.binding) },
        range,
      };
    }
    if (target.kind === "global" && target.symbols.length > 0) {
      return {
        contents: { kind: "markdown", value: hoverMarkdown(target.symbols[0]) },
        range,
      };
    }
    return null;
  });

  documents.listen(connection);
  connection.listen();

  return { whenReady: ready };
}

/**
 * Discovers and statically indexes every Lisp source file in the workspace.
 *
 * Files are only READ as text — never evaluated. Open editor buffers are left
 * untouched so a user's unsaved edits are not clobbered by the on-disk copy.
 */
async function scanWorkspace(
  index: WorkspaceIndex,
  params: InitializeParams,
  openDocuments: ReadonlySet<string>,
): Promise<void> {
  const roots = workspaceRoots(params);
  await scanRoots(roots, index, (uri) => openDocuments.has(uri));
}

function workspaceRoots(params: InitializeParams): string[] {
  const folders: WorkspaceFolder[] | null | undefined = params.workspaceFolders;
  if (folders && folders.length > 0) {
    return folders
      .map((f) => uriToFsPath(f.uri))
      .filter((p): p is string => !!p);
  }
  if (params.rootUri) {
    const p = uriToFsPath(params.rootUri);
    return p ? [p] : [];
  }
  if (params.rootPath) return [params.rootPath];
  return [];
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
