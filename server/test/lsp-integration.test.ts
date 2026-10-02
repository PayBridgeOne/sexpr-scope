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
  DefinitionRequest,
  ReferencesRequest,
  Location,
} from "vscode-languageserver-protocol/node";
import { createServer } from "../src/lsp/server";

/**
 * A minimal, cleanly terminating smoke test around the real LSP server boundary.
 *
 * Two in-process pipes stand in for stdio. The test drives a full lifecycle —
 * initialize, index, open a document, Go to Definition into a *different*,
 * never-opened workspace file, then shut down — and tears every handle down so
 * the Node test process exits on its own with no force-exit.
 */
test("LSP server resolves Go to Definition into an unopened workspace file", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sexpr-scope-lsp-"));

  // A definition that lives only on disk; it is never opened as a document.
  const libPath = path.join(dir, "lib.lisp");
  await fs.writeFile(
    libPath,
    "(in-package :cl-user)\n(defun cross-file-target () 42)\n",
    "utf8",
  );

  // The document the client opens; it merely calls the cross-file definition.
  const mainPath = path.join(dir, "main.lisp");
  const mainText = "(in-package :cl-user)\n(cross-file-target)\n";
  await fs.writeFile(mainPath, mainText, "utf8");

  const clientToServer = new PassThrough();
  const serverToClient = new PassThrough();

  // Server speaks LSP over the in-memory pipes, exactly as it would over stdio.
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

  try {
    await client.sendRequest(InitializeRequest.type, {
      // `null` means the server was not started by a parent process. This keeps
      // the in-process test free of the parent-process monitor timer that would
      // otherwise linger and prevent the Node test process from exiting.
      processId: null,
      rootUri: pathToFileURL(dir).toString(),
      capabilities: {},
      workspaceFolders: [
        { uri: pathToFileURL(dir).toString(), name: "sexpr-scope-fixture" },
      ],
    });
    client.sendNotification(InitializedNotification.type, {});

    const mainUri = pathToFileURL(mainPath).toString();
    client.sendNotification(DidOpenTextDocumentNotification.type, {
      textDocument: {
        uri: mainUri,
        languageId: "lisp",
        version: 1,
        text: mainText,
      },
    });

    // The handler awaits the readiness barrier, so by the time this resolves the
    // initial workspace scan has completed and the on-disk definition is indexed.
    const result = await client.sendRequest(DefinitionRequest.type, {
      textDocument: { uri: mainUri },
      position: { line: 1, character: 3 },
    });

    const locations = (Array.isArray(result) ? result : [result]) as Location[];
    assert.equal(locations.length, 1, "expected exactly one definition");
    const target = locations[0];
    assert.equal(target.uri, pathToFileURL(libPath).toString());
    assert.notEqual(target.uri, mainUri, "definition must be in a different file");

    // Graceful shutdown. We intentionally do not send `exit`, which would let
    // the server terminate the process; disposing the pipes is enough to free
    // every handle so the test runner exits naturally.
    await client.sendRequest(ShutdownRequest.type, undefined);
  } finally {
    client.dispose();
    serverConnection.dispose();
    clientToServer.destroy();
    serverToClient.destroy();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

/**
 * Exercises `textDocument/references` across the real LSP boundary: a global
 * function defined in one on-disk file and called from an opened document. The
 * request must return the cross-file declaration plus the in-document call, and
 * honor `includeDeclaration`.
 */
test("LSP server returns cross-file references and honors includeDeclaration", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sexpr-scope-refs-"));

  const libPath = path.join(dir, "lib.lisp");
  await fs.writeFile(
    libPath,
    "(in-package :cl-user)\n(defun shared-op () 1)\n",
    "utf8",
  );

  const mainPath = path.join(dir, "main.lisp");
  const mainText = "(in-package :cl-user)\n(shared-op)\n(list (shared-op))\n";
  await fs.writeFile(mainPath, mainText, "utf8");

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

  try {
    await client.sendRequest(InitializeRequest.type, {
      processId: null,
      rootUri: pathToFileURL(dir).toString(),
      capabilities: {},
      workspaceFolders: [
        { uri: pathToFileURL(dir).toString(), name: "sexpr-scope-fixture" },
      ],
    });
    client.sendNotification(InitializedNotification.type, {});

    const mainUri = pathToFileURL(mainPath).toString();
    client.sendNotification(DidOpenTextDocumentNotification.type, {
      textDocument: { uri: mainUri, languageId: "lisp", version: 1, text: mainText },
    });

    // Position over the first `(shared-op)` call in the opened document.
    const withDecl = (await client.sendRequest(ReferencesRequest.type, {
      textDocument: { uri: mainUri },
      position: { line: 1, character: 3 },
      context: { includeDeclaration: true },
    })) as Location[];

    // One declaration (lib) + two calls (main).
    assert.equal(withDecl.length, 3);
    const libUri = pathToFileURL(libPath).toString();
    assert.ok(
      withDecl.some((l) => l.uri === libUri),
      "declaration file must appear in references",
    );
    assert.equal(
      withDecl.filter((l) => l.uri === mainUri).length,
      2,
      "both call sites must appear",
    );

    const withoutDecl = (await client.sendRequest(ReferencesRequest.type, {
      textDocument: { uri: mainUri },
      position: { line: 1, character: 3 },
      context: { includeDeclaration: false },
    })) as Location[];

    // Declaration excluded: only the two call sites remain.
    assert.equal(withoutDecl.length, 2);
    assert.ok(
      withoutDecl.every((l) => l.uri === mainUri),
      "only in-document calls remain when the declaration is excluded",
    );

    await client.sendRequest(ShutdownRequest.type, undefined);
  } finally {
    client.dispose();
    serverConnection.dispose();
    clientToServer.destroy();
    serverToClient.destroy();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
