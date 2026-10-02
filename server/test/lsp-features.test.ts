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
  ProtocolConnection,
  StreamMessageReader,
  StreamMessageWriter,
  InitializeRequest,
  InitializedNotification,
  ShutdownRequest,
  DidOpenTextDocumentNotification,
  DidChangeTextDocumentNotification,
  CompletionRequest,
  SignatureHelpRequest,
  PublishDiagnosticsNotification,
  CompletionItem,
  SignatureHelp,
  Diagnostic,
} from "vscode-languageserver-protocol/node";
import { createServer } from "../src/lsp/server";

/** A connected client/server pair over in-memory pipes, plus teardown. */
interface Harness {
  client: ProtocolConnection;
  /** Latest diagnostics received per document URI. */
  diagnostics: Map<string, Diagnostic[]>;
  /** Resolves once a diagnostics notification for `uri` satisfies `pred`. */
  waitForDiagnostics(
    uri: string,
    pred: (d: Diagnostic[]) => boolean,
  ): Promise<Diagnostic[]>;
  dispose(): void;
}

function startHarness(): Harness {
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

  const diagnostics = new Map<string, Diagnostic[]>();
  const waiters: Array<{
    uri: string;
    pred: (d: Diagnostic[]) => boolean;
    resolve: (d: Diagnostic[]) => void;
  }> = [];

  client.onNotification(PublishDiagnosticsNotification.type, (params) => {
    diagnostics.set(params.uri, params.diagnostics);
    for (let i = waiters.length - 1; i >= 0; i--) {
      const w = waiters[i];
      if (w.uri === params.uri && w.pred(params.diagnostics)) {
        w.resolve(params.diagnostics);
        waiters.splice(i, 1);
      }
    }
  });
  client.listen();

  return {
    client,
    diagnostics,
    waitForDiagnostics(uri, pred) {
      const current = diagnostics.get(uri);
      if (current && pred(current)) return Promise.resolve(current);
      return new Promise((resolve) => waiters.push({ uri, pred, resolve }));
    },
    dispose() {
      client.dispose();
      serverConnection.dispose();
      clientToServer.destroy();
      serverToClient.destroy();
    },
  };
}

async function initialize(client: ProtocolConnection, dir: string): Promise<any> {
  const result = await client.sendRequest(InitializeRequest.type, {
    processId: null,
    rootUri: pathToFileURL(dir).toString(),
    capabilities: {},
    workspaceFolders: [
      { uri: pathToFileURL(dir).toString(), name: "sexpr-scope-fixture" },
    ],
  });
  client.sendNotification(InitializedNotification.type, {});
  return result;
}

function openDoc(
  client: ProtocolConnection,
  uri: string,
  text: string,
): void {
  client.sendNotification(DidOpenTextDocumentNotification.type, {
    textDocument: { uri, languageId: "lisp", version: 1, text },
  });
}

