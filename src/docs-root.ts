import path from "node:path";

/**
 * The docs tree of a site: Rspress's `root`, or `docs` when the config names
 * none. A feature reads it in `config`/`addPages` before any plugin has
 * published an index, so every feature must apply the same rule; `path.resolve`
 * makes a relative `root` absolute against the process's working directory.
 */
export function docsRootOf(config: { root?: string } | undefined): string {
	return path.resolve(process.cwd(), config?.root ?? "docs");
}
