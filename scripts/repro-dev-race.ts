#!/usr/bin/env bun
/**
 * Reproduces the Rspack watch race that crashed `rspress dev` while a reader
 * opened or hovered pages ("attempted to read from stolen value" on Rspack
 * 2.2.2, "Compilation dependencies are not available" on 2.2.8). Each attempt
 * starts a fresh dev server, walks to a Mermaid page in Chromium, then sweeps
 * the mouse over the sidebar and clicks links. An attempt fails when the
 * server dies or no diagram renders.
 *
 *   ATTEMPTS=4 SWEEP_MS=20000 bun scripts/repro-dev-race.ts
 */
import path from "node:path";
import { chromium } from "@playwright/test";

const ATTEMPTS = Number(process.env.ATTEMPTS ?? 4);
const SWEEP_MS = Number(process.env.SWEEP_MS ?? 20_000);
const REPO = path.join(import.meta.dirname, "..");
const CRASH = /Panic occurred|panicked at|stolen value|not available while a compilation pass/;

interface AttemptResult {
	failed: boolean;
	serverDied: boolean;
	diagrams: number;
	log: string;
}

async function attempt(index: number): Promise<AttemptResult> {
	const port = 4600 + index;
	const origin = `http://localhost:${port}`;
	let log = "";
	const server = Bun.spawn(["bunx", "rspress", "dev", "--port", String(port)], {
		cwd: REPO,
		env: { ...process.env, FORCE_COLOR: "0" },
		stdout: "pipe",
		stderr: "pipe",
	});
	const decoder = new TextDecoder();
	for (const stream of [server.stdout, server.stderr]) {
		void (async () => {
			for await (const chunk of stream) log += decoder.decode(chunk);
		})();
	}
	let serverDied = false;
	void server.exited.then(() => {
		serverDied = true;
	});
	const readyBy = Date.now() + 60_000;
	while (!/building virtual modules[\s\S]*ready/.test(log) && !serverDied && Date.now() < readyBy) {
		await Bun.sleep(200);
	}

	const browser = await chromium.launch();
	const page = await browser.newPage();
	let diagrams = 0;
	try {
		await page.goto(`${origin}/markdown/`, { timeout: 60_000 }).catch(() => {});
		await page.waitForTimeout(2500);
		const examples = page.locator('a[href^="/markdown/guide/examples"]').first();
		if ((await examples.count()) > 0) await examples.click({ timeout: 10_000 }).catch(() => {});
		else await page.goto(`${origin}/markdown/guide/examples`, { timeout: 60_000 }).catch(() => {});
		for (let waited = 0; waited < 20_000 && !serverDied && diagrams === 0; waited += 500) {
			await page.waitForTimeout(500);
			diagrams = await page
				.locator(".obsidian-mermaid-rendered svg")
				.count()
				.catch(() => 0);
		}

		const sweepUntil = Date.now() + SWEEP_MS;
		while (Date.now() < sweepUntil && !serverDied) {
			const links = await page.locator("aside a[href^='/'], nav a[href^='/']").all();
			for (const link of links) {
				if (Date.now() >= sweepUntil || serverDied) break;
				await link.hover({ timeout: 1000 }).catch(() => {});
				await page.waitForTimeout(40 + Math.random() * 160);
			}
			const target = links[Math.floor(Math.random() * links.length)];
			if (target) await target.click({ timeout: 2000 }).catch(() => {});
		}
		// The crash surfaces after the build that the last hover started.
		await page.waitForTimeout(1500);
	} finally {
		await browser.close();
	}
	const died = serverDied;
	server.kill();
	await server.exited;
	return { failed: died || CRASH.test(log) || diagrams === 0, serverDied: died, diagrams, log };
}

let failures = 0;
for (let index = 0; index < ATTEMPTS; index += 1) {
	const { failed, serverDied, diagrams, log } = await attempt(index);
	if (failed) failures += 1;
	console.log(
		`attempt ${index + 1}: ${failed ? "FAIL" : "ok"} (server ${serverDied ? "died" : "alive"}, diagrams ${diagrams})`,
	);
	if (failed) {
		const crashLines = log.split("\n").filter((line) => CRASH.test(line) || /^Error/.test(line));
		console.log(crashLines.join("\n"));
	}
}
console.log(`${failures}/${ATTEMPTS} attempts failed (sweep ${SWEEP_MS} ms)`);
process.exitCode = failures > 0 ? 1 : 0;
