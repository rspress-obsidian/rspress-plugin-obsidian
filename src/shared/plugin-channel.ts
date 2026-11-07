/**
 * One way for a plugin to leave a value for the site's other plugins to read.
 *
 * Rspress hands every hook the site config, which lists the plugins, so a
 * feature can find a sibling's published value without module-level state: each
 * site sees its own values however many sites a process builds, and the order
 * the plugins are listed in does not matter. `Symbol.for`, not `Symbol()`,
 * because the per-feature entries may be loaded as separate bundle copies (an
 * ESM and a CJS entry side by side) and each copy has to recognise a plugin
 * built by another.
 */

/** Reads the value back; may return a promise when the producer is still working. */
export type PluginReader<T> = () => T;

function channelKey(name: string): symbol {
	return Symbol.for(`rspress-plugin-obsidian:${name}`);
}

/** Attach the reader a sibling feature calls to learn what `plugin` published. */
export function attachPluginValue<Plugin extends object, T>(
	plugin: Plugin,
	name: string,
	read: PluginReader<T>,
): Plugin {
	return Object.assign(plugin, { [channelKey(name)]: read });
}

/**
 * `config` with `plugin` added to its `plugins` list, or `config` itself when
 * it is already listed.
 *
 * Rspress passes `config.plugins` to every hook, the only plugin list a hook
 * sees. A plugin added with `utils.addPlugin` from another plugin's `config`
 * hook runs without being listed there, so it lists itself — on a copy,
 * leaving the caller's array untouched.
 */
export function withPluginListed<
	Plugin extends object,
	Config extends { plugins?: readonly unknown[] },
>(config: Config, plugin: Plugin): Config {
	const listed = config.plugins ?? [];
	if (listed.includes(plugin)) return config;
	return { ...config, plugins: [...listed, plugin] };
}

/**
 * The value a plugin of this site published under `name`, found among the
 * site's `plugins`; `undefined` when no plugin publishes it. Rspress refuses
 * two plugins with one name, so one is the most a site has.
 */
export function findPluginValue<T>(
	config: { plugins?: readonly unknown[] },
	name: string,
): T | undefined {
	const key = channelKey(name);
	for (const plugin of config.plugins ?? []) {
		if (typeof plugin !== "object" || plugin === null || !(key in plugin)) continue;
		const read = (plugin as Record<symbol, unknown>)[key];
		if (typeof read === "function") return (read as PluginReader<T>)();
	}
	return undefined;
}
