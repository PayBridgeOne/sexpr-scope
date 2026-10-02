import { Document, NodeKind, parseDocument } from "../parser/reader";
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
import {
  ReferenceContext,
  ReferenceOccurrence,
  collectReferences,
} from "../model/reference";
import { LexicalBinding, Scope } from "../model/scope";
import { isLambdaListKeyword } from "../model/language";
import {
  OccurrenceRole,
  ReferenceLocation,
  Resolution,
  ResolvedTarget,
  SemanticOccurrence,
  globalIdentityOf,
} from "../model/resolution";
import { analyzeScopes } from "../analyzer/scope-analyzer";
import {
  SemanticTokenInfo,
  classifyToken,
  isNumericToken,
  splitQualifiedRanges,
} from "../analyzer/token-classifier";
import { DocumentIndex, indexDocument, packageAtOffset } from "./document-indexer";
import { PackageResolver, PackageSymbolAccess } from "./package-resolver";

interface Entry {
  readonly doc: Document;
  readonly index: DocumentIndex;
  /** The document's lexical scope tree. */
  readonly scope: Scope;
  /** Every classified symbol occurrence in the document, in source order. */
  readonly occurrences: ReferenceOccurrence[];
  /** Lexical binding name-token start offset → binding (declaration lookup). */
  readonly bindingByOffset: Map<number, LexicalBinding>;
  /** Global definition name-token start offset → definition (declaration lookup). */
  readonly globalDefByOffset: Map<number, SymbolDefinition>;
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
  /** Package accessibility model (use/import/shadow/inheritance), rebuilt lazily. */
  private packageResolver = new PackageResolver(
    new Map(),
    new Map(),
    new Map(),
    new Map(),
  );
  private dirty = true;

  setDocument(uri: string, text: string): DocumentIndex {
    const doc = parseDocument(uri, text);
    const index = indexDocument(doc);
    const scope = analyzeScopes(doc);
    const occurrences = collectReferences(doc);

    const bindingByOffset = new Map<number, LexicalBinding>();
    for (const binding of scope.allBindings()) {
      bindingByOffset.set(binding.selectionRange.start.offset, binding);
    }
    const globalDefByOffset = new Map<number, SymbolDefinition>();
    for (const sym of index.symbols) {
      if (sym.scope === BindingScope.Global) {
        globalDefByOffset.set(sym.selectionRange.start.offset, sym);
      }
    }

    this.entries.set(uri, {
      doc,
      index,
      scope,
      occurrences,
      bindingByOffset,
      globalDefByOffset,
    });
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

    // Build the accessibility model once the alias table is known. `definedNames`
    // records the home package of every global definition; `exportedNames` is the
    // union of each package's `:export` list and any definition flagged exported.
    const definedNames = new Map<string, Set<string>>();
    const exportedNames = new Map<string, Set<string>>();
    const add = (map: Map<string, Set<string>>, pkg: string, name: string) => {
      let set = map.get(pkg);
      if (!set) map.set(pkg, (set = new Set()));
      set.add(name);
    };
    for (const pkg of this.packagesByName.values()) {
      for (const name of pkg.exports) add(exportedNames, pkg.name, name);
    }
    for (const { index } of this.entries.values()) {
      for (const sym of index.symbols) {
        if (sym.scope !== BindingScope.Global) continue;
        const canonical = this.packageAliases.get(sym.package) ?? sym.package;
        add(definedNames, canonical, sym.name);
        const pkg = this.packagesByName.get(canonical);
        const exported = pkg ? pkg.exports.includes(sym.name) : sym.exported;
        if (exported) add(exportedNames, canonical, sym.name);
      }
    }
    this.packageResolver = new PackageResolver(
      this.packagesByName,
      this.packageAliases,
      definedNames,
      exportedNames,
    );
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
    const wanted = options.namespace ?? "any";

    // An explicitly-qualified `pkg:foo` / `pkg::foo` reference names a symbol in
    // a specific package; external (single-colon) access requires it be exported.
    if (ref.packagePrefix) {
      const targetPackage = this.resolvePackageName(ref.packagePrefix);
      return this.selectDefinitions(
        ref.name,
        targetPackage,
        wanted,
        ref.qualification === "external",
      );
    }

    // An unqualified reference resolves through the package accessibility model
    // (direct definition, import, shadow, or inheritance from `:use`d packages).
    const access = this.packageResolver.classify(
      this.resolvePackageName(currentPackage),
      ref.name,
    );
    if (access.status === "ambiguous" || access.status === "none") return [];
    return this.selectDefinitions(
      ref.name,
      access.homePackage,
      wanted,
      access.requireExported,
    );
  }

