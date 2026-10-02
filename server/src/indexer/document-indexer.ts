import {
  Document,
  ListNode,
  NodeKind,
  SyntaxNode,
  isAtom,
  isList,
  stripPrefixes,
} from "../parser/reader";
import { Range } from "../parser/position";
import {
  BindingScope,
  DEFAULT_PACKAGE,
  PackageDefinition,
  SymbolDefinition,
  SymbolKind,
  SymbolOrigin,
  canonicalizeName,
  namespaceOfKind,
  parseQualifiedName,
} from "../model/symbol";

/** Operator name (upper-cased) → kind of symbol it defines. */
const DEFINERS: ReadonlyMap<string, SymbolKind> = new Map([
  ["DEFUN", SymbolKind.Function],
  ["DEFMACRO", SymbolKind.Macro],
  ["DEFINE-COMPILER-MACRO", SymbolKind.Macro],
  ["DEFGENERIC", SymbolKind.GenericFunction],
  ["DEFMETHOD", SymbolKind.Method],
  ["DEFCLASS", SymbolKind.Class],
  ["DEFSTRUCT", SymbolKind.Struct],
  ["DEFVAR", SymbolKind.Variable],
  ["DEFPARAMETER", SymbolKind.Parameter],
  ["DEFCONSTANT", SymbolKind.Constant],
  ["DEFTYPE", SymbolKind.Type],
  ["DEFINE-CONDITION", SymbolKind.Condition],
]);

/** Kinds whose definition form carries a lambda list right after the name. */
const HAS_LAMBDA_LIST = new Set<SymbolKind>([
  SymbolKind.Function,
  SymbolKind.Macro,
  SymbolKind.GenericFunction,
  SymbolKind.Method,
  SymbolKind.Type,
]);

export interface PackageSegment {
  readonly offset: number;
  readonly packageName: string;
}

export interface DocumentIndex {
  readonly uri: string;
  readonly symbols: SymbolDefinition[];
  readonly packages: PackageDefinition[];
  /** In-package boundaries, sorted by offset; used to resolve references. */
  readonly packageSegments: PackageSegment[];
}

function rawText(doc: Document, range: Range): string {
  return doc.text.slice(range.start.offset, range.end.offset);
}

/** Resolves the head operator name of a list form, if it is a bare atom. */
function headName(form: ListNode): string | undefined {
  const head = stripPrefixes(form.children[0]);
  if (!isAtom(head)) return undefined;
  return parseQualifiedName(head.text).name;
}

/** Extracts a definition name node and the canonical name it introduces. */
function extractName(
  nameNode: SyntaxNode | undefined,
): { name: string; packagePrefix?: string; selection: Range } | undefined {
  const node = stripPrefixes(nameNode);
  if (!node) return undefined;

  if (isAtom(node)) {
    const q = parseQualifiedName(node.text);
    return { name: q.name, packagePrefix: q.packagePrefix, selection: node.range };
  }

  // A list name: either `(name options...)` (defstruct) or `(setf accessor)`.
  if (isList(node) && node.children.length > 0) {
    const first = stripPrefixes(node.children[0]);
    if (isAtom(first)) {
      const firstName = parseQualifiedName(first.text).name;
      if (firstName === "SETF" && node.children.length > 1) {
        const target = stripPrefixes(node.children[1]);
        if (isAtom(target)) {
          const q = parseQualifiedName(target.text);
          return {
            name: `(SETF ${q.name})`,
            packagePrefix: q.packagePrefix,
            selection: node.range,
          };
        }
      }
      const q = parseQualifiedName(first.text);
      return { name: q.name, packagePrefix: q.packagePrefix, selection: first.range };
    }
  }
  return undefined;
}

/** Finds the first list child at or after `fromIndex` (the lambda list). */
function firstListFrom(form: ListNode, fromIndex: number): ListNode | undefined {
  for (let i = fromIndex; i < form.children.length; i++) {
    const node = stripPrefixes(form.children[i]);
    if (isList(node)) return node as ListNode;
  }
  return undefined;
}

function firstStringFrom(form: ListNode, fromIndex: number): string | undefined {
  for (let i = fromIndex; i < form.children.length; i++) {
    const node = stripPrefixes(form.children[i]);
    if (node && node.kind === NodeKind.String) return node.value;
  }
  return undefined;
}

/** Looks for a `(:documentation "...")` option inside a form's body. */
function documentationOption(form: ListNode): string | undefined {
  for (const child of form.children) {
    const node = stripPrefixes(child);
    if (!isList(node)) continue;
    const key = stripPrefixes(node.children[0]);
    if (isAtom(key) && parseQualifiedName(key.text).name === "DOCUMENTATION") {
      const doc = stripPrefixes(node.children[1]);
      if (doc && doc.kind === NodeKind.String) return doc.value;
    }
  }
  return undefined;
}

function nameFromPackageDesignator(node: SyntaxNode | undefined): string | undefined {
  const inner = stripPrefixes(node);
  if (!inner) return undefined;
  if (isAtom(inner)) return parseQualifiedName(inner.text).name;
  if (inner.kind === NodeKind.String) return canonicalizeName(inner.value);
  return undefined;
}