test("LSP completion returns a workspace function and advertises the capability", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sexpr-scope-compl-"));
  const mainPath = path.join(dir, "main.lisp");
  const mainText =
    "(in-package :cl-user)\n(defun calculate-fee (amount) amount)\n(defun run (value)\n  (calcu))\n";
  await fs.writeFile(mainPath, mainText, "utf8");

  const h = startHarness();
  try {
    const init = await initialize(h.client, dir);
    // The capability must be advertised during initialize.
    assert.ok(
      init.capabilities.completionProvider,
      "completionProvider must be advertised",
    );

    const mainUri = pathToFileURL(mainPath).toString();
    openDoc(h.client, mainUri, mainText);

    // Cursor just after "calcu" on line 3 (0-based), inside "(calcu)".
    const result = await h.client.sendRequest(CompletionRequest.type, {
      textDocument: { uri: mainUri },
      position: { line: 3, character: 7 },
    });
    const items = (Array.isArray(result) ? result : result?.items ?? []) as
      CompletionItem[];
    const labels = items.map((i) => i.label);
    assert.ok(labels.includes("calculate-fee"), "calculate-fee must be offered");
    // The item uses a TextEdit replacement range (preserves qualifiers/context).
    const item = items.find((i) => i.label === "calculate-fee")!;
    assert.ok(item.textEdit, "completion must carry a TextEdit");

    await h.client.sendRequest(ShutdownRequest.type, undefined);
  } finally {
    h.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("LSP completion with a package qualifier offers only exported symbols", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sexpr-scope-complq-"));
  const libPath = path.join(dir, "payment.lisp");
  await fs.writeFile(
    libPath,
    "(defpackage :payment\n  (:use :cl)\n  (:export #:authorize))\n(in-package :payment)\n(defun authorize (tx) tx)\n(defun authenticate (tx) tx)\n",
    "utf8",
  );
  const mainPath = path.join(dir, "main.lisp");
  const mainText = "(in-package :cl-user)\n(defun run (v) (payment:auth))\n";
  await fs.writeFile(mainPath, mainText, "utf8");

  const h = startHarness();
  try {
    await initialize(h.client, dir);
    const mainUri = pathToFileURL(mainPath).toString();
    openDoc(h.client, mainUri, mainText);

    // Cursor after "payment:auth" on line 1: char index of the end of "auth".
    const character = mainText.split("\n")[1].indexOf("payment:auth") +
      "payment:auth".length;
    const result = await h.client.sendRequest(CompletionRequest.type, {
      textDocument: { uri: mainUri },
      position: { line: 1, character },
    });
    const items = (Array.isArray(result) ? result : result?.items ?? []) as
      CompletionItem[];
    const labels = items.map((i) => i.label);
    assert.deepEqual(labels, ["authorize"]);

    await h.client.sendRequest(ShutdownRequest.type, undefined);
  } finally {
    h.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("LSP signature help reports label, parameters and active parameter", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sexpr-scope-sig-"));
  const mainPath = path.join(dir, "main.lisp");
  const mainText =
    "(in-package :cl-user)\n(defun charge-fee (transaction amount &key currency) transaction)\n(defun run (tx) (charge-fee tx ))\n";
  await fs.writeFile(mainPath, mainText, "utf8");

  const h = startHarness();
  try {
    const init = await initialize(h.client, dir);
    assert.ok(
      init.capabilities.signatureHelpProvider,
      "signatureHelpProvider must be advertised",
    );

    const mainUri = pathToFileURL(mainPath).toString();
    openDoc(h.client, mainUri, mainText);

    // Cursor after "charge-fee tx " on line 2 → second parameter (amount).
    const line2 = mainText.split("\n")[2];
    const character = line2.indexOf("tx )") + "tx ".length;
    const sig = (await h.client.sendRequest(SignatureHelpRequest.type, {
      textDocument: { uri: mainUri },
      position: { line: 2, character },
    })) as SignatureHelp | null;

    assert.ok(sig, "signature help returned");
    assert.equal(sig!.signatures.length, 1);
    assert.equal(
      sig!.signatures[0].label,
      "(charge-fee transaction amount &key currency)",
    );
    const params = sig!.signatures[0].parameters ?? [];
    assert.deepEqual(
      params.map((p) => p.label),
      ["transaction", "amount", "currency"],
    );
    assert.equal(sig!.activeParameter, 1);

    await h.client.sendRequest(ShutdownRequest.type, undefined);
  } finally {
    h.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("LSP publishes a diagnostic and clears it when the document is fixed", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sexpr-scope-diag-"));
  const mainPath = path.join(dir, "main.lisp");
  const badText = "(in-package :cl-user)\n(defun r () (nosuch-package:foo))\n";
  await fs.writeFile(mainPath, badText, "utf8");

  const h = startHarness();
  try {
    await initialize(h.client, dir);
    const mainUri = pathToFileURL(mainPath).toString();
    openDoc(h.client, mainUri, badText);

    const published = await h.waitForDiagnostics(mainUri, (d) => d.length > 0);
    const unknown = published.find((d) => d.code === "unknown-package");
    assert.ok(unknown, "an unknown-package diagnostic must be published");
    assert.equal(unknown!.source, "sexpr-scope");
    assert.equal(unknown!.severity, 2); // LSP Warning
    assert.ok(unknown!.range.end.character > unknown!.range.start.character);
    assert.ok(unknown!.message.length > 0);

    // Fix the document: the stale diagnostic must disappear.
    const goodText = "(in-package :cl-user)\n(defun r () (list 1 2 3))\n";
    h.client.sendNotification(DidChangeTextDocumentNotification.type, {
      textDocument: { uri: mainUri, version: 2 },
      contentChanges: [{ text: goodText }],
    });

    const cleared = await h.waitForDiagnostics(mainUri, (d) => d.length === 0);
    assert.deepEqual(cleared, []);

    await h.client.sendRequest(ShutdownRequest.type, undefined);
  } finally {
    h.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
