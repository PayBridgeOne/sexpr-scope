import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { PassThrough } from "node:stream";
import {
  createConnection,
  StreamMessageReader as ServerReader,
  StreamMessageWriter as ServerWriter,
} from "vscode-languageserver/node";
import {
  createProtocolConnection,
  StreamMessageReader,
  StreamMessageWriter,
  InitializeRequest,
  InitializedNotification,
  ShutdownRequest,
  DidOpenTextDocumentNotification,
  DidChangeTextDocumentNotification,
  CodeActionRequest,
  PublishDiagnosticsNotification,
  Diagnostic,
  PublishDiagnosticsParams,
} from "vscode-languageserver-protocol/node";
import { createServer, ASDF_SYSTEMS_REQUEST } from "../src/lsp/server";
import { AsdfProjectDto } from "../src/asdf/project";
import { ASDF_DIAGNOSTIC_SOURCE } from "../src/asdf/model";

/**
 * Real server-boundary tests for the M3 ASDF project surface (spec #31):
 *   - the custom `sexprScope/asdfSystems` request returns a client-safe DTO
 *     (systems, components, dependencies with reason/confidence, source
 *     URIs/ranges) with no server internals;
 *   - ASDF diagnostics are published and clear after the `.asd` is fixed;
 *   - at least one conservative Code Action is offered end-to-end.
 *
 * `.asd` content is only parsed statically; a `#.` read-time form is embedded to
 * prove nothing is evaluated (an evaluating server would crash on it).
 */

const ASD_TEXT = `(defsystem "app"
  :version #.(error "the .asd must never be evaluated")
  :components ((:file "model")
               (:file "services" :depends-on ("nope"))))
`;
const MODEL_TEXT = `(defpackage :app.model (:use :cl) (:export #:make-thing))
(in-package :app.model)
(defun make-thing () 1)
`;
const SERVICES_TEXT = `(defpackage :app.services (:use :cl :app.model))
(in-package :app.services)
(defun run () (make-thing))
`;
const FIXED_ASD_TEXT = `(defsystem "app"
  :version #.(error "the .asd must never be evaluated")
  :components ((:file "model")
               (:file "services")))
`;

