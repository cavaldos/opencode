/**
 * Memory Plugin — Admin Tools
 *
 * memory-admin (9 operations).
 *
 * Uses factory pattern: createAdminTools(deps) returns tool definitions.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { tool } from "@opencode-ai/plugin/tool";
import { curateFromDistillations } from "./curator.js";
import { distillSession } from "./distill.js";
import {
	archiveOldObservations,
	type ConfidenceLevel,
	checkFTS5Available,
	checkpointWAL,
	getCaptureStats,
	getDatabaseSizes,
	getDistillationStats,
	getMarkdownFilesInSqlite,
	getObservationStats,
	type ObservationType,
	rebuildFTS5,
	runFullMaintenance,
	storeObservation,
	vacuumDatabase,
} from "./memory-db.js";

interface AdminToolDeps {
	directory: string;
}

export function createAdminTools(deps: AdminToolDeps) {
	const { directory } = deps;

	return {
		"memory-admin": tool({
			description: `Memory system administration: maintenance and migration.\n\nOperations:\n- "status": Storage stats and recommendations\n- "full": Full maintenance cycle (archive + checkpoint + vacuum)\n- "archive": Archive old observations (>90 days default)\n- "checkpoint": Checkpoint WAL file\n- "vacuum": Vacuum database\n- "migrate": Import .opencode/memory/observations/*.md into SQLite\n- "capture-stats": Temporal message capture statistics\n- "distill-now": Force distillation for current session\n- "curate-now": Force curator run\n\nExample:\nmemory-admin({ operation: "status" })\nmemory-admin({ operation: "migrate", dry_run: true })`,
			args: {
				operation: tool.schema
					.string()
					.optional()
					.describe("Operation (default: status)"),
				older_than_days: tool.schema
					.number()
					.optional()
					.describe("Archive threshold (default: 90)"),
				dry_run: tool.schema
					.boolean()
					.optional()
					.describe("Preview without executing"),
				force: tool.schema.boolean().optional().describe("Force re-migration"),
			},
			execute: async (args, ctx) => {
				const op = args.operation ?? "status";
				const dryRun = args.dry_run ?? false;
				const olderThanDays = args.older_than_days ?? 90;

				switch (op) {
					case "status": {
						const sizes = getDatabaseSizes();
						const stats = getObservationStats();
						const archivable = archiveOldObservations({
							olderThanDays,
							dryRun: true,
						});
						const captureStats = getCaptureStats();
						const distillStats = getDistillationStats();
						return [
							"## Memory System Status\n",
							`**Database**: ${(sizes.total / 1024).toFixed(1)} KB`,
							`**FTS5**: ${checkFTS5Available() ? "Available (porter stemming)" : "Unavailable"}`,
							`**Schema**: v2 (4-tier storage)\n`,
							"### Observations",
							...Object.entries(stats).map(([k, v]) => `  ${k}: ${v}`),
							`  Archivable (>${olderThanDays}d): ${archivable}\n`,
							"### Capture Pipeline",
							`  Messages: ${captureStats.total} (undistilled: ${captureStats.undistilled})`,
							`  Sessions: ${captureStats.sessions}\n`,
							"### Distillations",
							`  Total: ${distillStats.total} (${distillStats.sessions} sessions)`,
							`  Avg compression: ${(distillStats.avgCompression * 100).toFixed(1)}%`,
						].join("\n");
					}
					case "full": {
						if (dryRun)
							return `Dry run: would archive, purge, optimize, checkpoint, vacuum.`;
						const r = runFullMaintenance({
							olderThanDays,
							includeSuperseded: true,
						});
						return `Done: archived ${r.archived}, purged ${r.purgedMessages} msgs, freed ${(r.freedBytes / 1024).toFixed(1)} KB.`;
					}
					case "archive": {
						const c = archiveOldObservations({
							olderThanDays,
							includeSuperseded: true,
							dryRun,
						});
						return dryRun
							? `Would archive ${c} observations.`
							: `Archived ${c} observations.`;
					}
					case "checkpoint": {
						const r = checkpointWAL();
						return r.checkpointed
							? `WAL checkpointed (${r.walSize} pages).`
							: "Checkpoint failed or busy.";
					}
					case "vacuum":
						return vacuumDatabase() ? "Vacuumed." : "Vacuum failed.";
					case "capture-stats":
						return JSON.stringify(getCaptureStats(), null, 2);
					case "distill-now": {
						const sid = ctx?.sessionID;
						if (!sid) return "Error: No session ID.";
						const did = distillSession(sid);
						return did
							? `Distillation #${did} created.`
							: "Not enough undistilled messages.";
					}
					case "curate-now": {
						const r = curateFromDistillations();
						return `Created ${r.created}, skipped ${r.skipped}. Patterns: ${JSON.stringify(r.patterns)}`;
					}
					case "migrate": {
						const obsDir = path.join(
							directory,
							".opencode",
							"memory",
							"observations",
						);
						let mdFiles: string[] = [];
						try {
							mdFiles = (await readdir(obsDir)).filter((f) =>
								f.endsWith(".md"),
							);
						} catch {
							return "No observations directory found.";
						}
						if (mdFiles.length === 0) return "No files to migrate.";
						const existing = new Set(getMarkdownFilesInSqlite());
						const toMigrate = args.force
							? mdFiles
							: mdFiles.filter((f) => !existing.has(f));
						if (toMigrate.length === 0) return "All files already migrated.";
						if (dryRun) return `Would migrate ${toMigrate.length} files.`;
						let migrated = 0;
						for (const file of toMigrate) {
							try {
								const content = await readFile(
									path.join(obsDir, file),
									"utf-8",
								);
								const fmMatch = content.match(
									/^---\n([\s\S]*?)\n---\n([\s\S]*)$/,
								);
								const body = fmMatch ? fmMatch[2].trim() : content.trim();
								const fm = fmMatch ? fmMatch[1] : "";
								storeObservation({
									type: (fm.match(/type:\s*(\w+)/)?.[1] ??
										"discovery") as ObservationType,
									title:
										fm.match(/title:\s*(.+)/)?.[1]?.trim() ??
										file.replace(/\.md$/, ""),
									narrative: body,
									confidence: (fm.match(/confidence:\s*(\w+)/)?.[1] ??
										"medium") as ConfidenceLevel,
									markdown_file: file,
									source: "imported",
								});
								migrated++;
							} catch {
								/* Skip failed files */
							}
						}
						if (migrated > 0) rebuildFTS5();
						return `Migrated ${migrated}/${toMigrate.length} files.`;
					}
					default:
						return `Unknown operation: "${op}".`;
				}
			},
		}),
	};
}
