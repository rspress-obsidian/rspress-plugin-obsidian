import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

// Dependabot's `bun` updater rewrites a package's peer range whenever it bumps
// the devDependency of the same name (`versioning-strategy` cannot stop it for
// `bun`). A narrowed peer range is a breaking change for every site still on
// the older version, and CI stays green because the repo itself installs the
// newer one. Each entry is the oldest version a site may run with; raising one
// is a deliberate breaking change, made here and in the docs together.
const SUPPORTED_FLOORS: Record<string, string[]> = {
	"@excalidraw/excalidraw": ["0.18.1"],
	"@rspress/core": ["2.0.21"],
	"lucide-static": ["0.300.0"],
	"maplibre-gl": ["5.0.0", "6.0.0"],
	"mathjax-full": ["3.2.2"],
	mermaid: ["11.17.2", "12.2.0"],
	react: ["18.0.0", "19.0.0"],
	"react-dom": ["18.0.0", "19.0.0"],
	"react-force-graph-2d": ["1.29.1"],
};

const manifest = JSON.parse(
	fs.readFileSync(path.join(import.meta.dirname, "..", "package.json"), "utf-8"),
) as { peerDependencies: Record<string, string> };

test("every peer range still accepts the oldest supported version of each major", () => {
	const narrowed = Object.entries(SUPPORTED_FLOORS).flatMap(([name, floors]) =>
		floors
			.filter((floor) => !Bun.semver.satisfies(floor, manifest.peerDependencies[name] ?? ""))
			.map((floor) => `${name}@${floor} is outside "${manifest.peerDependencies[name]}"`),
	);
	expect(narrowed).toEqual([]);
});

test("every peer has a supported floor recorded", () => {
	expect(Object.keys(manifest.peerDependencies).sort()).toEqual(
		Object.keys(SUPPORTED_FLOORS).sort(),
	);
});
