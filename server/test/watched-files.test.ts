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
  DidChangeWatchedFilesNotification,
  PublishDiagnosticsNotification,
  FileChangeType,
  Diagnostic,
  PublishDiagnosticsParams,
} from "vscode-languageserver-protocol/node";
import { createServer } from "../src/lsp/server";

/**
 * Regression test for the M2 watched-file race.
 *
 * When a *closed* file changes on disk, reindexing it reads asynchronously.
 * Diagnostics for open buffers must only be refreshed AFTER that reindex has
 * settled — otherwise the published diagnostics reflect a stale index. Here an
 * open document holds an external reference to a not-yet-exported symbol, the
 * on-disk `defpackage` is then edited to export it, and a watched-files change
 * is delivered. The diagnostic must clear, which can only happen if the refresh
 * awaited the disk reindex.
 */
test("watched-file change refreshes open diagnostics only after reindex settles", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sexpr-scope-watch-"));

  // A library package that defines FOO but does NOT export it (yet).
  const libPath = path.join(dir, "lib.lisp");
  await fs.writeFile(
    libPath,
    "(defpackage :lib (:use :cl))\n(in-package :lib)\n(defun foo () 1)\n",
    "utf8",
  );

  // An opened document that externally references lib:foo. Because FOO is not
  // exported, this yields a "not exported" diagnostic.
  const mainPath = path.join(dir, "main.lisp");
  const mainText = "(in-package :cl-user)\n(lib:foo)\n";
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

  const mainUri = pathToFileURL(mainPath).toString();
  const libUri = pathToFileURL(libPath).toString();

  // Track the latest diagnostics per URI, and let callers await the next push.
  const latest = new Map<string, Diagnostic[]>();
  let pending: (() => void) | undefined;
  client.onNotification(
    PublishDiagnosticsNotification.type,
    (params: PublishDiagnosticsParams) => {
      latest.set(params.uri, params.diagnostics);
      pending?.();
    },
  );
  const nextDiagnostics = (uri: string): Promise<Diagnostic[]> =>
    new Promise((resolve) => {
      pending = () => {
        if (latest.has(uri)) {
          pending = undefined;
          resolve(latest.get(uri)!);
        }
      };
    });

  try {
    await client.sendRequest(InitializeRequest.type, {
      processId: null,
      rootUri: pathToFileURL(dir).toString(),
      capabilities: {},
      workspaceFolders: [{ uri: pathToFileURL(dir).toString(), name: "fixture" }],
    });
    client.sendNotification(InitializedNotification.type, {});

    // Open main; its first diagnostics must flag the non-exported reference.
    const opened = nextDiagnostics(mainUri);
    client.sendNotification(DidOpenTextDocumentNotification.type, {
      textDocument: { uri: mainUri, languageId: "lisp", version: 1, text: mainText },
    });
    const initial = await opened;
    assert.equal(initial.length, 1, "lib:foo should be flagged as not exported");
    assert.match(initial[0].message, /not exported/i);

    // Edit the on-disk library to export FOO, then deliver the watched-files
    // change. The refresh must observe the reindexed (exporting) library.
    await fs.writeFile(
      libPath,
      "(defpackage :lib (:use :cl) (:export #:foo))\n(in-package :lib)\n(defun foo () 1)\n",
      "utf8",
    );
    const refreshed = nextDiagnostics(mainUri);
    client.sendNotification(DidChangeWatchedFilesNotification.type, {
      changes: [{ uri: libUri, type: FileChangeType.Changed }],
    });

    const after = await refreshed;
    assert.equal(
      after.length,
      0,
      "the not-exported diagnostic must clear once the reindex settles",
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
