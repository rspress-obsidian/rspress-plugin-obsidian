import path from "node:path";
import type { RspressPlugin } from "@rspress/core";

type BuilderPlugin = NonNullable<NonNullable<RspressPlugin["builderConfig"]>["plugins"]>[number];

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
 */
export function publicDirectoryPlugin(name: string, dir: string): BuilderPlugin {
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
				config.server = {
					...config.server,
					publicDir: [...existing, { name: dir, copyOnBuild: "auto" }],
				};
			});
		},
	} as unknown as BuilderPlugin;
}
