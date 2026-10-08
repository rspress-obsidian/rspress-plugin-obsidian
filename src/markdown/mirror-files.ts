import fs from "node:fs/promises";
import path from "node:path";

/**
 * Make `dir` hold exactly `wanted` (path relative to `dir` → source file):
 * copy what is new or changed, delete what is no longer wanted. A file the
 * previous build published and nothing references any more must stop being
 * served, not linger.
 */
export async function mirrorFiles(dir: string, wanted: ReadonlyMap<string, string>): Promise<void> {
	const existing = await fs.readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
	for (const entry of existing) {
		if (!entry.isFile()) continue;
		const absolute = path.join(entry.parentPath, entry.name);
		const relative = path.relative(dir, absolute).split(path.sep).join("/");
		if (!wanted.has(relative)) await fs.rm(absolute, { force: true });
	}
	for (const [relative, source] of wanted) {
		const target = path.join(dir, ...relative.split("/"));
		const [from, to] = await Promise.all([fs.stat(source), fs.stat(target).catch(() => undefined)]);
		if (to && to.size === from.size && to.mtimeMs === from.mtimeMs) continue;
		await fs.mkdir(path.dirname(target), { recursive: true });
		await fs.copyFile(source, target);
		await fs.utimes(target, from.atime, from.mtime);
	}
}
