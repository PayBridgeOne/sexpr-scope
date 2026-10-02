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
  Reference,
  ReferenceOccurrence,
  collectReferences,
} from "../model/reference";
import { LexicalBinding, LexicalBindingKind, Scope } from "../model/scope";
import { isLambdaListKeyword } from "../model/language";
import {
  CompletionCandidate,
  CompletionKind,
} from "../model/intelligence";
import {
  DIAGNOSTIC_SOURCE,
  DiagnosticInfo,
} from "../model/diagnostic";
import {
  completionContextAt,
  CompletionContext,
} from "../analyzer/completion-context";
import { findEnclosingList } from "../analyzer/form-context";
import { SignatureModel, buildSignature } from "../analyzer/signature";
import { isAtom, stripPrefixes } from "../parser/reader";
import {
  OccurrenceRole,
  ReferenceLocation,
  Resolution,
  ResolvedTarget,
  SemanticOccurrence,
  globalIdentityOf,
  builtinIdentityOf,
} from "../model/resolution";
import { analyzeScopes } from "../analyzer/scope-analyzer";
import {
  standardSymbolKind,
  standardSymbols,
  StandardSymbolKind,
  COMMON_LISP_PACKAGE,
} from "../model/standard-library";
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
  /**
   * Home package of every global definition, keyed by `uri\u0000offset` of its
   * name token. A bare definition name (e.g. `(defun save-record …)`) does not
   * necessarily intern a fresh symbol in the current package: Common Lisp reads
   * the symbol before the definer runs, so if the name is already accessible by
   * import, shadowing-import or inheritance it denotes that pre-existing symbol.
   * This map records the resulting identity so a definition and every reference
   * to it agree (Find References / Go to Definition across package identity).
   */
  private definitionHomes = new Map<string, string>();

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

    // Build the accessibility model once the alias table is known. `exportedNames`
    // is the union of each package's `:export` list and any definition flagged
    // exported; `definedNames` records the *home* package of every global
    // definition, which is computed below with a circularity-free first pass.
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
        const pkg = this.packagesByName.get(canonical);
        const exported = pkg ? pkg.exports.includes(sym.name) : sym.exported;
        if (exported) add(exportedNames, canonical, sym.name);
      }
    }

    // First pass: a resolver with *empty* `definedNames` so the "defined
    // directly" branch cannot fire. This lets us ask, for each raw definition
    // name, whether its source spelling already refers to an imported,
    // shadowing-imported, shadow or inherited symbol — i.e. its true home — the
    // way Common Lisp's reader would, without the circular assumption that every
    // unqualified definition interns a fresh symbol in the current package.
    const firstPass = new PackageResolver(
      this.packagesByName,
      this.packageAliases,
      new Map(),
      exportedNames,
    );
    this.definitionHomes = new Map<string, string>();
    for (const { index } of this.entries.values()) {
      for (const sym of index.symbols) {
        if (sym.scope !== BindingScope.Global) continue;
        const canonical = this.packageAliases.get(sym.package) ?? sym.package;
        const home = definitionHome(firstPass, canonical, sym.name);
        add(definedNames, home, sym.name);
        this.definitionHomes.set(
          definitionKey(sym.uri, sym.selectionRange.start.offset),
          home,
        );
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
    // Re-home the definition if its source name actually denotes a pre-existing
    // imported / shadowing-imported / inherited symbol (computed in the package
    // rebuild). The home determines both identity and export status so that a
    // definition and every reference to it agree.
    const home =
      this.definitionHomes.get(
        definitionKey(sym.uri, sym.selectionRange.start.offset),
      ) ?? canonical;
    const pkg = this.packagesByName.get(home);
    const exported = pkg
      ? pkg.exports.includes(sym.name)
      : home === canonical
        ? sym.exported
        : this.packageResolver.exports(home, sym.name);
    if (home === sym.package && exported === sym.exported) return sym;
    return { ...sym, package: home, exported };
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

    // A standardized COMMON-LISP symbol (mapcar, when, format, …) accessible in
    // the current package. This stays conservative: it only fires for names in
    // the static language catalog, and only where CL is actually accessible.
    const builtin = this.builtinTarget(ref, namespace, currentPackage, targetPackage);
    if (builtin) {
      return { node, role: OccurrenceRole.Reference, target: builtin };
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

  /**
   * Resolves a reference to a standardized `COMMON-LISP` symbol, if it names one
   * and `COMMON-LISP` is statically accessible from the reference's package. An
   * unqualified symbol requires the current package to inherit `CL`; a
   * `cl:`/`common-lisp:` qualifier names the standard package directly. The
   * Lisp-2 namespace is respected: functions/macros/special operators only
   * resolve in operator position, constants/variables only in value position.
   */
  private builtinTarget(
    ref: Reference,
    namespace: Namespace,
    currentPackage: string,
    targetPackage: string,
  ): ResolvedTarget | undefined {
    if (ref.packagePrefix) {
      if (targetPackage !== COMMON_LISP_PACKAGE) return undefined;
    } else if (!this.packageInheritsCommonLisp(currentPackage)) {
      return undefined;
    }
    const kind = standardSymbolKind(ref.name);
    if (!kind) return undefined;
    // Type specifiers only appear in declaration/quoted positions, which the
    // reference classifier does not distinguish; a bare value-position symbol is
    // almost never a type reference, so types are resolved conservatively (not
    // at all here) to avoid misclassifying ordinary variables like `condition`.
    if (kind === "type") return undefined;
    const callable =
      kind === "function" || kind === "macro" || kind === "special-operator";
    if (callable && namespace !== Namespace.Function) return undefined;
    if (!callable && namespace !== Namespace.Value) return undefined;
    return {
      kind: "builtin",
      identity: builtinIdentityOf(ref.name, namespace),
      namespace,
      name: ref.name,
      package: COMMON_LISP_PACKAGE,
      builtinKind: kind,
    };
  }

  /**
   * True when the standardized `COMMON-LISP` package is statically accessible
   * from `canonicalPkg`: it is `CL`/`CL-USER`, or a workspace package whose
   * `:use` list includes `COMMON-LISP`.
   */
  private packageInheritsCommonLisp(canonicalPkg: string): boolean {
    if (
      canonicalPkg === COMMON_LISP_PACKAGE ||
      canonicalPkg === "COMMON-LISP-USER"
    ) {
      return true;
    }
    const def = this.packagesByName.get(canonicalPkg);
    if (!def) return false;
    return def.uses.some(
      (u) => this.resolvePackageName(u) === COMMON_LISP_PACKAGE,
    );
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

  // ---------------------------------------------------------------------------
  // Completion, signature help and diagnostics.
  //
  // All three consume the same lexical/package model used for navigation, so
  // what completes and what a signature/diagnostic reports always matches what
  // resolves. None of them evaluates Lisp.
  // ---------------------------------------------------------------------------

  /**
   * Context-aware completion candidates at a source offset.
   *
   * Candidates are gathered from (in priority order) the visible lexical
   * environment, then package-accessible global symbols, filtered by the Lisp-2
   * namespace implied by the cursor position and by any package qualifier.
   * Completion is suppressed inside strings, comments and quoted data.
   */
  completions(uri: string, offset: number): CompletionCandidate[] {
    this.ensureFresh();
    const entry = this.entries.get(uri);
    if (!entry) return [];
    const ctx = completionContextAt(entry.doc, offset);
    if (!ctx) return [];

    const results: CompletionCandidate[] = [];
    const lexicalShadow = new Set<string>();

    // 1. Lexical bindings in scope (only for an unqualified token).
    if (!ctx.packagePrefix) {
      for (const b of entry.scope.visibleBindings(offset)) {
        if (b.namespace !== ctx.namespace) continue;
        if (!b.name.startsWith(ctx.prefix)) continue;
        const key = `${b.namespace}:${b.name}`;
        lexicalShadow.add(key);
        results.push(this.lexicalCandidate(b, ctx));
      }
    }

    // 2. Global symbols: qualified against a specific package, or unqualified
    //    through the package accessibility model for the current package.
    const chosen = new Map<string, { sym: SymbolDefinition; rank: number }>();
    const consider = (sym: SymbolDefinition, rank: number): void => {
      if (sym.scope !== BindingScope.Global) return;
      if (sym.namespace !== ctx.namespace) return;
      if (!sym.name.startsWith(ctx.prefix)) return;
      const gkey = `${sym.namespace}:${sym.package}:${sym.name}`;
      const prev = chosen.get(gkey);
      // Prefer a non-method definition (the generic) over its method impls.
      if (prev && (!prev.sym.methodImplementation || sym.methodImplementation)) {
        return;
      }
      chosen.set(gkey, { sym, rank });
    };

    if (ctx.packagePrefix) {
      const targetPackage = this.resolvePackageName(ctx.packagePrefix);
      const external = ctx.qualification === "external";
      for (const sym of this.allSymbols()) {
        if (sym.package !== targetPackage) continue;
        if (external && sym.exported !== true) continue;
        consider(sym, external ? 2 : 3);
      }
    } else {
      const currentPackage = this.packageAt(uri, offset);
      for (const sym of this.allSymbols()) {
        if (sym.scope !== BindingScope.Global) continue;
        if (lexicalShadow.has(`${sym.namespace}:${sym.name}`)) continue;
        const access = this.packageAccess(currentPackage, sym.name);
        if (access.status !== "present" && access.status !== "inherited") continue;
        if (access.homePackage !== sym.package) continue;
        consider(sym, rankForVia(access.via));
      }
    }

    for (const { sym, rank } of chosen.values()) {
      results.push(this.globalCandidate(sym, ctx, rank));
    }

    // 3. Standardized COMMON-LISP symbols (mapcar, when, format, …) accessible
    //    from here. These have no workspace definition but are valid completions;
    //    a workspace symbol of the same name/namespace already shown wins.
    const taken = new Set<string>(
      results.map((c) => `${c.namespace}:${c.label.toUpperCase()}`),
    );
    this.addStandardCompletions(ctx, uri, offset, taken, results);

    results.sort(
      (a, b) => a.sortRank - b.sortRank || a.label.localeCompare(b.label),
    );
    return results.slice(0, 300);
  }

  /**
   * Appends standardized `COMMON-LISP` symbols matching the completion context:
   * the right Lisp-2 namespace, the typed prefix, and static `CL` accessibility
   * (an unqualified token in a package that inherits `CL`, or a `cl:`/`cl::`
   * qualified token). Names already produced by a workspace symbol are skipped.
   */
  private addStandardCompletions(
    ctx: CompletionContext,
    uri: string,
    offset: number,
    taken: Set<string>,
    out: CompletionCandidate[],
  ): void {
    if (ctx.packagePrefix) {
      if (this.resolvePackageName(ctx.packagePrefix) !== COMMON_LISP_PACKAGE) {
        return;
      }
    } else if (!this.packageInheritsCommonLisp(this.packageAt(uri, offset))) {
      return;
    }
    for (const { name, kind } of standardSymbols()) {
      if (kind === "type") continue;
      const namespace = builtinNamespace(kind);
      if (namespace !== ctx.namespace) continue;
      if (!name.startsWith(ctx.prefix)) continue;
      const key = `${namespace}:${name}`;
      if (taken.has(key)) continue;
      taken.add(key);
      const label = downcaseName(name);
      out.push({
        label,
        insertText: label,
        kind: completionKindOfStandard(kind),
        namespace,
        package: COMMON_LISP_PACKAGE,
        detail: `${builtinKindText(kind)}  cl`,
        sortRank: 4,
        replaceRange: ctx.replaceRange,
      });
    }
  }

  private lexicalCandidate(
    b: LexicalBinding,
    ctx: CompletionContext,
  ): CompletionCandidate {
    const label = downcaseName(b.name);
    return {
      label,
      insertText: label,
      kind: completionKindOfLexical(b.bindingKind),
      namespace: b.namespace,
      detail: b.lambdaList
        ? `${lexicalKindText(b.bindingKind)} ${b.lambdaList}`
        : lexicalKindText(b.bindingKind),
      sortRank: 0,
      replaceRange: ctx.replaceRange,
    };
  }

  private globalCandidate(
    sym: SymbolDefinition,
    ctx: CompletionContext,
    rank: number,
  ): CompletionCandidate {
    const label = downcaseName(sym.name);
    const detailParts: string[] = [];
    if (sym.lambdaList) detailParts.push(sym.lambdaList);
    detailParts.push(downcaseName(sym.package));
    return {
      label,
      insertText: label,
      kind: completionKindOfSymbol(sym.kind),
      namespace: sym.namespace,
      package: sym.package,
      detail: detailParts.join("  "),
      documentation: sym.documentation,
      sortRank: rank,
      replaceRange: ctx.replaceRange,
    };
  }

  /**
   * Static signature help for the call enclosing a source offset.
   *
   * The lambda list is taken from the callable's definition (global function /
   * generic / macro, or a lexical `flet`/`labels` function) and presented as-is.
   * No macro is expanded and no running image is consulted.
   */
  signatureHelp(uri: string, offset: number): SignatureModel | undefined {
    this.ensureFresh();
    const entry = this.entries.get(uri);
    if (!entry) return undefined;
    const enclosing = findEnclosingList(entry.doc, offset);
    if (!enclosing || enclosing.data) return undefined;
    const list = enclosing.list;
    const headNode = stripPrefixes(list.children[0]);
    if (!headNode || !isAtom(headNode)) return undefined;
    // Only help once the operator has been typed and the cursor is in the args.
    if (offset <= headNode.range.end.offset) return undefined;

    const resolution = this.resolveAt(uri, headNode.range.start.offset);
    if (!resolution) return undefined;
    const target = resolution.target;

    let name: string;
    let lambdaList: string | undefined;
    let documentation: string | undefined;
    if (target.kind === "global") {
      const sym = target.symbols.find((s) => s.lambdaList) ?? target.symbols[0];
      if (!sym) return undefined;
      name = downcaseName(sym.name);
      lambdaList = sym.lambdaList;
      documentation = sym.documentation;
    } else if (target.kind === "lexical") {
      if (target.binding.namespace !== Namespace.Function) return undefined;
      name = downcaseName(target.binding.name);
      lambdaList = target.binding.lambdaList;
    } else {
      return undefined;
    }
    if (!lambdaList) return undefined;

    // Count complete argument forms before the cursor (children after the head).
    let activeArgument = 0;
    for (let i = 1; i < list.children.length; i++) {
      if (list.children[i].range.end.offset <= offset) activeArgument++;
      else break;
    }
    return buildSignature(name, lambdaList, activeArgument, documentation);
  }

  /**
   * Conservative static diagnostics for a document.
   *
   * Only issues that are safe to infer without a running Lisp image are emitted:
   * an unknown explicit package, an external `pkg:foo` reference to a symbol that
   * is defined in `pkg` but not exported, an ambiguously inherited symbol, and a
   * clearly invalid duplicate parameter / local-function binding. Unknown
   * functions/values are *never* reported — static analysis cannot prove them
   * invalid, so no diagnostic is preferred over a false positive.
   */
  diagnostics(uri: string): DiagnosticInfo[] {
    this.ensureFresh();
    const entry = this.entries.get(uri);
    if (!entry) return [];
    const out: DiagnosticInfo[] = [];

    for (const occ of entry.occurrences) {
      const ref = occ.reference;
      if (ref.context === ReferenceContext.Data) continue;
      const offset = occ.node.range.start.offset;
      if (entry.bindingByOffset.has(offset)) continue;
      if (entry.globalDefByOffset.has(offset)) continue;
      if (isLambdaListKeyword(ref.name)) continue;

      if (
        ref.packagePrefix &&
        (ref.qualification === "external" || ref.qualification === "internal")
      ) {
        const prefix = ref.packagePrefix;
        if (!this.packageResolver.knows(prefix)) {
          out.push({
            range: occ.node.range,
            message: `Unknown package ${downcaseName(prefix)}.`,
            severity: "warning",
            code: "unknown-package",
            source: DIAGNOSTIC_SOURCE,
          });
          continue;
        }
        if (
          ref.qualification === "external" &&
          this.packageResolver.defines(prefix, ref.name) &&
          !this.packageResolver.exports(prefix, ref.name)
        ) {
          out.push({
            range: occ.node.range,
            message: `${downcaseName(ref.name)} is not exported from ${downcaseName(prefix)}.`,
            severity: "warning",
            code: "not-exported",
            source: DIAGNOSTIC_SOURCE,
          });
        }
      } else if (ref.qualification === "none") {
        const access = this.packageAccess(this.packageAt(uri, offset), ref.name);
        if (access.status === "ambiguous") {
          out.push({
            range: occ.node.range,
            message: `${downcaseName(ref.name)} is inherited ambiguously from ${access.candidatePackages
              .map(downcaseName)
              .join(", ")}.`,
            severity: "warning",
            code: "ambiguous-symbol",
            source: DIAGNOSTIC_SOURCE,
          });
        }
      }
    }

    // Duplicate bindings, restricted to forms where repetition is unambiguously
    // invalid (parameters and local functions). LET/LET* variables are skipped
    // because `let*` legitimately rebinds the same name.
    const visitScope = (scope: Scope): void => {
      const seen = new Set<string>();
      for (const b of scope.bindings) {
        if (
          b.bindingKind !== LexicalBindingKind.Parameter &&
          b.bindingKind !== LexicalBindingKind.LocalFunction &&
          b.bindingKind !== LexicalBindingKind.LocalMacro
        ) {
          continue;
        }
        const key = `${b.namespace}:${b.name}`;
        if (seen.has(key)) {
          out.push({
            range: b.selectionRange,
            message: `Duplicate binding ${downcaseName(b.name)} in the same form.`,
            severity: "warning",
            code: "duplicate-binding",
            source: DIAGNOSTIC_SOURCE,
          });
        } else {
          seen.add(key);
        }
      }
      for (const child of scope.children) visitScope(child);
    };
    visitScope(entry.scope);

    out.sort(
      (a, b) =>
        a.range.start.line - b.range.start.line ||
        a.range.start.character - b.range.start.character,
    );
    return out;
  }
}

/** Stable key for a definition's name token (home-package lookup). */
function definitionKey(uri: string, offset: number): string {
  return `${uri}\u0000${offset}`;
}

/**
 * Determines the home package of a global definition named `name` written in
 * canonical package `currentPackage`, using a resolver whose `definedNames` is
 * empty (so the "defined directly" branch never fires). If the source spelling
 * is already accessible as an imported, shadowing-imported, shadow or inherited
 * symbol, that symbol's home is returned; otherwise the definition interns a
 * fresh symbol in the current package. Genuinely ambiguous names stay local
 * rather than guessing.
 */
function definitionHome(
  resolver: PackageResolver,
  currentPackage: string,
  name: string,
): string {
  const access = resolver.classify(currentPackage, name);
  if (access.status === "present" || access.status === "inherited") {
    return access.homePackage;
  }
  return currentPackage;
}

function rankForVia(via: string): number {
  switch (via) {
    case "definition":
    case "shadow":
      return 2;
    case "import":
    case "shadowing-import":
      return 3;
    default:
      return 4; // inheritance
  }
}

/** Downcases a canonical print name for insertion into typically-lowercase source. */
function downcaseName(name: string): string {
  return name.toLowerCase();
}

function lexicalKindText(kind: LexicalBindingKind): string {
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

function completionKindOfLexical(kind: LexicalBindingKind): CompletionKind {
  switch (kind) {
    case LexicalBindingKind.LocalFunction:
      return CompletionKind.LocalFunction;
    case LexicalBindingKind.LocalMacro:
      return CompletionKind.LocalMacro;
    case LexicalBindingKind.Parameter:
      return CompletionKind.Parameter;
    default:
      return CompletionKind.Variable;
  }
}

function completionKindOfSymbol(kind: SymbolKind): CompletionKind {
  switch (kind) {
    case SymbolKind.Function:
      return CompletionKind.Function;
    case SymbolKind.Macro:
      return CompletionKind.Macro;
    case SymbolKind.GenericFunction:
      return CompletionKind.GenericFunction;
    case SymbolKind.Method:
      return CompletionKind.Method;
    case SymbolKind.Class:
      return CompletionKind.Class;
    case SymbolKind.Struct:
      return CompletionKind.Struct;
    case SymbolKind.Condition:
      return CompletionKind.Class;
    case SymbolKind.Type:
      return CompletionKind.Type;
    case SymbolKind.Constant:
      return CompletionKind.Constant;
    case SymbolKind.Package:
      return CompletionKind.Package;
    case SymbolKind.Variable:
    case SymbolKind.Parameter:
      return CompletionKind.Variable;
  }
}

function namespaceMatches(ns: Namespace, wanted: ReferenceNamespace): boolean {
  if (wanted === "any") return true;
  return ns === wanted;
}

/** The Lisp-2 namespace a standardized symbol completes/resolves in. */
function builtinNamespace(kind: StandardSymbolKind): Namespace {
  switch (kind) {
    case "function":
    case "macro":
    case "special-operator":
      return Namespace.Function;
    default:
      return Namespace.Value;
  }
}

/** Completion-item classification for a standardized symbol. */
function completionKindOfStandard(kind: StandardSymbolKind): CompletionKind {
  switch (kind) {
    case "function":
      return CompletionKind.Function;
    case "macro":
    case "special-operator":
      return CompletionKind.Macro;
    case "type":
      return CompletionKind.Type;
    case "constant":
      return CompletionKind.Constant;
    case "variable":
      return CompletionKind.Variable;
  }
}

/** Short human label for a standardized symbol's category. */
function builtinKindText(kind: StandardSymbolKind): string {
  switch (kind) {
    case "special-operator":
      return "special operator";
    default:
      return kind;
  }
}
