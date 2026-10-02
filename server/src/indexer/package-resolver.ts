import { PackageDefinition } from "../model/symbol";

/**
 * How an accessible symbol becomes visible in a package.
 *
 *  - `definition`        — interned directly in the package (a workspace `defun`,
 *                          `defvar`, … whose home package is this one);
 *  - `import`            — brought in by `:import-from`;
 *  - `shadow`            — a fresh local symbol created by `:shadow`;
 *  - `shadowing-import`  — brought in by `:shadowing-import-from`;
 *  - `inheritance`       — an external symbol inherited from a `:use`d package.
 */
export type AccessVia =
  | "definition"
  | "import"
  | "shadow"
  | "shadowing-import"
  | "inheritance";

/**
 * The result of asking "is print-name N accessible in package P, and if so,
 * where does it live?". This is the single vocabulary the rest of the server
 * uses to reason about Common Lisp package accessibility, so that completion,
 * diagnostics, hover and navigation never re-derive the rules independently.
 */
export type PackageSymbolAccess =
  | {
      readonly status: "present" | "inherited";
      readonly name: string;
      /** Canonical package whose definitions should be searched for the symbol. */
      readonly homePackage: string;
      readonly via: AccessVia;
      /** True when the symbol is exported from its home package. */
      readonly external: boolean;
      /** True when accessibility came from an import clause. */
      readonly imported: boolean;
      /** True when accessibility came from inheritance (`:use`). */
      readonly inherited: boolean;
      /** True when this access shadows otherwise-inherited symbols. */
      readonly shadowed: boolean;
      /** Whether a definition lookup must require the symbol be exported. */
      readonly requireExported: boolean;
    }
  | {
      /**
       * Multiple `:use`d packages export a same-named symbol and nothing makes a
       * single one accessible. Per Common Lisp semantics this is a genuine
       * conflict; static analysis must not guess, so navigation yields nothing
       * and a diagnostic may be raised.
       */
      readonly status: "ambiguous";
      readonly name: string;
      readonly candidatePackages: string[];
    }
  | {
      /** The name is not accessible in the package by any static rule. */
      readonly status: "none";
      readonly name: string;
    };

/**
 * A static model of Common Lisp package accessibility.
 *
 * It is built from the workspace's `defpackage` forms plus the set of symbol
 * names actually defined/exported per package. It implements a conservative
 * subset of `find-symbol` accessibility:
 *
 *   present (import / shadowing-import / shadow / direct definition)
 *     takes precedence over
 *   inherited (external symbols of `:use`d packages),
 *
 * and a name inherited from two or more distinct packages with no present
 * resolution is reported as ambiguous rather than resolved arbitrarily.
 *
 * The model never evaluates Lisp and knows nothing of a running image: a used
 * package whose exports are unknown (e.g. `COMMON-LISP`) simply contributes no
 * inherited candidates, which keeps resolution conservative.
 */
export class PackageResolver {
  constructor(
    /** Canonical package name → its defpackage model. */
    private readonly packages: Map<string, PackageDefinition>,
    /** Any designator (name or nickname) → canonical package name. */
    private readonly aliases: Map<string, string>,
    /** Canonical package → print names of symbols whose home it is. */
    private readonly definedNames: Map<string, Set<string>>,
    /** Canonical package → print names it exports. */
    private readonly exportedNames: Map<string, Set<string>>,
  ) {}

  /** Resolves a package designator (name or nickname) to its canonical name. */
  canonical(designator: string): string {
    return this.aliases.get(designator) ?? designator;
  }

  private exportsFrom(pkg: string): ReadonlySet<string> {
    return this.exportedNames.get(pkg) ?? EMPTY;
  }

  private isExternal(pkg: string, name: string): boolean {
    return this.exportsFrom(pkg).has(name);
  }

  /**
   * Classifies how print-name `name` is accessible in canonical package
   * `currentPackage`. `name` must already be upper-cased (a print name).
   */
  classify(currentPackage: string, name: string): PackageSymbolAccess {
    const pkg = this.packages.get(currentPackage);

    if (pkg) {
      // A shadowing import makes the symbol present *and* suppresses any
      // conflicting inherited symbol — it is checked first for that reason.
      for (const imp of pkg.shadowingImports) {
        if (imp.name === name) {
          const home = this.canonical(imp.from);
          return this.present(name, home, "shadowing-import", {
            imported: true,
            shadowed: true,
          });
        }
      }
      for (const imp of pkg.imports) {
        if (imp.name === name) {
          const home = this.canonical(imp.from);
          return this.present(name, home, "import", { imported: true });
        }
      }
      if (pkg.shadows.includes(name)) {
        return this.present(name, currentPackage, "shadow", { shadowed: true });
      }
    }

    // A symbol defined (interned) directly in the package is present.
    if (this.definedNames.get(currentPackage)?.has(name)) {
      return this.present(name, currentPackage, "definition", {});
    }

    // Otherwise consider external symbols inherited from directly `:use`d
    // packages. Inheritance is not transitive, matching Lisp semantics.
    if (pkg) {
      const homes = new Set<string>();
      for (const used of pkg.uses) {
        const u = this.canonical(used);
        if (this.isExternal(u, name)) homes.add(u);
      }
      if (homes.size === 1) {
        const home = [...homes][0];
        return {
          status: "inherited",
          name,
          homePackage: home,
          via: "inheritance",
          external: true,
          imported: false,
          inherited: true,
          shadowed: false,
          requireExported: true,
        };
      }
      if (homes.size > 1) {
        return { status: "ambiguous", name, candidatePackages: [...homes].sort() };
      }
    }

    return { status: "none", name };
  }

  private present(
    name: string,
    home: string,
    via: AccessVia,
    flags: { imported?: boolean; shadowed?: boolean },
  ): PackageSymbolAccess {
    return {
      status: "present",
      name,
      homePackage: home,
      via,
      external: this.isExternal(home, name),
      imported: flags.imported ?? false,
      inherited: false,
      shadowed: flags.shadowed ?? false,
      requireExported: false,
    };
  }
}

const EMPTY: ReadonlySet<string> = new Set<string>();
