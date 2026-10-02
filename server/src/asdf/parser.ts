import { fileURLToPath, pathToFileURL } from "url";
import * as path from "path";
import {
  AtomNode,
  Document,
  ListNode,
  NodeKind,
  StringNode,
  SyntaxNode,
  isAtom,
  isList,
  stripPrefixes,
} from "../parser/reader";
import { Range } from "../parser/position";
import { parseQualifiedName } from "../model/symbol";
import {
  AsdfComponent,
  AsdfCondition,
  AsdfFile,
  AsdfReference,
  AsdfSystem,
  Certainty,
  componentId,
} from "./model";

/**
 * Safe, non-evaluating static extraction of ASDF `defsystem` declarations.
 *
 * SAFETY CONTRACT
 * ---------------
 * `.asd` files are untrusted executable Lisp. This module NEVER invokes READ,
 * LOAD, EVAL, COMPILE-FILE, `asdf:load-asd`, `asdf:find-system` or SBCL. It
 * consumes only the tolerant, non-evaluating syntax tree produced by
 * {@link parseDocument} and extracts literal, statically understandable
 * declarations. Anything computed, custom or guarded is surfaced as uncertain
 * (see {@link Certainty}) rather than guessed or evaluated.
 *
 * Arbitrary Lisp surrounding a `defsystem` must not break discovery, so the
 * scan descends ordinary forms looking for `defsystem` while skipping quoted
 * data and read-time-evaluation prefixes entirely.
 */

/** Operators (by print name) that declare an ASDF system. */
const DEFSYSTEM_OPERATORS = new Set(["DEFSYSTEM"]);

/** Component type keywords M3 understands precisely. */
const KNOWN_FILE_TYPES = new Set(["FILE", "CL-SOURCE-FILE", "CL-SOURCE-FILE.CL"]);

export function parseAsdfFile(doc: Document): AsdfFile {
  const systems: AsdfSystem[] = [];
  const asdPath = fsPathFromUri(doc.uri);
  // Component paths resolve relative to the directory containing the `.asd`.
  const baseDir = asdPath !== undefined ? path.dirname(asdPath) : undefined;

  const scan = (node: SyntaxNode, feature: string | undefined): void => {
    switch (node.kind) {
      case NodeKind.ReaderConditional: {
        // A `#+`/`#-` guard: the system is present but conditionally active.
        const guard = readerConditionalFeature(doc, node);
        if (node.child) scan(node.child, combineFeature(feature, guard));
        return;
      }
      case NodeKind.List:
      case NodeKind.Vector: {
        const op = headName(node);
        if (op && DEFSYSTEM_OPERATORS.has(op)) {
          const system = parseDefsystem(doc, node, baseDir, feature);
          if (system) systems.push(system);
          return; // do not re-scan the system body for more systems
        }
        // Arbitrary surrounding Lisp: descend to find a nested defsystem.
        for (const child of node.children) scan(child, feature);
        return;
      }
      default:
        // Atoms, strings, quoted/prefixed data and discards never declare a
        // system (a quoted or `#.`-prefixed form is inert data here).
        return;
    }
  };

  for (const root of doc.roots) scan(root, undefined);
  return { uri: doc.uri, systems };
}

// ---------------------------------------------------------------------------
// defsystem
// ---------------------------------------------------------------------------

