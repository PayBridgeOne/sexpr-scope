import { Document, parseDocument } from "../parser/reader";
import {
  PackageDefinition,
  QualifiedName,
  SymbolDefinition,
} from "../model/symbol";
import { DocumentIndex, indexDocument, packageAtOffset } from "./document-indexer";

interface Entry {
  readonly doc: Document;
  readonly index: DocumentIndex;
}

/**
 * Aggregates per-document indexes into a queryable, package-aware model.
 *
 * The workspace index is the single source of truth for static navigation.
 * It is intentionally independent of any running Lisp image: every query here
 * works whether or not SBCL is available.
 */
export class WorkspaceIndex {
  private readonly entries = new Map<string, Entry>();
  /** Lower-level cache: canonical package name → PackageDefinition. */
  private packagesByName = new Map<string, PackageDefinition>();
  /** nickname / name (upper-cased) → canonical package name. */
  private packageAliases = new Map<string, string>();
  private dirty = true;

  setDocument(uri: string, text: string): DocumentIndex {
    const doc = parseDocument(uri, text);
    const index = indexDocument(doc);
    this.entries.set(uri, { doc, index });
    this.dirty = true;
    return index;
  }

  removeDocument(uri: string): void {
    this.entries.delete(uri);
    this.dirty = true;
  }

  getDocument(uri: string): Document | undefined {
    return this.entries.get(uri)?.doc;
  }

  getDocumentIndex(uri: string): DocumentIndex | undefined {
    return this.entries.get(uri)?.index;
  }

  private rebuildPackageTables(): void {
    this.packagesByName = new Map();
    this.packageAliases = new Map();
    for (const { index } of this.entries.values()) {
      for (const pkg of index.packages) {
        this.packagesByName.set(pkg.name, pkg);
        this.packageAliases.set(pkg.name, pkg.name);
        for (const nick of pkg.nicknames) {
          this.packageAliases.set(nick, pkg.name);
        }
      }
    }
    this.dirty = false;
  }

  private ensureFresh(): void {
    if (this.dirty) this.rebuildPackageTables();
  }

  /** Resolves a package designator (name or nickname) to a canonical name. */
  resolvePackageName(designator: string): string {
    this.ensureFresh();
    return this.packageAliases.get(designator) ?? designator;
  }

  /** All symbols across the workspace, with export status resolved. */
  allSymbols(): SymbolDefinition[] {
    this.ensureFresh();
    const result: SymbolDefinition[] = [];
    for (const { index } of this.entries.values()) {
      for (const sym of index.symbols) {
        result.push(this.withExportStatus(sym));
      }
    }
    return result;
  }

  symbolsInDocument(uri: string): SymbolDefinition[] {
    this.ensureFresh();
    const entry = this.entries.get(uri);
    if (!entry) return [];
    return entry.index.symbols.map((s) => this.withExportStatus(s));
  }

  private withExportStatus(sym: SymbolDefinition): SymbolDefinition {
    const pkg = this.packagesByName.get(sym.package);
    if (!pkg) return sym;
    const exported = pkg.exports.includes(sym.name);
    if (exported === sym.exported) return sym;
    return { ...sym, exported };
  }

  /** Resolves which package is current at an offset in a given document. */
  packageAt(uri: string, offset: number): string {
    const index = this.entries.get(uri)?.index;
    if (!index) return "COMMON-LISP-USER";
    return packageAtOffset(index, offset);
  }

  /**
   * Finds definitions matching a (possibly qualified) reference.
   *
   * Resolution order:
   *   1. exact package + name (package taken from the qualifier, or the
   *      current package of the reference site when unqualified);
   *   2. as a fallback, any symbol with the same print name in another
   *      package, so navigation still succeeds when package data is partial.
   */
  resolveReference(ref: QualifiedName, currentPackage: string): SymbolDefinition[] {
    this.ensureFresh();
    const targetPackage = ref.packagePrefix
      ? this.resolvePackageName(ref.packagePrefix)
      : this.resolvePackageName(currentPackage);

    const all = this.allSymbols();
    const exact = all.filter(
      (s) => s.name === ref.name && s.package === targetPackage,
    );
    if (exact.length > 0) return exact;

    return all.filter((s) => s.name === ref.name);
  }

  /** Case-insensitive substring search over symbol names (workspace/symbol). */
  searchSymbols(query: string): SymbolDefinition[] {
    this.ensureFresh();
    const needle = query.toUpperCase();
    const result: SymbolDefinition[] = [];
    for (const sym of this.allSymbols()) {
      if (needle.length === 0 || sym.name.toUpperCase().includes(needle)) {
        result.push(sym);
      }
    }
    return result;
  }

  get documentUris(): string[] {
    return [...this.entries.keys()];
  }
}
