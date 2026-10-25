import path from "node:path";
import type { RspressPlugin } from "@rspress/core";

export type BuilderPlugin = NonNullable<
	NonNullable<RspressPlugin["builderConfig"]>["plugins"]
>[number];

/** The slice of Rsbuild's plugin API this plugin uses (Rsbuild types `setup(api)` loosely). */
interface PublicDirApi {
	context: { rootPath: string };
	modifyRsbuildConfig: (fn: (config: { server?: { publicDir?: unknown } }) => void) => void;
}

/**
 * An Rsbuild plugin that serves `dir` as an extra public directory: the dev
 * server serves it live and a build copies it into the output, next to the
 * site's own `public/`. Plugins publish generated files this way instead of
 * writing into the user's docs tree.
 *
 * @param prepare - Fills `dir`; runs when the bundler is configured, so a
 *   plugin that is only constructed (a test, a config being read) writes
 *   nothing.
 */
export function publicDirectoryPlugin(
	name: string,
	dir: string,
	prepare?: () => void,
): BuilderPlugin {
	return {
		name,
		setup(api: PublicDirApi) {
			api.modifyRsbuildConfig((config) => {
				const current = config.server?.publicDir;
				const existing =
					current === false
						? []
						: current === undefined
							? [{ name: path.join(api.context.rootPath, "public") }]
							: Array.isArray(current)
								? current
								: [current];
				// Two plugins publishing the same directory (markdown and canvas both
				// publish KaTeX's stylesheet) would copy it twice.
				const served = (entry: unknown) =>
					typeof entry === "object" && entry !== null && "name" in entry && entry.name === dir;
				if (existing.some(served)) return;
				prepare?.();
				config.server = {
					...config.server,
					publicDir: [...existing, { name: dir, copyOnBuild: "auto" }],
				};
			});
		},
	} as unknown as BuilderPlugin;
}