function parseDefsystem(
  doc: Document,
  form: ListNode,
  baseDir: string | undefined,
  feature: string | undefined,
): AsdfSystem | undefined {
  const nameNode = stripPrefixes(form.children[1]);
  if (!nameNode) return undefined;
  const nameInfo = coerceName(doc, nameNode);
  if (!nameInfo) return undefined;

  const conditions: AsdfCondition[] = [];
  if (nameInfo.certainty !== Certainty.Known) {
    conditions.push({
      message: "System name is computed dynamically and cannot be modeled statically.",
      certainty: Certainty.Dynamic,
      range: nameNode.range,
    });
  }

  let className: string | undefined;
  let packageInferred = false;
  let pathname: string | undefined;
  let serial = false;
  let components: AsdfComponent[] = [];
  let dependsOn: AsdfReference[] = [];
  let defsystemDependsOn: AsdfReference[] = [];
  let weaklyDependsOn: AsdfReference[] = [];
  let description: string | undefined;
  let version: string | undefined;
  let author: string | undefined;
  let maintainer: string | undefined;
  let license: string | undefined;
  let defaultComponentClass: string | undefined;
  let ifFeature: string | undefined;

  const systemDir = baseDir;

  for (const opt of collectOptions(form, 2)) {
    const value = opt.valueNode ? stripPrefixes(opt.valueNode) : undefined;
    switch (opt.key) {
      case "DESCRIPTION":
        description = literalString(value);
        break;
      case "VERSION":
        version = literalString(value);
        break;
      case "AUTHOR":
        author = literalString(value);
        break;
      case "MAINTAINER":
        maintainer = literalString(value);
        break;
      case "LICENSE":
      case "LICENCE":
        license = literalString(value);
        break;
      case "CLASS": {
        const c = value ? coerceName(doc, value) : undefined;
        className = c?.name;
        packageInferred = className === "package-inferred-system";
        break;
      }
      case "PATHNAME":
        pathname = literalString(value);
        break;
      case "SERIAL": {
        const b = parseBoolean(value);
        serial = b.value;
        if (!b.known && opt.valueNode) {
          conditions.push({
            message: ":serial value is not a literal t/nil; treated as nil.",
            certainty: Certainty.Dynamic,
            range: opt.valueNode.range,
          });
        }
        break;
      }
      case "DEPENDS-ON":
        dependsOn = parseReferences(doc, value, undefined);
        break;
      case "DEFSYSTEM-DEPENDS-ON":
        defsystemDependsOn = parseReferences(doc, value, undefined);
        break;
      case "WEAKLY-DEPENDS-ON":
        weaklyDependsOn = parseReferences(doc, value, undefined);
        break;
      case "DEFAULT-COMPONENT-CLASS": {
        const c = value ? coerceName(doc, value) : undefined;
        defaultComponentClass = c?.name;
        break;
      }
      case "IF-FEATURE":
        ifFeature = value ? rawText(doc, value.range) : undefined;
        break;
      default:
        break;
    }
  }

  const effectiveFeature = combineFeature(feature, ifFeature);
  const resolvedDir = effectiveSystemDir(systemDir, pathname);

  for (const opt of collectOptions(form, 2)) {
    if (opt.key !== "COMPONENTS") continue;
    const value = opt.valueNode ? stripPrefixes(opt.valueNode) : undefined;
    components = parseComponents(
      doc,
      value,
      nameInfo.name,
      undefined,
      resolvedDir,
      defaultComponentClass,
      effectiveFeature,
      conditions,
    );
  }

  const certainty = combineCertainty(
    nameInfo.certainty,
    effectiveFeature ? Certainty.Conditional : Certainty.Known,
    packageInferred ? Certainty.Known : Certainty.Known,
  );

  return {
    name: nameInfo.name,
    nameCertainty: nameInfo.certainty,
    uri: doc.uri,
    formRange: form.range,
    nameRange: nameNode.range,
    className,
    packageInferred,
    pathname,
    serial,
    dependsOn,
    defsystemDependsOn,
    weaklyDependsOn,
    components,
    description,
    version,
    author,
    maintainer,
    license,
    defaultComponentClass,
    featureExpression: effectiveFeature,
    certainty,
    conditions,
  };
}

// ---------------------------------------------------------------------------
// components
// ---------------------------------------------------------------------------

function parseComponents(
  doc: Document,
  listNode: SyntaxNode | undefined,
  system: string,
  parentId: string | undefined,
  parentDir: string | undefined,
  defaultClass: string | undefined,
  parentFeature: string | undefined,
  systemConditions: AsdfCondition[],
): AsdfComponent[] {
  if (!listNode || !isList(listNode)) {
    if (listNode) {
      systemConditions.push({
        message: ":components is not a literal list; its members cannot be modeled.",
        certainty: Certainty.Dynamic,
        range: listNode.range,
      });
    }
    return [];
  }

  const out: AsdfComponent[] = [];
  for (const raw of listNode.children) {
    let feature = parentFeature;
    let node: SyntaxNode | undefined = raw;
    if (node.kind === NodeKind.ReaderConditional) {
      feature = combineFeature(parentFeature, readerConditionalFeature(doc, node));
      node = node.child;
    }
    node = stripPrefixes(node);
    if (!node) continue;
    if (!isList(node)) {
      // A bare name as a component is `package-inferred-system`-ish shorthand we
      // do not model here; surface it as uncertain rather than inventing a file.
      systemConditions.push({
        message: "Non-list component entry is not statically modeled.",
        certainty: Certainty.Unsupported,
        range: node.range,
      });
      continue;
    }
    const comp = parseComponent(
      doc,
      node,
      system,
      parentId,
      parentDir,
      defaultClass,
      feature,
    );
    if (comp) out.push(comp);
  }
  return out;
}