function parseDefpackage(doc: Document, form: ListNode): PackageDefinition | undefined {
  const nameNode = stripPrefixes(form.children[1]);
  const name = nameFromPackageDesignator(nameNode);
  if (!name || !nameNode) return undefined;

  const nicknames: string[] = [];
  const uses: string[] = [];
  const exports: string[] = [];
  const imports: { from: string; name: string }[] = [];
  const shadows: string[] = [];
  const shadowingImports: { from: string; name: string }[] = [];

  for (let i = 2; i < form.children.length; i++) {
    const opt = stripPrefixes(form.children[i]);
    if (!isList(opt)) continue;
    const key = stripPrefixes(opt.children[0]);
    if (!isAtom(key)) continue;
    const keyName = parseQualifiedName(key.text).name;
    const values = opt.children.slice(1).map(nameFromPackageDesignator).filter(Boolean) as string[];
    switch (keyName) {
      case "NICKNAMES":
        nicknames.push(...values);
        break;
      case "USE":
        uses.push(...values);
        break;
      case "EXPORT":
        exports.push(...values);
        break;
      case "SHADOW":
        shadows.push(...values);
        break;
      case "IMPORT-FROM":
        // (:import-from <package> <symbol>...). The first designator names the
        // source package; the remainder are the imported symbols.
        if (values.length >= 2) {
          const from = values[0];
          for (const name of values.slice(1)) imports.push({ from, name });
        }
        break;
      case "SHADOWING-IMPORT-FROM":
        if (values.length >= 2) {
          const from = values[0];
          for (const name of values.slice(1)) {
            shadowingImports.push({ from, name });
          }
        }
        break;
      default:
        break;
    }
  }

  return {
    name,
    nicknames,
    uses,
    exports,
    imports,
    shadows,
    shadowingImports,
    uri: doc.uri,
    range: form.range,
    selectionRange: nameNode.range,
    documentation: documentationOption(form),
  };
}

/** Builds a static index for a single parsed document. */
export function indexDocument(doc: Document): DocumentIndex {
  const symbols: SymbolDefinition[] = [];
  const packages: PackageDefinition[] = [];
  const packageSegments: PackageSegment[] = [
    { offset: 0, packageName: DEFAULT_PACKAGE },
  ];
  const state = { currentPackage: DEFAULT_PACKAGE };

  for (const root of doc.roots) {
    // A `#+`/`#-` reader conditional guards its datum; index the guarded form
    // but mark anything it defines as conditional (uncertain under static
    // analysis). The feature expression itself is never interpreted — only its
    // raw text is preserved for future runtime reconciliation.
    if (root.kind === NodeKind.ReaderConditional) {
      if (root.child) {
        const feature = root.feature
          ? `${root.polarity}${rawText(doc, root.feature.range)}`
          : undefined;
        indexForm(doc, root.child, state, true, feature, symbols, packages, packageSegments);
      }
      continue;
    }
    indexForm(doc, root, state, false, undefined, symbols, packages, packageSegments);
  }

  return { uri: doc.uri, symbols, packages, packageSegments };
}

/** Indexes a single top-level form (possibly guarded by a reader conditional). */
function indexForm(
  doc: Document,
  node: SyntaxNode,
  state: { currentPackage: string },
  conditional: boolean,
  featureExpression: string | undefined,
  symbols: SymbolDefinition[],
  packages: PackageDefinition[],
  packageSegments: PackageSegment[],
): void {
  const form = stripPrefixes(node);
  if (!isList(form)) return;
  const op = headName(form);
  if (!op) return;

  if (op === "IN-PACKAGE") {
    const pkg = nameFromPackageDesignator(form.children[1]);
    // A conditional in-package must not silently rebind the current package for
    // following unconditional forms; only apply it unconditionally.
    if (pkg && !conditional) {
      state.currentPackage = pkg;
      packageSegments.push({ offset: form.range.start.offset, packageName: pkg });
    }
    return;
  }

  if (op === "DEFPACKAGE") {
    const pkg = parseDefpackage(doc, form);
    if (pkg) {
      packages.push(pkg);
      symbols.push({
        name: pkg.name,
        package: "KEYWORD",
        kind: SymbolKind.Package,
        namespace: namespaceOfKind(SymbolKind.Package),
        scope: BindingScope.Global,
        uri: doc.uri,
        range: pkg.range,
        selectionRange: pkg.selectionRange,
        documentation: pkg.documentation,
        conditional: conditional || undefined,
        featureExpression,
        origin: SymbolOrigin.Static,
      });
    }
    return;
  }

  const kind = DEFINERS.get(op);
  if (!kind) return;

  const extracted = extractName(form.children[1]);
  if (!extracted) return;

  // defmethod may carry qualifiers between the name and the lambda list.
  const lambdaList =
    HAS_LAMBDA_LIST.has(kind) && firstListFrom(form, 2)
      ? rawText(doc, firstListFrom(form, 2)!.range)
      : undefined;

  let documentation: string | undefined;
  if (
    kind === SymbolKind.Class ||
    kind === SymbolKind.Struct ||
    kind === SymbolKind.Condition
  ) {
    documentation = documentationOption(form);
  } else {
    // Functions/macros/generics/methods/types and variables/parameters/constants
    // all place a docstring after the name + lambda-list / value form.
    documentation = firstStringFrom(form, 3);
  }

  symbols.push({
    name: extracted.name,
    package: extracted.packagePrefix ?? state.currentPackage,
    kind,
    namespace: namespaceOfKind(kind),
    scope: BindingScope.Global,
    uri: doc.uri,
    range: form.range,
    selectionRange: extracted.selection,
    documentation,
    lambdaList,
    conditional: conditional || undefined,
    featureExpression,
    methodImplementation: kind === SymbolKind.Method ? true : undefined,
    origin: SymbolOrigin.Static,
  });
}

/** Resolves which package is current at a given offset within a document. */
export function packageAtOffset(index: DocumentIndex, offset: number): string {
  let current = DEFAULT_PACKAGE;
  for (const seg of index.packageSegments) {
    if (seg.offset <= offset) current = seg.packageName;
    else break;
  }
  return current;
}
