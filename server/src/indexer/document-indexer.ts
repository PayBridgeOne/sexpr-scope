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
  PackageDefinition,
  SymbolDefinition,
  SymbolKind,
  SymbolOrigin,
  canonicalizeName,
  parseQualifiedName,
} from "../model/symbol";

const DEFAULT_PACKAGE = "COMMON-LISP-USER";

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
      default:
        break;
    }
  }

  return {
    name,
    nicknames,
    uses,
    exports,
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
  let currentPackage = DEFAULT_PACKAGE;

  for (const root of doc.roots) {
    const form = stripPrefixes(root);
    if (!isList(form)) continue;
    const op = headName(form);
    if (!op) continue;

    if (op === "IN-PACKAGE") {
      const pkg = nameFromPackageDesignator(form.children[1]);
      if (pkg) {
        currentPackage = pkg;
        packageSegments.push({ offset: form.range.start.offset, packageName: pkg });
      }
      continue;
    }

    if (op === "DEFPACKAGE") {
      const pkg = parseDefpackage(doc, form);
      if (pkg) {
        packages.push(pkg);
        symbols.push({
          name: pkg.name,
          package: "KEYWORD",
          kind: SymbolKind.Package,
          uri: doc.uri,
          range: pkg.range,
          selectionRange: pkg.selectionRange,
          documentation: pkg.documentation,
          origin: SymbolOrigin.Static,
        });
      }
      continue;
    }

    const kind = DEFINERS.get(op);
    if (!kind) continue;

    const extracted = extractName(form.children[1]);
    if (!extracted) continue;

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
    } else if (HAS_LAMBDA_LIST.has(kind)) {
      documentation = firstStringFrom(form, 3);
    } else {
      // Variables / parameters / constants: docstring after the value form.
      documentation = firstStringFrom(form, 3);
    }

    symbols.push({
      name: extracted.name,
      package: extracted.packagePrefix ?? currentPackage,
      kind,
      uri: doc.uri,
      range: form.range,
      selectionRange: extracted.selection,
      documentation,
      lambdaList,
      origin: SymbolOrigin.Static,
    });
  }

  return { uri: doc.uri, symbols, packages, packageSegments };
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