function parseComponent(
  doc: Document,
  form: ListNode,
  system: string,
  parentId: string | undefined,
  parentDir: string | undefined,
  defaultClass: string | undefined,
  feature: string | undefined,
): AsdfComponent | undefined {
  const typeInfo = componentType(stripPrefixes(form.children[0]), defaultClass);
  const nameNode = stripPrefixes(form.children[1]);
  const nameInfo = nameNode ? coerceName(doc, nameNode) : undefined;
  const conditions: AsdfCondition[] = [];

  const name = nameInfo?.name ?? "";
  const nameCertainty = nameInfo?.certainty ?? Certainty.Unknown;
  const id = componentId(system, parentId, name);

  let serial = false;
  let pathname: string | undefined;
  let dependsOn: AsdfReference[] = [];
  let ifFeature: string | undefined;
  let componentsNode: SyntaxNode | undefined;

  for (const opt of collectOptions(form, 2)) {
    const value = opt.valueNode ? stripPrefixes(opt.valueNode) : undefined;
    switch (opt.key) {
      case "PATHNAME":
        pathname = literalString(value);
        break;
      case "SERIAL": {
        const b = parseBoolean(value);
        serial = b.value;
        break;
      }
      case "DEPENDS-ON":
        dependsOn = parseReferences(doc, value, undefined);
        break;
      case "IF-FEATURE":
        ifFeature = value ? rawText(doc, value.range) : undefined;
        break;
      case "COMPONENTS":
        componentsNode = value;
        break;
      default:
        break;
    }
  }

  if (nameCertainty !== Certainty.Known && nameNode) {
    conditions.push({
      message: "Component name is computed dynamically.",
      certainty: Certainty.Dynamic,
      range: nameNode.range,
    });
  }

  const effectiveFeature = combineFeature(feature, ifFeature);
  const effectivePath = componentEffectivePath(
    parentDir,
    typeInfo,
    name,
    nameCertainty,
    pathname,
  );
  const effectiveUri =
    effectivePath !== undefined ? uriFromFsPath(effectivePath) : undefined;

  // A module's children resolve relative to the module's own directory.
  const childDir =
    typeInfo.type === "module" ? effectivePath ?? undefined : undefined;

  const children =
    componentsNode !== undefined
      ? parseComponents(
          doc,
          componentsNode,
          system,
          id,
          childDir,
          defaultClass,
          effectiveFeature,
          conditions,
        )
      : [];

  const certainty = combineCertainty(
    typeInfo.certainty,
    nameCertainty,
    effectiveFeature ? Certainty.Conditional : Certainty.Known,
  );

  return {
    id,
    name,
    type: typeInfo.type,
    typeCertainty: typeInfo.certainty,
    system,
    parentId,
    declarationRange: form.range,
    nameRange: nameNode?.range,
    pathname,
    effectiveUri,
    serial,
    dependsOn,
    children,
    certainty,
    featureExpression: effectiveFeature,
    conditions,
  };
}

interface ComponentTypeInfo {
  readonly type: string;
  readonly certainty: Certainty;
  /** Default source-file extension, for file-like components. */
  readonly extension?: string;
  /** Whether the component is a directory (module). */
  readonly isModule: boolean;
  /** Whether the component maps to a file whose path can be resolved. */
  readonly isFile: boolean;
  /** Whether the name is expected to already carry its extension. */
  readonly nameCarriesExtension: boolean;
}

function componentType(
  head: SyntaxNode | undefined,
  defaultClass: string | undefined,
): ComponentTypeInfo {
  const keyword =
    head && isAtom(head) ? parseQualifiedName(head.text).name : undefined;
  const typeName = keyword ? keyword.toLowerCase() : (defaultClass ?? "");

  switch ((keyword ?? "").toUpperCase()) {
    case "MODULE":
      return { type: "module", certainty: Certainty.Known, isModule: true, isFile: false, nameCarriesExtension: false };
    case "FILE":
    case "CL-SOURCE-FILE":
      return { type: typeName, certainty: Certainty.Known, extension: "lisp", isModule: false, isFile: true, nameCarriesExtension: false };
    case "CL-SOURCE-FILE.CL":
      return { type: typeName, certainty: Certainty.Known, extension: "cl", isModule: false, isFile: true, nameCarriesExtension: false };
    case "STATIC-FILE":
      return { type: "static-file", certainty: Certainty.Known, isModule: false, isFile: true, nameCarriesExtension: true };
    case "":
      // No literal type keyword — opaque.
      return { type: typeName || "unknown", certainty: Certainty.Unknown, isModule: false, isFile: false, nameCarriesExtension: false };
    default:
      // A custom/unknown component class: represented, but its build semantics
      // (and therefore its on-disk path) are not understood. Never fabricate.
      return { type: typeName, certainty: Certainty.Unknown, isModule: false, isFile: false, nameCarriesExtension: false };
  }
}

