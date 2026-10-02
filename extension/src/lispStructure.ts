import * as vscode from "vscode";

/**
 * Groups document symbols by their kind and renders them in a native
 * VS Code TreeView named "Lisp Structure".
 *
 * Symbols are sourced from the language server through the standard
 * `vscode.executeDocumentSymbolProvider` command, so the tree always reflects
 * the same static model that powers Go-to-Definition — no Webview required.
 */

type TreeNode = GroupNode | SymbolNode;

class GroupNode {
  readonly type = "group";
  constructor(
    readonly label: string,
    readonly children: SymbolNode[],
  ) {}
}

class SymbolNode {
  readonly type = "symbol";
  constructor(
    readonly symbol: vscode.DocumentSymbol,
    readonly uri: vscode.Uri,
  ) {}
}

/** Display order and labels for the kinds SexprScope surfaces. */
const GROUP_ORDER: Array<{ label: string; kinds: vscode.SymbolKind[] }> = [
  { label: "Packages", kinds: [vscode.SymbolKind.Namespace] },
  { label: "Classes", kinds: [vscode.SymbolKind.Class] },
  { label: "Structs", kinds: [vscode.SymbolKind.Struct] },
  { label: "Generic Functions & Methods", kinds: [vscode.SymbolKind.Method] },
  { label: "Functions & Macros", kinds: [vscode.SymbolKind.Function] },
  { label: "Types", kinds: [vscode.SymbolKind.Interface] },
  {
    label: "Variables & Constants",
    kinds: [vscode.SymbolKind.Variable, vscode.SymbolKind.Constant],
  },
];

export class LispStructureProvider
  implements vscode.TreeDataProvider<TreeNode>
{
  private readonly emitter = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  private groups: GroupNode[] = [];

  refresh(): void {
    void this.rebuild();
  }

  private async rebuild(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== "commonlisp") {
      this.groups = [];
      this.emitter.fire(undefined);
      return;
    }

    const uri = editor.document.uri;
    const symbols =
      (await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        "vscode.executeDocumentSymbolProvider",
        uri,
      )) ?? [];

    this.groups = GROUP_ORDER.map((spec) => {
      const children = symbols
        .filter((s) => spec.kinds.includes(s.kind))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((s) => new SymbolNode(s, uri));
      return new GroupNode(spec.label, children);
    }).filter((g) => g.children.length > 0);

    this.emitter.fire(undefined);
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    if (node.type === "group") {
      const item = new vscode.TreeItem(
        `${node.label} (${node.children.length})`,
        vscode.TreeItemCollapsibleState.Expanded,
      );
      item.contextValue = "sexprScope.group";
      return item;
    }

    const item = new vscode.TreeItem(
      node.symbol.name,
      vscode.TreeItemCollapsibleState.None,
    );
    item.description = node.symbol.detail;
    item.iconPath = iconFor(node.symbol.kind);
    item.command = {
      command: "vscode.open",
      title: "Reveal Definition",
      arguments: [
        node.uri,
        { selection: node.symbol.selectionRange } as vscode.TextDocumentShowOptions,
      ],
    };
    return item;
  }

  getChildren(node?: TreeNode): TreeNode[] {
    if (!node) return this.groups;
    if (node.type === "group") return node.children;
    return [];
  }
}

function iconFor(kind: vscode.SymbolKind): vscode.ThemeIcon {
  switch (kind) {
    case vscode.SymbolKind.Namespace:
      return new vscode.ThemeIcon("symbol-namespace");
    case vscode.SymbolKind.Class:
      return new vscode.ThemeIcon("symbol-class");
    case vscode.SymbolKind.Struct:
      return new vscode.ThemeIcon("symbol-structure");
    case vscode.SymbolKind.Method:
      return new vscode.ThemeIcon("symbol-method");
    case vscode.SymbolKind.Interface:
      return new vscode.ThemeIcon("symbol-interface");
    case vscode.SymbolKind.Variable:
      return new vscode.ThemeIcon("symbol-variable");
    case vscode.SymbolKind.Constant:
      return new vscode.ThemeIcon("symbol-constant");
    default:
      return new vscode.ThemeIcon("symbol-function");
  }
}
