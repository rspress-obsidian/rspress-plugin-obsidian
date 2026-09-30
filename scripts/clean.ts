#!/usr/bin/env bun
/**
 * Removes a build output directory (`dist/` by default).
 *
 * `build` used to inline this as
 * `node -e "require('node:fs').rmSync('dist',{recursive:true,force:true})"`,
 * whose nested quotes are re-parsed by whatever shell runs the script — sh,
 * cmd.exe and PowerShell all disagree about which quotes survive — so the
 * build only worked where the quoting happened to come out intact. A script
 * file has no quoting for a shell to reinterpret.
 *
 * A missing directory is not an error (`force: true`), so `bun run build` on a
 * fresh checkout behaves exactly as the one-liner did.
 *
 * Usage: `bun scripts/clean.ts [dir]`. The directory is resolved against the
 * repo root, not the caller's cwd, so the build never deletes an unrelated
 * `dist/` in a subdirectory or a sibling package.
 */
import { rmSync } from "node:fs";
import path from "node:path";

const target = path.resolve(process.argv[2] ?? path.join(import.meta.dir, "..", "dist"));

rmSync(target, { recursive: true, force: true });