// ---------------------------------------------------------------------------
// references (:depends-on, :defsystem-depends-on, …)
// ---------------------------------------------------------------------------

function parseReferences(
  doc: Document,
  listNode: SyntaxNode | undefined,
  parentFeature: string | undefined,
): AsdfReference[] {
  if (!listNode) return [];
  const node = stripPrefixes(listNode);
  if (!node || !isList(node)) {
    // A single bare dependency designator or a computed value.
    if (node && (isAtom(node) || node.kind === NodeKind.String)) {
      const ref = referenceFromNode(doc, node, parentFeature);
      return ref ? [ref] : [];
    }
    return [];
  }
  const out: AsdfReference[] = [];
  for (const raw of node.children) {
    let feature = parentFeature;
    let child: SyntaxNode | undefined = raw;
    if (child.kind === NodeKind.ReaderConditional) {
      feature = combineFeature(parentFeature, readerConditionalFeature(doc, child));
      child = child.child;
    }
    child = stripPrefixes(child);
    if (!child) continue;
    const ref = referenceFromNode(doc, child, feature);
    if (ref) out.push(ref);
  }
  return out;
}

function referenceFromNode(
  doc: Document,
  node: SyntaxNode,
  feature: string | undefined,
): AsdfReference | undefined {
  if (isAtom(node) || node.kind === NodeKind.String) {
    const info = coerceName(doc, node);
    if (!info) return undefined;
    return {
      name: info.name,
      range: node.range,
      certainty: feature ? Certainty.Conditional : info.certainty,
      featureExpression: feature,
    };
  }
  if (isList(node)) {
    const head = stripPrefixes(node.children[0]);
    const key = head && isAtom(head) ? parseQualifiedName(head.text).name : undefined;
    if (key === "VERSION" || key === "REQUIRE") {
      const target = stripPrefixes(node.children[1]);
      const info = target ? coerceName(doc, target) : undefined;
      if (info) {
        return {
          name: info.name,
          range: (target ?? node).range,
          certainty: feature ? Certainty.Conditional : info.certainty,
          featureExpression: feature,
        };
      }
    }
    if (key === "FEATURE") {
      // (:feature <feature-expr> <dependency>): the dependency is conditional.
      const featureExpr = node.children[1]
        ? rawText(doc, node.children[1].range)
        : undefined;
      const target = stripPrefixes(node.children[2]);
      const info = target ? coerceName(doc, target) : undefined;
      if (info) {
        return {
          name: info.name,
          range: (target ?? node).range,
          certainty: Certainty.Conditional,
          featureExpression: combineFeature(feature, featureExpr),
        };
      }
    }
  }
  // A computed / unrecognized dependency designator: keep it visible but opaque.
  return {
    name: rawText(doc, node.range),
    range: node.range,
    certainty: Certainty.Dynamic,
    featureExpression: feature,
  };
}

// ---------------------------------------------------------------------------
// effective paths
// ---------------------------------------------------------------------------

function effectiveSystemDir(
  baseDir: string | undefined,
  pathname: string | undefined,
): string | undefined {
  if (baseDir === undefined) return undefined;
  if (pathname === undefined) return baseDir;
  return path.resolve(baseDir, pathname);
}

function componentEffectivePath(
  parentDir: string | undefined,
  type: ComponentTypeInfo,
  name: string,
  nameCertainty: Certainty,
  pathname: string | undefined,
): string | undefined {
  if (parentDir === undefined) return undefined;
  if (nameCertainty !== Certainty.Known && pathname === undefined) return undefined;

  if (type.isModule) {
    const sub = pathname ?? name;
    if (!sub) return undefined;
    return path.resolve(parentDir, sub);
  }
  if (type.isFile) {
    let base = pathname ?? name;
    if (!base) return undefined;
    if (!type.nameCarriesExtension && type.extension && path.extname(base) === "") {
      base = `${base}.${type.extension}`;
    }
    return path.resolve(parentDir, base);
  }
  // Custom/unknown component type: do not fabricate a path.
  return undefined;
}

