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
  SymbolInformation,
  TextDocumentSyncKind,
  TextDocuments,
  WorkspaceFolder,
  WorkspaceSymbol,
} from "vscode-languageserver";
import { TextDocument } from "vscode-languageserver-textdocument";
import { URI } from "vscode-languageserver";
import { promises as fs } from "fs";
import * as path from "path";
import { WorkspaceIndex } from "../indexer/workspace-index";
import { atomAtOffset, referenceNamespaceAt } from "../parser/reader";
import type { Document } from "../parser/reader";
import { Namespace, parseQualifiedName } from "../model/symbol";
import {
  hoverMarkdown,
  kindLabel,
  toLspRange,
  toLspSymbolKind,
} from "./conversions";

/** File extensions SexprScope reads statically (never evaluates). */
const SOURCE_EXTENSIONS = new Set([".lisp", ".cl", ".lsp", ".asd"]);

/** Directories never worth scanning for Lisp source. */
const IGNORED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  "out",
  "build",
]);

/**
 * Wires the static language intelligence to an LSP connection.
 *
 * Only static, non-evaluating features are served here. Anything requiring a
 * live image belongs to the separate runtime protocol (see protocol/).
 */
export function createServer(connection: Connection): void {
  const index = new WorkspaceIndex();
  const documents = new TextDocuments(TextDocument);
  // URIs whose content is currently owned by an open editor buffer. On-disk
  // changes to these files are ignored; the buffer is the source of truth.
  const openDocuments = new Set<string>();

  const reindexOpen = (doc: TextDocument) => {
    openDocuments.add(doc.uri);
    index.setDocument(doc.uri, doc.getText());
  };

  documents.onDidOpen((e) => reindexOpen(e.document));
  documents.onDidChangeContent((e) => reindexOpen(e.document));
  documents.onDidClose((e) => {
    // The buffer no longer overrides disk; fall back to the on-disk version so
    // workspace-wide navigation stays consistent with what the user sees.
    openDocuments.delete(e.document.uri);
    void reindexFromDisk(e.document.uri);
  });

  const reindexFromDisk = async (uri: string): Promise<void> => {
    const fsPath = uriToFsPath(uri);
    if (!fsPath) return;
    try {
      const text = await fs.readFile(fsPath, "utf8");
      index.setDocument(uri, text);
    } catch {
      index.removeDocument(uri);
    }
  };

  connection.onInitialize((params: InitializeParams): InitializeResult => {
    void scanWorkspace(index, params, openDocuments).catch(() => undefined);
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
    const namespace = namespaceAt(doc, offset);
    const defs = index.resolveReference(ref, currentPackage, { namespace });
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
    const namespace = namespaceAt(doc, offset);
    const defs = index.resolveReference(ref, currentPackage, { namespace });
    if (defs.length === 0) return null;
    return {
      contents: { kind: "markdown", value: hoverMarkdown(defs[0]) },
      range: toLspRange(atom.range),
    };
  });

  documents.listen(connection);
  connection.listen();
}

/** Maps the reader's syntactic namespace hint onto the resolver's type. */
function namespaceAt(doc: Document, offset: number): Namespace | "any" {
  return referenceNamespaceAt(doc, offset) === "function"
    ? Namespace.Function
    : "any";
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
  for (const root of roots) {
    await scanDirectory(root, index, openDocuments);
  }
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

async function scanDirectory(
  dir: string,
  index: WorkspaceIndex,
  openDocuments: ReadonlySet<string>,
): Promise<void> {
  let entries: import("fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(entry.name)) continue;
      await scanDirectory(full, index, openDocuments);
    } else if (entry.isFile() && isSourcePath(entry.name)) {
      const uri = fsPathToUri(full);
      if (openDocuments.has(uri) || index.hasDocument(uri)) continue;
      try {
        const text = await fs.readFile(full, "utf8");
        index.setDocument(uri, text);
      } catch {
        // Unreadable file: skip silently, stay tolerant.
      }
    }
  }
}

function isSourcePath(name: string): boolean {
  return SOURCE_EXTENSIONS.has(path.extname(name).toLowerCase());
}

function isSourceUri(uri: string): boolean {
  const fsPath = uriToFsPath(uri);
  return fsPath ? isSourcePath(fsPath) : false;
}

function uriToFsPath(uri: string): string | undefined {
  try {
    const u = new URL(uri);
    if (u.protocol !== "file:") return undefined;
    return decodeURIComponent(u.pathname);
  } catch {
    return undefined;
  }
}

function fsPathToUri(fsPath: string): string {
  const resolved = path.resolve(fsPath);
  const encoded = resolved
    .split(path.sep)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const leading = encoded.startsWith("/") ? "" : "/";
  return `file://${leading}${encoded}`;
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
