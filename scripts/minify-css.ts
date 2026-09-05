import { readFile, writeFile } from "node:fs/promises";
import { transform } from "lightningcss";

const targets = {
	chrome: 100 << 16,
	firefox: 100 << 16,
	safari: 15 << 16,
};

export async function minifyCssFile(filePath: string): Promise<void> {
	const source = await readFile(filePath);
	const result = transform({
		filename: filePath,
		code: source,
		minify: true,
		sourceMap: false,
		targets,
	});
	await writeFile(filePath, result.code);
}
