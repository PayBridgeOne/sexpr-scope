/**
 * Client-side mirror of the server's ASDF project DTO plus a pure transformation
 * from that DTO into a display tree.
 *
 * This module intentionally contains NO `vscode` imports and NO ASDF parsing: it
 * only reshapes the data the server already computed. Project semantics live in
 * the server; the extension merely renders them. Keeping this logic pure makes
 * the DTO → tree mapping unit-testable without a VS Code host.
 */

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
  readonly reason: string;
  readonly confidence: string;
  readonly evidence?: EvidenceDto;
}

export interface SystemDependencyDto {
  readonly name: string;
  readonly kind: string;
  readonly certainty: string;
  readonly range: RangeDto;
}

export interface ConditionDto {
  readonly message: string;
  readonly certainty: string;
  readonly range?: RangeDto;
}

export interface ComponentDto {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly typeCertainty: string;
  readonly certainty: string;
  readonly serial: boolean;
  readonly pathname?: string;
  readonly sourceUri?: string;
  readonly mapped: boolean;
  readonly declarationRange: RangeDto;
  readonly nameRange?: RangeDto;
  readonly featureExpression?: string;
  readonly conditions: ConditionDto[];
  readonly children: ComponentDto[];
}

export interface InferredSubsystemDto {
  readonly name: string;
  readonly uri: string;
  readonly packageName?: string;
  readonly certainty: string;
  readonly dependsOn: DependencyEdgeDto[];
}

export interface SystemDto {
  readonly name: string;
  readonly nameCertainty: string;
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
  readonly certainty: string;
  readonly conditions: ConditionDto[];
  readonly systemDependencies: SystemDependencyDto[];
  readonly components: ComponentDto[];
  readonly componentEdges: DependencyEdgeDto[];
  readonly inferredSubsystems: InferredSubsystemDto[];
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
// display tree
// ---------------------------------------------------------------------------

export type AsdfNodeKind =
  | "system"
  | "category"
  | "dependency"
  | "component"
  | "subsystem"
  | "message";

export interface AsdfLocation {
  readonly uri: string;
  readonly range?: RangeDto;
}

/** A single renderable node. Deliberately plain data (no `vscode` types). */
export interface AsdfTreeNode {
  readonly kind: AsdfNodeKind;
  readonly label: string;
  readonly description?: string;
  readonly tooltip?: string;
  /** ThemeIcon id used by the provider. */
  readonly icon?: string;
  /** Navigation target when the node is clicked. */
  readonly location?: AsdfLocation;
  readonly children: AsdfTreeNode[];
  readonly expandable: boolean;
}

/** Builds the "ASDF Systems" display tree from the server DTO. */
export function buildAsdfTree(dto: AsdfProjectDto): AsdfTreeNode[] {
  return dto.systems.map(systemNode);
}

function systemNode(system: SystemDto): AsdfTreeNode {
  const children: AsdfTreeNode[] = [];

  children.push(dependenciesCategory(system));
  children.push(componentsCategory(system));
  if (system.inferredSubsystems.length > 0) {
    children.push(subsystemsCategory(system));
  }

  const descriptors: string[] = [];
  if (system.className) descriptors.push(system.className);
  if (system.version) descriptors.push(`v${system.version}`);
  if (system.nameCertainty !== "known") descriptors.push(system.nameCertainty);

  return {
    kind: "system",
    label: system.name,
    description: descriptors.join(" · ") || undefined,
    tooltip: system.description,
    icon: "package",
    location: { uri: system.uri, range: system.nameRange ?? system.formRange },
    children,
    expandable: true,
  };
}

function dependenciesCategory(system: SystemDto): AsdfTreeNode {
  const deps = system.systemDependencies.map((dep) => ({
    kind: "dependency" as const,
    label: dep.name,
    description: dep.certainty === "known" ? dep.kind : `${dep.kind} · ${dep.certainty}`,
    icon: "library",
    location: { uri: system.uri, range: dep.range },
    children: [],
    expandable: false,
  }));
  return category("Dependencies", "references", deps, "No system dependencies");
}

function componentsCategory(system: SystemDto): AsdfTreeNode {
  const comps = system.components.map((c) => componentNode(system, c));
  return category("Components", "folder", comps, "No components");
}

function subsystemsCategory(system: SystemDto): AsdfTreeNode {
  const subs = system.inferredSubsystems.map((sub) => ({
    kind: "subsystem" as const,
    label: sub.name,
    description: sub.packageName
      ? `package ${sub.packageName}`
      : sub.certainty !== "known"
        ? sub.certainty
        : undefined,
    icon: "symbol-namespace",
    location: { uri: sub.uri },
    children: [],
    expandable: false,
  }));
  return category("Inferred Systems", "list-tree", subs, "No inferred systems");
}

function componentNode(system: SystemDto, component: ComponentDto): AsdfTreeNode {
  const children = component.children.map((c) => componentNode(system, c));
  const descriptors: string[] = [component.type];
  if (component.serial) descriptors.push("serial");
  if (component.featureExpression) descriptors.push(component.featureExpression);
  if (component.certainty !== "known") descriptors.push(component.certainty);

  // Navigate to the resolved source file when known; otherwise to the
  // component's declaration inside the `.asd`.
  const location: AsdfLocation = component.sourceUri
    ? { uri: component.sourceUri }
    : { uri: system.uri, range: component.nameRange ?? component.declarationRange };

  return {
    kind: "component",
    label: component.name,
    description: descriptors.join(" · "),
    tooltip: component.mapped ? component.sourceUri : undefined,
    icon: iconForComponent(component.type),
    location,
    children,
    expandable: children.length > 0,
  };
}

function category(
  label: string,
  icon: string,
  children: AsdfTreeNode[],
  emptyMessage: string,
): AsdfTreeNode {
  const resolved =
    children.length > 0
      ? children
      : [
          {
            kind: "message" as const,
            label: emptyMessage,
            children: [],
            expandable: false,
          },
        ];
  return {
    kind: "category",
    label: `${label} (${children.length})`,
    icon,
    children: resolved,
    expandable: true,
  };
}

function iconForComponent(type: string): string {
  switch (type) {
    case "module":
      return "folder";
    case "file":
      return "file-code";
    case "static-file":
      return "file";
    default:
      return "file-binary";
  }
}