// ---------------------------------------------------------------------------
// primitives
// ---------------------------------------------------------------------------

interface SystemOption {
  readonly key: string;
  readonly keyRange: Range;
  readonly valueNode?: SyntaxNode;
}

/** Iterates `:key value :key value …` option pairs from a form. */
function collectOptions(form: ListNode, startIndex: number): SystemOption[] {
  const out: SystemOption[] = [];
  const children = form.children;
  for (let i = startIndex; i < children.length; i++) {
    const keyNode = stripPrefixes(children[i]);
    if (!keyNode || !isAtom(keyNode)) continue;
    const q = parseQualifiedName(keyNode.text);
    if (q.qualification !== "keyword") continue;
    const valueNode = i + 1 < children.length ? children[i + 1] : undefined;
    out.push({ key: q.name, keyRange: keyNode.range, valueNode });
    i++; // consume the value
  }
  return out;
}

interface NameInfo {
  readonly name: string;
  readonly certainty: Certainty;
}

/**
 * Coerces a name node into ASDF's `coerce-name` form: a string literal is kept
 * verbatim; a symbol/keyword is downcased. Any computed form is dynamic.
 */
function coerceName(doc: Document, node: SyntaxNode): NameInfo | undefined {
  const inner = stripPrefixes(node);
  if (!inner) return undefined;
  if (inner.kind === NodeKind.String) {
    return { name: (inner as StringNode).value, certainty: Certainty.Known };
  }
  if (isAtom(inner)) {
    return {
      name: parseQualifiedName((inner as AtomNode).text).name.toLowerCase(),
      certainty: Certainty.Known,
    };
  }
  return { name: rawText(doc, inner.range), certainty: Certainty.Dynamic };
}

/** A string literal's value, or undefined when the node is not a literal string. */
function literalString(node: SyntaxNode | undefined): string | undefined {
  if (node && node.kind === NodeKind.String) return (node as StringNode).value;
  return undefined;
}

/** Parses a literal `t`/`nil` boolean. Non-literals are reported as unknown. */
function parseBoolean(node: SyntaxNode | undefined): { value: boolean; known: boolean } {
  if (node && isAtom(node)) {
    const n = parseQualifiedName(node.text).name;
    if (n === "T") return { value: true, known: true };
    if (n === "NIL") return { value: false, known: true };
  }
  if (node && isList(node) && node.children.length === 0) {
    return { value: false, known: true }; // `()` is NIL
  }
  return { value: false, known: false };
}

/** Upper-cased operator name of a list head, if it is a bare atom. */
function headName(form: ListNode): string | undefined {
  const head = stripPrefixes(form.children[0]);
  if (!head || !isAtom(head)) return undefined;
  return parseQualifiedName(head.text).name;
}

function rawText(doc: Document, range: Range): string {
  return doc.text.slice(range.start.offset, range.end.offset);
}

/** Builds the raw feature text for a `#+`/`#-` reader-conditional node. */
function readerConditionalFeature(
  doc: Document,
  node: Extract<SyntaxNode, { kind: NodeKind.ReaderConditional }>,
): string {
  const feat = node.feature ? rawText(doc, node.feature.range) : "";
  return `#${node.polarity}${feat}`;
}

/** Combines nested feature guards into one expression for display. */
function combineFeature(
  outer: string | undefined,
  inner: string | undefined,
): string | undefined {
  if (outer && inner) return `${outer} ${inner}`;
  return outer ?? inner;
}

const CERTAINTY_RANK: Record<Certainty, number> = {
  [Certainty.Known]: 0,
  [Certainty.Conditional]: 1,
  [Certainty.Unknown]: 2,
  [Certainty.Unsupported]: 3,
  [Certainty.Dynamic]: 4,
};

/** Combines certainties by taking the most uncertain. */
function combineCertainty(...values: Certainty[]): Certainty {
  let worst = Certainty.Known;
  for (const v of values) {
    if (CERTAINTY_RANK[v] > CERTAINTY_RANK[worst]) worst = v;
  }
  return worst;
}

function fsPathFromUri(uri: string): string | undefined {
  try {
    const u = new URL(uri);
    if (u.protocol !== "file:") return undefined;
    return fileURLToPath(u);
  } catch {
    return undefined;
  }
}

/** Encodes an already-absolute fs path as a `file:` URI (matches the index). */
function uriFromFsPath(fsPath: string): string {
  return pathToFileURL(fsPath).href;
}
