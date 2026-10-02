import { existsSync } from "fs";
import { fileURLToPath } from "url";
import { WorkspaceIndex } from "../indexer/workspace-index";
import { Document } from "../parser/reader";
import { Range } from "../parser/position";
import { parseAsdfFile } from "./parser";
import { buildComponentGraph } from "./graph";
import { computeAsdfDiagnostics } from "./diagnostics";
import { ComponentSource, inferComponentEdges } from "./inference";
import {
  AsdfComponent,
  AsdfDependencyEdge,
  AsdfDiagnostic,
  AsdfFile,
  AsdfReference,
  AsdfSystem,
  Certainty,
  DependencyConfidence,
  DependencyReason,
  walkComponents,
} from "./model";

/**
 * The ASDF project manager.
 *
 * It ties the pure ASDF modules together and is the single server-side owner of
 * ASDF project semantics. It discovers `.asd` documents from the shared
 * semantic index, parses them safely, correlates components with indexed source
 * files, merges declared / serial / inferred dependency edges, computes
 * diagnostics and produces a client-safe DTO.
 *
 * It *reads* the M2 {@link WorkspaceIndex} but never mutates it, and it is
 * editor-independent: nothing here depends on LSP or VS Code types.
 */

// ---------------------------------------------------------------------------
// client-safe DTO (LSP-style {line, character} ranges only)
// ---------------------------------------------------------------------------

export interface RangeDto {
  readonly start: { readonly line: number; readonly character: number };
  readonly end: { readonly line: number; readonly character: number };
}

export interface EvidenceDto {
  readonly description: string;
  readonly symbol?: string;
  readonly definedInUri?: string;
  readonly referencedInUri?: string;
}

export interface DependencyEdgeDto {
  readonly from: string;
  readonly to: string;
  readonly reason: DependencyReason;
  readonly confidence: DependencyConfidence;
  readonly evidence?: EvidenceDto;
}

export interface SystemDependencyDto {
  readonly name: string;
  readonly kind: "depends-on" | "defsystem-depends-on" | "weakly-depends-on";
  readonly certainty: Certainty;
  readonly range: RangeDto;
}

export interface ConditionDto {
  readonly message: string;
  readonly certainty: Certainty;
  readonly range?: RangeDto;
}

export interface ComponentDto {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly typeCertainty: Certainty;
  readonly certainty: Certainty;
  readonly serial: boolean;
  readonly pathname?: string;
  /** Resolved source URI when statically known. */
  readonly sourceUri?: string;
  /** True when the resolved source is present in the workspace index. */
  readonly mapped: boolean;
  readonly declarationRange: RangeDto;
  readonly nameRange?: RangeDto;
  readonly featureExpression?: string;
  readonly conditions: ConditionDto[];
  readonly children: ComponentDto[];
}

export interface SystemDto {
  readonly name: string;
  readonly nameCertainty: Certainty;
  readonly uri: string;
  readonly formRange: RangeDto;
  readonly nameRange?: RangeDto;
  readonly className?: string;
  readonly packageInferred: boolean;
  readonly serial: boolean;
  readonly description?: string;
  readonly version?: string;
  readonly author?: string;
  readonly maintainer?: string;
  readonly license?: string;
  readonly certainty: Certainty;
  readonly conditions: ConditionDto[];
  readonly systemDependencies: SystemDependencyDto[];
  readonly components: ComponentDto[];
  /** All component-level edges: declared, serial and inferred. */
  readonly componentEdges: DependencyEdgeDto[];
}

export interface DiagnosticDto {
  readonly uri: string;
  readonly range: RangeDto;
  readonly message: string;
  readonly severity: string;
  readonly code: string;
}

export interface AsdfProjectDto {
  readonly systems: SystemDto[];
  readonly diagnostics: DiagnosticDto[];
}

// ---------------------------------------------------------------------------
// internal analysis
// ---------------------------------------------------------------------------

export interface AsdfAnalysis {
  readonly files: AsdfFile[];
  readonly systems: AsdfSystem[];
  readonly componentById: Map<string, AsdfComponent>;
  readonly systemByName: Map<string, AsdfSystem>;
  readonly sourceByComponentId: Map<string, string>;
  readonly componentEdges: AsdfDependencyEdge[];
  readonly inferredEdges: AsdfDependencyEdge[];
  readonly diagnostics: AsdfDiagnostic[];
}

export interface AsdfProjectOptions {
  /** Whether a resolved source URI exists (defaults to an on-disk check). */
  readonly fileExists?: (uri: string) => boolean;
}

export class AsdfProject {
  constructor(
    private readonly index: WorkspaceIndex,
    private readonly options: AsdfProjectOptions = {},
  ) {}

  /** URIs of the `.asd` documents currently known to the index. */
  asdfUris(): string[] {
    return this.index.documentUris.filter((uri) => uri.toLowerCase().endsWith(".asd"));
  }

  private fileExists(uri: string): boolean {
    if (this.options.fileExists) return this.options.fileExists(uri);
    if (this.index.hasDocument(uri)) return true;
    try {
      const u = new URL(uri);
      if (u.protocol !== "file:") return false;
      return existsSync(fileURLToPath(u));
    } catch {
      return false;
    }
  }