test("ASDF project request, diagnostics, clearing and a Code Action work over the LSP boundary", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sexpr-scope-asdf-"));
  const asdPath = path.join(dir, "app.asd");
  await fs.writeFile(asdPath, ASD_TEXT, "utf8");
  await fs.writeFile(path.join(dir, "model.lisp"), MODEL_TEXT, "utf8");
  await fs.writeFile(path.join(dir, "services.lisp"), SERVICES_TEXT, "utf8");

  const clientToServer = new PassThrough();
  const serverToClient = new PassThrough();
  const serverConnection = createConnection(
    new ServerReader(clientToServer),
    new ServerWriter(serverToClient),
  );
  createServer(serverConnection);
  const client = createProtocolConnection(
    new StreamMessageReader(serverToClient),
    new StreamMessageWriter(clientToServer),
  );
  client.listen();

  const asdUri = pathToFileURL(asdPath).toString();
  const modelUri = pathToFileURL(path.join(dir, "model.lisp")).toString();
  const servicesUri = pathToFileURL(path.join(dir, "services.lisp")).toString();

  const latest = new Map<string, Diagnostic[]>();
  let pending: (() => void) | undefined;
  client.onNotification(
    PublishDiagnosticsNotification.type,
    (params: PublishDiagnosticsParams) => {
      latest.set(params.uri, params.diagnostics);
      pending?.();
    },
  );
  const asdfDiagnosticsWhen = (
    uri: string,
    predicate: (asdf: Diagnostic[]) => boolean,
  ): Promise<Diagnostic[]> =>
    new Promise((resolve) => {
      const check = () => {
        const all = latest.get(uri);
        if (all) {
          const asdf = all.filter((d) => d.source === ASDF_DIAGNOSTIC_SOURCE);
          if (predicate(asdf)) {
            pending = undefined;
            resolve(asdf);
            return;
          }
        }
        pending = check;
      };
      check();
    });

  try {
    await client.sendRequest(InitializeRequest.type, {
      processId: null,
      rootUri: pathToFileURL(dir).toString(),
      capabilities: {},
      workspaceFolders: [{ uri: pathToFileURL(dir).toString(), name: "fixture" }],
    });
    client.sendNotification(InitializedNotification.type, {});

    // Open the .asd buffer; its ASDF diagnostics must flag the missing component.
    const missingDiag = asdfDiagnosticsWhen(asdUri, (a) => a.length > 0);
    client.sendNotification(DidOpenTextDocumentNotification.type, {
      textDocument: { uri: asdUri, languageId: "lisp", version: 1, text: ASD_TEXT },
    });
    const missing = await missingDiag;
    assert.equal(missing.length, 1, "expected one ASDF diagnostic");
    assert.equal(missing[0].code, "asdf-missing-component");
    assert.match(missing[0].message, /nope/);

    // The custom project request returns a client-safe DTO.
    const dto = (await client.sendRequest(
      ASDF_SYSTEMS_REQUEST,
      {},
    )) as AsdfProjectDto;

    assert.equal(dto.systems.length, 1);
    const sys = dto.systems[0];
    assert.equal(sys.name, "app");
    assert.equal(sys.uri, asdUri);
    assert.ok(sys.formRange, "system must carry a source range");

    const compNames = sys.components.map((c) => c.name).sort();
    assert.deepEqual(compNames, ["model", "services"]);

    const model = sys.components.find((c) => c.name === "model")!;
    const services = sys.components.find((c) => c.name === "services")!;
    assert.equal(model.sourceUri, modelUri);
    assert.equal(model.mapped, true);
    assert.equal(services.sourceUri, servicesUri);
    assert.equal(services.mapped, true);
    assert.ok(services.declarationRange, "components carry declaration ranges");

    // The package relationship surfaces as a strong inferred-package edge with
    // evidence and reason/confidence metadata — never as a declared dependency.
    const inferred = sys.componentEdges.find(
      (e) =>
        e.from === "app/services" &&
        e.to === "app/model" &&
        e.reason === "inferred-package",
    );
    assert.ok(inferred, "expected an inferred-package edge services -> model");
    assert.equal(inferred!.confidence, "strong");
    assert.ok(inferred!.evidence, "inferred edge must retain evidence");

    // The DTO also carries the project diagnostic.
    assert.ok(
      dto.diagnostics.some((d) => d.code === "asdf-missing-component"),
      "DTO exposes the missing-component diagnostic",
    );

    // A conservative Code Action is offered to add the missing :depends-on.
    const lines = ASD_TEXT.split("\n");
    const actions = await client.sendRequest(CodeActionRequest.type, {
      textDocument: { uri: asdUri },
      range: {
        start: { line: 0, character: 0 },
        end: { line: lines.length - 1, character: 0 },
      },
      context: { diagnostics: [] },
    });
    assert.ok(actions && actions.length > 0, "expected at least one code action");
    const addDep = actions!.find((a) =>
      /Add :depends-on "model" to component "services"/.test(
        "title" in a ? a.title : "",
      ),
    );
    assert.ok(addDep, "expected the add-:depends-on code action");
    assert.ok("edit" in addDep! && addDep!.edit, "action must carry a WorkspaceEdit");
    const changes = (addDep as { edit: { changes?: Record<string, unknown[]> } }).edit
      .changes!;
    assert.ok(changes[asdUri], "edit targets the .asd document");

    // Fix the .asd: removing the bad :depends-on must clear the diagnostic.
    const cleared = asdfDiagnosticsWhen(asdUri, (a) => a.length === 0);
    client.sendNotification(DidChangeTextDocumentNotification.type, {
      textDocument: { uri: asdUri, version: 2 },
      contentChanges: [{ text: FIXED_ASD_TEXT }],
    });
    const after = await cleared;
    assert.equal(after.length, 0, "the ASDF diagnostic must clear after the fix");

    await client.sendRequest(ShutdownRequest.type, undefined);
  } finally {
    client.dispose();
    serverConnection.dispose();
    clientToServer.destroy();
    serverToClient.destroy();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
