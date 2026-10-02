import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AsdfProjectDto,
  AsdfTreeNode,
  buildAsdfTree,
} from "../src/asdfModel";

/**
 * Extension-side unit tests for the pure DTO → tree transformation.
 *
 * These deliberately exercise only `buildAsdfTree` (no `vscode` host): project
 * semantics remain server-side, and the extension's sole responsibility is to
 * reshape the server DTO into a display hierarchy.
 */

function range(line: number, character = 0) {
  return { start: { line, character }, end: { line, character: character + 1 } };
}

function paymentDto(): AsdfProjectDto {
  const file = (name: string, serial: boolean): any => ({
    id: `payment/src/${name}`,
    name,
    type: "file",
    typeCertainty: "known",
    certainty: "known",
    serial,
    mapped: true,
    sourceUri: `file:///project/src/${name}.lisp`,
    declarationRange: range(5),
    nameRange: range(5, 2),
    conditions: [],
    children: [],
  });
  return {
    systems: [
      {
        name: "payment",
        nameCertainty: "known",
        uri: "file:///project/payment.asd",
        formRange: range(0),
        nameRange: range(0, 12),
        serial: true,
        packageInferred: false,
        certainty: "known",
        conditions: [],
        systemDependencies: [
          {
            name: "alexandria",
            kind: "depends-on",
            certainty: "known",
            range: range(2, 4),
          },
        ],
        components: [
          {
            id: "payment/src",
            name: "src",
            type: "module",
            typeCertainty: "known",
            certainty: "known",
            serial: true,
            mapped: false,
            declarationRange: range(4),
            nameRange: range(4, 2),
            conditions: [],
            children: [file("packages", true), file("model", true), file("services", true)],
          },
        ],
        componentEdges: [],
        inferredSubsystems: [],
      },
    ],
    diagnostics: [],
  };
}

function findChild(node: AsdfTreeNode, kind: string, labelIncludes: string): AsdfTreeNode {
  const match = node.children.find(
    (c) => c.kind === kind && c.label.includes(labelIncludes),
  );
  assert.ok(match, `expected a ${kind} child containing "${labelIncludes}"`);
  return match;
}

test("buildAsdfTree produces one system root with Dependencies and Components", () => {
  const roots = buildAsdfTree(paymentDto());
  assert.equal(roots.length, 1);
  const system = roots[0];
  assert.equal(system.kind, "system");
  assert.equal(system.label, "payment");
  // Navigates to the `.asd` declaration.
  assert.equal(system.location?.uri, "file:///project/payment.asd");

  const deps = findChild(system, "category", "Dependencies");
  assert.equal(deps.children[0].label, "alexandria");

  const components = findChild(system, "category", "Components");
  assert.equal(components.children.length, 1);
});

test("component hierarchy preserves module nesting and maps files to sources", () => {
  const roots = buildAsdfTree(paymentDto());
  const components = findChild(roots[0], "category", "Components");
  const src = components.children[0];
  assert.equal(src.kind, "component");
  assert.equal(src.label, "src");
  assert.deepEqual(
    src.children.map((c) => c.label),
    ["packages", "model", "services"],
  );
  // A file component navigates to its mapped source file.
  const model = src.children[1];
  assert.equal(model.location?.uri, "file:///project/src/model.lisp");
});

test("package-inferred systems surface an Inferred Systems category", () => {
  const dto = paymentDto();
  const sys: any = dto.systems[0];
  sys.packageInferred = true;
  sys.className = "package-inferred-system";
  sys.inferredSubsystems = [
    {
      name: "payment/foo",
      uri: "file:///project/foo.lisp",
      packageName: "PAYMENT/FOO",
      certainty: "known",
      dependsOn: [],
    },
  ];
  const roots = buildAsdfTree(dto);
  const inferred = findChild(roots[0], "category", "Inferred Systems");
  assert.equal(inferred.children[0].label, "payment/foo");
  assert.equal(inferred.children[0].location?.uri, "file:///project/foo.lisp");
});

test("empty categories still render a message child, never crash", () => {
  const dto: AsdfProjectDto = {
    systems: [
      {
        name: "bare",
        nameCertainty: "known",
        uri: "file:///p/bare.asd",
        formRange: range(0),
        serial: false,
        packageInferred: false,
        certainty: "known",
        conditions: [],
        systemDependencies: [],
        components: [],
        componentEdges: [],
        inferredSubsystems: [],
      },
    ],
    diagnostics: [],
  };
  const roots = buildAsdfTree(dto);
  const deps = findChild(roots[0], "category", "Dependencies");
  assert.equal(deps.children[0].kind, "message");
});