  /**
   * Selects the global definitions of `name` in canonical `pkg` matching the
   * wanted namespace, applying the shared generic-over-method and
   * unconditional-over-conditional preferences.
   */
  private selectDefinitions(
    name: string,
    pkg: string,
    wanted: ReferenceNamespace,
    requireExported: boolean,
  ): SymbolDefinition[] {
    const inPackage = this.allSymbols().filter(
      (s) =>
        s.scope === BindingScope.Global &&
        s.name === name &&
        s.package === pkg &&
        namespaceMatches(s.namespace, wanted) &&
        (!requireExported || s.exported === true),
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

  /**
   * Exposes the package accessibility model for an unqualified print name in a
   * document position's current package. Completion, diagnostics and hover use
   * this instead of re-deriving Common Lisp package rules.
   */
  packageAccess(currentPackage: string, name: string): PackageSymbolAccess {
    this.ensureFresh();
    return this.packageResolver.classify(
      this.resolvePackageName(currentPackage),
      name,
    );
  }

  // ---------------------------------------------------------------------------
  // Unified semantic resolution.
  //
  // Go to Definition, Find References, Hover, semantic tokens and completion all
  // resolve through `classifyOccurrence` / `resolveAt` so they share one notion
  // of lexical and package identity rather than approximating Common Lisp
  // semantics independently (a wrong target is worse than none).
  // ---------------------------------------------------------------------------

  /** The document's lexical scope tree, if indexed. */
  getScope(uri: string): Scope | undefined {
    return this.entries.get(uri)?.scope;
  }

  /** Every classified symbol occurrence in a document, in source order. */
  occurrencesIn(uri: string): ReferenceOccurrence[] {
    return this.entries.get(uri)?.occurrences ?? [];
  }

  /**
   * Classifies one occurrence into a semantic target.
   *
   * Resolution order follows Common Lisp lexical scoping: a declaration name is
   * recognised first, then an unqualified reference is resolved against the
   * lexical environment (shadowing globals), and only then against the package /
   * global index. Data, keywords, uninterned and lambda-list keywords never
   * resolve to a binding.
   */
  private classifyOccurrence(
    uri: string,
    scope: Scope,
    occ: ReferenceOccurrence,
    bindingByOffset: Map<number, LexicalBinding>,
    globalDefByOffset: Map<number, SymbolDefinition>,
  ): SemanticOccurrence {
    const node = occ.node;
    const ref = occ.reference;
    const offset = node.range.start.offset;

    // A declaration: the binding/definition's own name token.
    const binding = bindingByOffset.get(offset);
    if (binding) {
      return {
        node,
        role: OccurrenceRole.Definition,
        target: { kind: "lexical", identity: binding.id, binding },
      };
    }
    const gdef = globalDefByOffset.get(offset);
    if (gdef) {
      // Canonicalize the package (e.g. CL-USER → COMMON-LISP-USER) so a
      // definition and its references share one global identity.
      const def = this.normalize(gdef);
      return {
        node,
        role: OccurrenceRole.Definition,
        target: {
          kind: "global",
          identity: globalIdentityOf(def.package, def.name, def.namespace),
          namespace: def.namespace,
          name: def.name,
          package: def.package,
          symbols: [def],
        },
      };
    }

    // Quoted/literal data and lambda-list keywords are not binding references.
    if (ref.context === ReferenceContext.Data || isLambdaListKeyword(ref.name)) {
      return { node, role: OccurrenceRole.Reference, target: { kind: "none" } };
    }

    const namespace =
      ref.context === ReferenceContext.Function
        ? Namespace.Function
        : Namespace.Value;

    // Lexical scope shadows globals, but only an unqualified symbol can name a
    // lexical binding (`pkg:foo` always denotes a package symbol).
    if (ref.qualification === "none") {
      const b = scope.resolve(offset, ref.name, namespace);
      if (b) {
        return {
          node,
          role: OccurrenceRole.Reference,
          target: { kind: "lexical", identity: b.id, binding: b },
        };
      }
    }

    // Keywords and uninterned symbols have no global definition to navigate to.
    if (ref.qualification === "keyword" || ref.qualification === "uninterned") {
      return { node, role: OccurrenceRole.Reference, target: { kind: "none" } };
    }

    const currentPackage = this.packageAt(uri, offset);
    const targetPackage = ref.packagePrefix
      ? this.resolvePackageName(ref.packagePrefix)
      : this.resolvePackageName(currentPackage);
    const defs = this.resolveReference(ref, currentPackage, { namespace });
    if (defs.length > 0) {
      const pkg = defs[0].package;
      return {
        node,
        role: OccurrenceRole.Reference,
        target: {
          kind: "global",
          identity: globalIdentityOf(pkg, ref.name, namespace),
          namespace,
          name: ref.name,
          package: pkg,
          symbols: defs,
        },
      };
    }

    // Well-formed but statically unknown: a stable identity still lets Find
    // References group equal uses, while Go to Definition yields no location.
    return {
      node,
      role: OccurrenceRole.Reference,
      target: {
        kind: "unresolved",
        identity: globalIdentityOf(targetPackage, ref.name, namespace),
        namespace,
        name: ref.name,
        package: targetPackage,
      },
    };
  }

  /** Classifies every occurrence in a document (shared by tokens/references). */
  classifyDocument(uri: string): SemanticOccurrence[] {
    this.ensureFresh();
    const entry = this.entries.get(uri);
    if (!entry) return [];
    return entry.occurrences.map((occ) =>
      this.classifyOccurrence(
        uri,
        entry.scope,
        occ,
        entry.bindingByOffset,
        entry.globalDefByOffset,
      ),
    );
  }

  /**
   * Produces semantic tokens for a document from the unified semantic model.
   *
   * Every token's type/modifiers come from the same `classifyOccurrence` result
   * that drives navigation, so highlighting never diverges from Go-to-Definition.
   * Numeric literals are skipped, and a package-qualified reference is split into
   * a `namespace` token for the prefix and a token for the symbol itself.
   */
  semanticTokens(uri: string): SemanticTokenInfo[] {
    this.ensureFresh();
    const entry = this.entries.get(uri);
    if (!entry) return [];
    const tokens: SemanticTokenInfo[] = [];
    for (const occ of entry.occurrences) {
      if (occ.node.kind !== NodeKind.Atom) continue;
      if (isNumericToken(occ.node.text)) continue;
      const semantic = this.classifyOccurrence(
        uri,
        entry.scope,
        occ,
        entry.bindingByOffset,
        entry.globalDefByOffset,
      );
      const cls = classifyToken(semantic, occ.reference);
      if (!cls) continue;
      const { packageRange, symbolRange } = splitQualifiedRanges(
        occ.node,
        occ.reference,
      );
      if (packageRange) {
        tokens.push({ range: packageRange, type: "namespace", modifiers: [] });
      }
      tokens.push({ range: symbolRange, type: cls.type, modifiers: cls.modifiers });
    }
    tokens.sort(
      (a, b) =>
        a.range.start.line - b.range.start.line ||
        a.range.start.character - b.range.start.character,
    );
    return tokens;
  }

  /** The occurrence whose atom spans `offset`, if any. */
  private occurrenceAt(
    entry: Entry,
    offset: number,
  ): ReferenceOccurrence | undefined {
    let found: ReferenceOccurrence | undefined;
    for (const occ of entry.occurrences) {
      const { start, end } = occ.node.range;
      if (offset >= start.offset && offset <= end.offset) found = occ;
    }
    return found;
  }

  /**
   * Resolves the symbol at a source offset to its semantic target. This is the
   * single entry point behind Go to Definition, Find References and Hover.
   */
  resolveAt(uri: string, offset: number): Resolution | undefined {
    this.ensureFresh();
    const entry = this.entries.get(uri);
    if (!entry) return undefined;
    const occ = this.occurrenceAt(entry, offset);
    if (!occ) return undefined;
    const semantic = this.classifyOccurrence(
      uri,
      entry.scope,
      occ,
      entry.bindingByOffset,
      entry.globalDefByOffset,
    );
    return { occurrence: semantic, target: semantic.target };
  }

  /**
   * Finds every reference to the symbol at a source offset.
   *
   * Lexical bindings are resolved within their own document and stay confined to
   * the binding's scope (two same-named `let` variables are distinct). Global
   * symbols are matched across the whole workspace by semantic identity, so a
   * generic function and its method call sites group together while an unrelated
   * same-named symbol in another package never does. `includeDeclaration`
   * controls whether the binding/definition site itself is included.
   */
  findReferences(
    uri: string,
    offset: number,
    includeDeclaration: boolean,
  ): ReferenceLocation[] {
    const resolution = this.resolveAt(uri, offset);
    if (!resolution) return [];
    const target = resolution.target;
    if (target.kind === "none") return [];
    const identity = target.identity;
    const results: ReferenceLocation[] = [];

    const collectFrom = (docUri: string, entry: Entry): void => {
      for (const occ of entry.occurrences) {
        const semantic = this.classifyOccurrence(
          docUri,
          entry.scope,
          occ,
          entry.bindingByOffset,
          entry.globalDefByOffset,
        );
        if (semantic.target.kind === "none") continue;
        if (semantic.target.identity !== identity) continue;
        if (semantic.role === OccurrenceRole.Definition && !includeDeclaration) {
          continue;
        }
        results.push({
          uri: docUri,
          range: semantic.node.range,
          role: semantic.role,
        });
      }
    };

    if (target.kind === "lexical") {
      // Lexical references never escape the binding's own document.
      const bindingUri = target.binding.uri;
      const entry = this.entries.get(bindingUri);
      if (entry) collectFrom(bindingUri, entry);
      return results;
    }

    // Global / unresolved: scan the workspace, pre-filtered by print name.
    const name = target.name;
    for (const [docUri, entry] of this.entries) {
      const hasName = entry.occurrences.some((o) => o.reference.name === name);
      if (!hasName) continue;
      collectFrom(docUri, entry);
    }
    return results;
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
