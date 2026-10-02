import * as path from "path";
import * as vscode from "vscode";
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
} from "vscode-languageclient/node";
import { LispStructureProvider } from "./lispStructure";
import { AsdfSystemsProvider } from "./asdfSystems";

let client: LanguageClient | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  client = startClient(context);
  await client.start();

  const structure = new LispStructureProvider();
  const asdf = new AsdfSystemsProvider(client);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("sexprScope.structure", structure),
    vscode.window.registerTreeDataProvider("sexprScope.asdfSystems", asdf),
    vscode.window.onDidChangeActiveTextEditor(() => structure.refresh()),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      structure.refresh();
      // ASDF project data depends on `.asd` and mapped source files.
      if (/\.(asd|lisp|cl|lsp)$/i.test(doc.fileName)) asdf.refresh();
    }),
    vscode.commands.registerCommand("sexprScope.refreshStructure", () =>
      structure.refresh(),
    ),
    vscode.commands.registerCommand("sexprScope.refreshAsdfSystems", () =>
      asdf.refresh(),
    ),
    vscode.commands.registerCommand("sexprScope.restartServer", async () => {
      await client?.restart();
      structure.refresh();
      asdf.refresh();
    }),
  );

  structure.refresh();
  asdf.refresh();
}

export async function deactivate(): Promise<void> {
  await client?.stop();
  client = undefined;
}

function startClient(context: vscode.ExtensionContext): LanguageClient {
  // Resolve the standalone language server shipped alongside the extension.
  const serverModule = resolveServerModule(context);

  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: { module: serverModule, transport: TransportKind.ipc },
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: "file", language: "commonlisp" }],
    synchronize: {
      fileEvents: vscode.workspace.createFileSystemWatcher(
        "**/*.{lisp,cl,lsp,asd}",
      ),
    },
    // Surface trace output (controlled by the `sexprScope.trace.server`
    // setting, which the client reads automatically) in a dedicated channel.
    outputChannel: vscode.window.createOutputChannel("SexprScope Language Server"),
  };

  return new LanguageClient(
    "sexprScope",
    "SexprScope Language Server",
    serverOptions,
    clientOptions,
  );
}

function resolveServerModule(context: vscode.ExtensionContext): string {
  // Prefer the installed package; fall back to the sibling workspace path used
  // during development from a source checkout.
  try {
    return require.resolve("sexpr-scope-server/out/src/lsp/cli.js");
  } catch {
    return context.asAbsolutePath(
      path.join("..", "server", "out", "src", "lsp", "cli.js"),
    );
  }
}
