import * as vscode from "vscode";
import { LanguageClient } from "vscode-languageclient/node";
import { AsdfProjectDto, AsdfTreeNode, buildAsdfTree } from "./asdfModel";

/** Custom server request that returns the static ASDF project model. */
const ASDF_SYSTEMS_REQUEST = "sexprScope/asdfSystems";

/**
 * A native, read-only "ASDF Systems" TreeView.
 *
 * The provider asks the language server for the already-computed project DTO and
 * renders systems, their dependencies and their component hierarchy. It never
 * parses `.asd` itself — all project semantics stay in the server. Clicking a
 * node navigates to the relevant `.asd` declaration or mapped source file.
 */
export class AsdfSystemsProvider
  implements vscode.TreeDataProvider<AsdfTreeNode>
{
  private readonly emitter = new vscode.EventEmitter<AsdfTreeNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  private roots: AsdfTreeNode[] = [];

  constructor(private readonly client: LanguageClient) {}

  refresh(): void {
    void this.rebuild();
  }

  private async rebuild(): Promise<void> {
    try {
      const dto = await this.client.sendRequest<AsdfProjectDto>(
        ASDF_SYSTEMS_REQUEST,
      );
      this.roots = buildAsdfTree(dto);
    } catch {
      // The server may not be ready yet; show an empty tree rather than error.
      this.roots = [];
    }
    this.emitter.fire(undefined);
  }

  getTreeItem(node: AsdfTreeNode): vscode.TreeItem {
    const state = node.expandable
      ? node.kind === "system" || node.kind === "category"
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None;

    const item = new vscode.TreeItem(node.label, state);
    item.description = node.description;
    item.tooltip = node.tooltip;
    item.contextValue = `sexprScope.asdf.${node.kind}`;
    if (node.icon) item.iconPath = new vscode.ThemeIcon(node.icon);
    if (node.location) {
      const target = vscode.Uri.parse(node.location.uri);
      const options: vscode.TextDocumentShowOptions = {};
      if (node.location.range) {
        const r = node.location.range;
        options.selection = new vscode.Range(
          r.start.line,
          r.start.character,
          r.end.line,
          r.end.character,
        );
      }
      item.command = {
        command: "vscode.open",
        title: "Open",
        arguments: [target, options],
      };
    }
    return item;
  }

  getChildren(node?: AsdfTreeNode): AsdfTreeNode[] {
    if (!node) return this.roots;
    return node.children;
  }
}