  /** Builds the full project analysis from the current index state. */
  analyze(): AsdfAnalysis {
    const files: AsdfFile[] = [];
    for (const uri of this.asdfUris()) {
      const doc: Document | undefined = this.index.getDocument(uri);
      if (!doc) continue;
      files.push(parseAsdfFile(doc));
    }

    const systems = files.flatMap((f) => f.systems);
    const componentById = new Map<string, AsdfComponent>();
    const systemByName = new Map<string, AsdfSystem>();
    for (const sys of systems) {
      if (!systemByName.has(sys.name)) systemByName.set(sys.name, sys);
      walkComponents(sys.components, (c) => componentById.set(c.id, c));
    }

    // Correlate file components with indexed source documents.
    const sourceByComponentId = new Map<string, string>();
    const inferenceSources: ComponentSource[] = [];
    for (const sys of systems) {
      walkComponents(sys.components, (c) => {
        if (c.children.length > 0 || !c.effectiveUri) return;
        if (this.index.hasDocument(c.effectiveUri)) {
          sourceByComponentId.set(c.id, c.effectiveUri);
          inferenceSources.push({
            componentId: c.id,
            systemName: sys.name,
            uri: c.effectiveUri,
          });
        }
      });
    }

    const inferredEdges = inferComponentEdges({
      index: this.index,
      sources: inferenceSources,
    });

    const componentEdges: AsdfDependencyEdge[] = [];
    for (const sys of systems) {
      componentEdges.push(...buildComponentGraph(sys).edges);
    }
    componentEdges.push(...inferredEdges);

    const diagnostics = computeAsdfDiagnostics({
      systems,
      fileExists: (uri) => this.fileExists(uri),
    });

    return {
      files,
      systems,
      componentById,
      systemByName,
      sourceByComponentId,
      componentEdges,
      inferredEdges,
      diagnostics,
    };
  }

  /** Produces the client-safe DTO. */
  toDto(): AsdfProjectDto {
    const analysis = this.analyze();
    const systems = analysis.systems.map((sys) =>
      this.systemDto(sys, analysis),
    );
    const diagnostics = analysis.diagnostics.map((d) => ({
      uri: d.uri,
      range: toRangeDto(d.range),
      message: d.message,
      severity: d.severity,
      code: d.code,
    }));
    return { systems, diagnostics };
  }

  /** ASDF diagnostics grouped by the `.asd` URI they belong to. */
  diagnosticsByUri(): Map<string, AsdfDiagnostic[]> {
    const out = new Map<string, AsdfDiagnostic[]>();
    for (const uri of this.asdfUris()) out.set(uri, []);
    for (const d of this.analyze().diagnostics) {
      const list = out.get(d.uri) ?? [];
      list.push(d);
      out.set(d.uri, list);
    }
    return out;
  }

  private systemDto(sys: AsdfSystem, analysis: AsdfAnalysis): SystemDto {
    const sourceOf = analysis.sourceByComponentId;
    const systemDependencies: SystemDependencyDto[] = [
      ...sys.dependsOn.map((r) => systemDepDto(r, "depends-on")),
      ...sys.defsystemDependsOn.map((r) => systemDepDto(r, "defsystem-depends-on")),
      ...sys.weaklyDependsOn.map((r) => systemDepDto(r, "weakly-depends-on")),
    ];

    const componentIds = new Set<string>();
    walkComponents(sys.components, (c) => componentIds.add(c.id));
    const componentEdges = analysis.componentEdges
      .filter((e) => componentIds.has(e.from) || componentIds.has(e.to))
      .map(edgeDto);

    return {
      name: sys.name,
      nameCertainty: sys.nameCertainty,
      uri: sys.uri,
      formRange: toRangeDto(sys.formRange),
      nameRange: sys.nameRange ? toRangeDto(sys.nameRange) : undefined,
      className: sys.className,
      packageInferred: sys.packageInferred,
      serial: sys.serial,
      description: sys.description,
      version: sys.version,
      author: sys.author,
      maintainer: sys.maintainer,
      license: sys.license,
      certainty: sys.certainty,
      conditions: sys.conditions.map(conditionDto),
      systemDependencies,
      components: sys.components.map((c) => componentDto(c, sourceOf)),
      componentEdges,
    };
  }
}

// ---------------------------------------------------------------------------
// DTO helpers
// ---------------------------------------------------------------------------

function componentDto(
  comp: AsdfComponent,
  sourceOf: Map<string, string>,
): ComponentDto {
  const sourceUri = sourceOf.get(comp.id) ?? comp.effectiveUri;
  return {
    id: comp.id,
    name: comp.name,
    type: comp.type,
    typeCertainty: comp.typeCertainty,
    certainty: comp.certainty,
    serial: comp.serial,
    pathname: comp.pathname,
    sourceUri,
    mapped: sourceOf.has(comp.id),
    declarationRange: toRangeDto(comp.declarationRange),
    nameRange: comp.nameRange ? toRangeDto(comp.nameRange) : undefined,
    featureExpression: comp.featureExpression,
    conditions: comp.conditions.map(conditionDto),
    children: comp.children.map((c) => componentDto(c, sourceOf)),
  };
}

function edgeDto(edge: AsdfDependencyEdge): DependencyEdgeDto {
  return {
    from: edge.from,
    to: edge.to,
    reason: edge.reason,
    confidence: edge.confidence,
    evidence: edge.evidence
      ? {
          description: edge.evidence.description,
          symbol: edge.evidence.symbol,
          definedInUri: edge.evidence.definedInUri,
          referencedInUri: edge.evidence.referencedInUri,
        }
      : undefined,
  };
}

function systemDepDto(
  ref: AsdfReference,
  kind: SystemDependencyDto["kind"],
): SystemDependencyDto {
  return { name: ref.name, kind, certainty: ref.certainty, range: toRangeDto(ref.range) };
}

function conditionDto(c: { message: string; certainty: Certainty; range?: Range }): ConditionDto {
  return { message: c.message, certainty: c.certainty, range: c.range ? toRangeDto(c.range) : undefined };
}

function toRangeDto(range: Range): RangeDto {
  return {
    start: { line: range.start.line, character: range.start.character },
    end: { line: range.end.line, character: range.end.character },
  };
}
