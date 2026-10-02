import { Document, parseDocument } from "../parser/reader";
import {
  BUILTIN_PACKAGES,
  BindingScope,
  DEFAULT_PACKAGE,
  Namespace,
  PackageDefinition,
  QualifiedName,
  SymbolDefinition,
  SymbolKind,
} from "../model/symbol";
import { DocumentIndex, indexDocument, packageAtOffset } from "./document-indexer";

interface Entry {
  readonly doc: Document;
  readonly index: DocumentIndex;
}

/**
 * The namespace a reference requires, implied by its syntactic position.
 * `"any"` is used when the position does not disambiguate (e.g. a bare symbol
 * in data position); resolution then considers every namespace.
 */
export type ReferenceNamespace = Namespace | "any";

export interface ResolveOptions {
  /** Which namespace the reference occupies; defaults to considering any. */
  readonly namespace?: ReferenceNamespace;
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

  hasDocument(uri: string): boolean {
    return this.entries.has(uri);
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
    // Seed standard package identities first so `CL`/`CL-USER`/`KEYWORD` resolve
    // without any workspace `defpackage`. Workspace declarations are applied
    // afterwards and win on any collision, so users may still redeclare them.
    for (const builtin of BUILTIN_PACKAGES) {
      this.packageAliases.set(builtin.name, builtin.name);
      for (const nick of builtin.nicknames) {
        this.packageAliases.set(nick, builtin.name);
      }
    }
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

  /**
   * Returns a view of a symbol with its package canonicalized (nicknames mapped
   * to the defining package) and its export status resolved. Canonicalization
   * ensures a nickname-based `in-package` does not fork a symbol's identity.
   */
  private normalize(sym: SymbolDefinition): SymbolDefinition {
    if (sym.scope === BindingScope.Lexical) return sym;
    const canonical = this.packageAliases.get(sym.package) ?? sym.package;
    const pkg = this.packagesByName.get(canonical);
    const exported = pkg ? pkg.exports.includes(sym.name) : sym.exported;
    if (canonical === sym.package && exported === sym.exported) return sym;
    return { ...sym, package: canonical, exported };
  }

  /** All (normalized) symbols across the workspace. */
  allSymbols(): SymbolDefinition[] {
    this.ensureFresh();
    const result: SymbolDefinition[] = [];
    for (const { index } of this.entries.values()) {
      for (const sym of index.symbols) {
        result.push(this.normalize(sym));
      }
    }
    return result;
  }

  symbolsInDocument(uri: string): SymbolDefinition[] {
    this.ensureFresh();
    const entry = this.entries.get(uri);
    if (!entry) return [];
    return entry.index.symbols.map((s) => this.normalize(s));
  }

  /** Resolves which (canonical) package is current at an offset in a document. */
  packageAt(uri: string, offset: number): string {
    const index = this.entries.get(uri)?.index;
    if (!index) return DEFAULT_PACKAGE;
    return this.resolvePackageName(packageAtOffset(index, offset));
  }

  /**
   * Finds definitions matching a (possibly qualified) reference.
   *
   * Resolution is deliberately conservative: it uses the namespace implied by
   * the reference position and the current (canonical) package. It never falls
   * back to an arbitrary same-named symbol from an unrelated package — a wrong
   * Go-to-Definition target is worse than none.
   *
   * Package qualification is enforced, not merely parsed:
   *   - `pkg:foo`  (external) resolves only to a symbol *exported* from `pkg`;
   *   - `pkg::foo` (internal) resolves to any symbol in `pkg`;
   *   - `#:foo`    (uninterned) and `:foo` (keyword) have no global definition
   *     to navigate to and never resolve.
   *
   * Within the resolved package + namespace:
   *   1. a generic function definition is preferred, if present (methods are its
   *      implementations, not peer definitions);
   *   2. otherwise all matching definitions are returned.
   *
   * Conditional (`#+`/`#-` guarded) definitions are only returned when no
   * unconditional definition matches, since static analysis cannot know whether
   * their feature test holds.
   */
  resolveReference(
    ref: QualifiedName,
    currentPackage: string,
    options: ResolveOptions = {},
  ): SymbolDefinition[] {
    this.ensureFresh();
    // An uninterned symbol has no package and no global identity; a keyword
    // names itself. Neither can resolve to a workspace definition.
    if (ref.qualification === "uninterned" || ref.qualification === "keyword") {
      return [];
    }
    const targetPackage = ref.packagePrefix
      ? this.resolvePackageName(ref.packagePrefix)
      : this.resolvePackageName(currentPackage);
    const wanted = options.namespace ?? "any";

    const inPackage = this.allSymbols().filter(
      (s) =>
        s.scope === BindingScope.Global &&
        s.name === ref.name &&
        s.package === targetPackage &&
        namespaceMatches(s.namespace, wanted) &&
        // A single-colon `pkg:foo` reference must name an exported symbol.
        (ref.qualification !== "external" || s.exported === true),
    );
    if (inPackage.length === 0) return [];

    const unconditional = inPackage.filter((s) => !s.conditional);
    const candidates = unconditional.length > 0 ? unconditional : inPackage;

    // Prefer a generic function definition over its method implementations.
    const generics = candidates.filter(
      (s) => s.kind === SymbolKind.GenericFunction,
    );
    if (generics.length > 0) return generics;

    return candidates;
  }

  /** Method implementations (`defmethod`) for a function-namespace name. */
  methodsFor(name: string, pkg: string): SymbolDefinition[] {
    this.ensureFresh();
    const canonical = this.resolvePackageName(pkg);
    return this.allSymbols().filter(
      (s) => s.methodImplementation && s.name === name && s.package === canonical,
    );
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

function namespaceMatches(ns: Namespace, wanted: ReferenceNamespace): boolean {
  if (wanted === "any") return true;
  return ns === wanted;
}
