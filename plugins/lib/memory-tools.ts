/**
 * Memory Plugin — Core Tools
 *
 * observation, memory-search, memory-get, memory-read, memory-update, memory-timeline
 *
 * Uses factory pattern: createCoreTools(deps) returns tool definitions
 * that can be spread into plugin's tool:{} export.
 */

import { readdir } from "node:fs/promises";
import path from "node:path";
import { tool } from "@opencode-ai/plugin/tool";
import {
	type ConfidenceLevel,
	checkFTS5Available,
	getMemoryFile,
	getObservationsByIds,
	getTimelineAroundObservation,
	type ObservationSource,
	type ObservationType,
	searchDistillationsFTS,
	searchObservationsFTS,
	storeObservation,
	upsertMemoryFile,
} from "./memory-db.js";
import {
	autoDetectFiles,
	formatObservation,
	parseCSV,
	safeReadFile,
	TYPE_ICONS,
	VALID_TYPES,
} from "./memory-helpers.js";

interface CoreToolDeps {
	handoffDir: string;
}

export function createCoreTools(deps: CoreToolDeps) {
	const { handoffDir } = deps;

	return {
		observation: tool({
			description: `Create a structured observation for future reference.\n\t\n\tPurpose:\n\t- Capture decisions, bugs, features, patterns, discoveries, learnings, or warnings\n\t- Auto-detects file references from content (file:line, \`path\`, src/, .opencode/)\n\t- Stores in SQLite with FTS5 index for fast search\n\t- Supports enhanced schema: facts, subtitle, files_read/files_modified\n\t\n\tConfidence guidance:\n\t- high: verified by tests, logs, or direct inspection (default)\n\t- medium: likely, but not fully verified\n\t- low: uncertain or speculative\n\t\n\tType-specific examples:\n\tdecision\n\tobservation({\n\t  type: "decision",\n\t  title: "Use JWT for auth",\n\t  narrative: "Chose JWT for stateless auth across services.",\n\t  facts: "stateless, scalable",\n\t  concepts: "authentication, jwt",\n\t  confidence: "high"\n\t})\n\t\n\tbugfix\n\tobservation({\n\t  type: "bugfix",\n\t  title: "Fix null pointer on login",\n\t  narrative: "Guarded optional user in src/auth.ts:42 to prevent crash.",\n\t  files_modified: "src/auth.ts",\n\t  concepts: "auth, null-check",\n\t  confidence: "high"\n\t})\n\t\n\tfeature\n\tobservation({\n\t  type: "feature",\n\t  title: "Add CLI --dry-run",\n\t  narrative: "Introduce dry-run mode to show planned changes without writing.",\n\t  files_modified: "src/commands/init.ts",\n\t  concepts: "cli, ux",\n\t  confidence: "medium"\n\t})\n\t\n\tpattern\n\tobservation({\n\t  type: "pattern",\n\t  title: "Use zod for input validation",\n\t  narrative: "All command inputs validated with zod schemas before execute.",\n\t  concepts: "validation, zod",\n\t  confidence: "high"\n\t})\n\t\n\tdiscovery\n\tobservation({\n\t  type: "discovery",\n\t  title: "Build copies .opencode/ to dist/template/",\n\t  narrative: "Found rsync step in build.ts that bundles .opencode/.",\n\t  files_read: "build.ts",\n\t  confidence: "high"\n\t})\n\t\n\tlearning\n\tobservation({\n\t  type: "learning",\n\t  title: "Bun test respects --watch",\n\t  narrative: "Observed bun test --watch keeps runner active during edits.",\n\t  confidence: "medium"\n\t})\n\t\n\twarning\n\tobservation({\n\t  type: "warning",\n\t  title: "Do not edit dist/ directly",\n\t  narrative: "dist/ is built output and overwritten on build.",\n\t  concepts: "build, generated",\n\t  confidence: "high"\n\t})`,
			args: {
				type: tool.schema
					.string()
					.describe(
						"Observation type: decision, bugfix, feature, pattern, discovery, learning, warning",
					),
				title: tool.schema.string().describe("Brief title"),
				subtitle: tool.schema.string().optional().describe("Optional subtitle"),
				facts: tool.schema
					.string()
					.optional()
					.describe("Comma-separated key facts"),
				narrative: tool.schema.string().optional().describe("Detailed content"),
				content: tool.schema
					.string()
					.optional()
					.describe("DEPRECATED: Use 'narrative'"),
				concepts: tool.schema
					.string()
					.optional()
					.describe("Comma-separated concept tags"),
				files_read: tool.schema
					.string()
					.optional()
					.describe("Comma-separated files read"),
				files_modified: tool.schema
					.string()
					.optional()
					.describe("Comma-separated files modified"),
				files: tool.schema
					.string()
					.optional()
					.describe("DEPRECATED: Use 'files_modified'"),
				bead_id: tool.schema.string().optional().describe("Related bead ID"),
				confidence: tool.schema
					.string()
					.optional()
					.describe("high, medium, low"),
				supersedes: tool.schema
					.string()
					.optional()
					.describe("ID this supersedes"),
				source: tool.schema
					.string()
					.optional()
					.describe("manual, curator, imported"),
			},
			execute: async (args) => {
				const obsType = args.type as ObservationType;
				if (!VALID_TYPES.includes(obsType)) {
					return `Error: Invalid type "${args.type}". Valid: ${VALID_TYPES.join(", ")}`;
				}

				const confidence = (args.confidence ?? "high") as ConfidenceLevel;
				if (!["high", "medium", "low"].includes(confidence)) {
					return `Error: Invalid confidence "${args.confidence}". Valid: high, medium, low`;
				}

				const narrative = args.narrative ?? args.content;
				const filesModifiedRaw = args.files_modified ?? args.files;
				const facts = parseCSV(args.facts);
				const concepts = parseCSV(args.concepts);
				let filesRead = parseCSV(args.files_read);
				const filesModified = parseCSV(filesModifiedRaw);

				if (narrative) {
					const detected = autoDetectFiles(narrative);
					if (detected.length > 0) {
						const existing = new Set([
							...(filesRead ?? []),
							...(filesModified ?? []),
						]);
						const newRefs = detected.filter((f) => !existing.has(f));
						if (newRefs.length > 0)
							filesRead = [...(filesRead ?? []), ...newRefs];
					}
				}

				let supersedes: number | undefined;
				if (args.supersedes) {
					const parsed = Number.parseInt(args.supersedes, 10);
					if (!Number.isNaN(parsed)) supersedes = parsed;
				}

				const source = (args.source ?? "manual") as ObservationSource;

				const id = storeObservation({
					type: obsType,
					title: args.title,
					subtitle: args.subtitle,
					facts,
					narrative,
					concepts,
					files_read: filesRead,
					files_modified: filesModified,
					confidence,
					bead_id: args.bead_id,
					supersedes,
					source,
				});

				return `${TYPE_ICONS[obsType] ?? "\uD83D\uDCCC"} Observation #${id} stored [${obsType}] "${args.title}" (confidence: ${confidence}, source: ${source})`;
			},
		}),

		"memory-search": tool({
			description: `Search memory across observations and markdown archives.\n\t\n\tPurpose:\n\t- Fast, ranked search across all observations in SQLite (when FTS5 is available)\n\t- Returns compact index (~50-100 tokens per result) for progressive disclosure\n\t- Use memory-get for full details after identifying relevant observations\n\t\n\tFTS5 availability:\n\t- Auto-detected at runtime; if unavailable, observation searches fall back to file scan\n\t\n\tSearch modes and hints:\n\t- "observations" (default): Best for decisions, bugs, learnings; uses FTS5 ranking when available\n\t- "handoffs": Use for past session handoffs and summaries\n\t- "research": Use for research notes and external findings\n\t- "templates": Use for memory templates and boilerplate references\n\t- "beads": Use for task artifacts in .beads/artifacts\n\t- "all": Use when you are unsure where info lives; searches SQLite + markdown + beads\n\t\n\tExample:\n\tmemory-search({ query: "authentication" })\n\tmemory-search({ query: "auth", type: "decision", limit: 5 })`,
			args: {
				query: tool.schema.string().describe("Search query"),
				type: tool.schema
					.string()
					.optional()
					.describe("Filter by type or scope"),
				limit: tool.schema
					.number()
					.optional()
					.describe("Max results (default: 10)"),
			},
			execute: async (args) => {
				const query = args.query.trim();
				if (!query) return "Error: Empty search query";
				const limit = args.limit ?? 10;
				const scope = args.type ?? "observations";
				const lines: string[] = [];

				if (
					scope === "observations" ||
					scope === "all" ||
					VALID_TYPES.includes(scope as ObservationType)
				) {
					const typeFilter = VALID_TYPES.includes(scope as ObservationType)
						? (scope as ObservationType)
						: undefined;
					if (checkFTS5Available()) {
						const results = searchObservationsFTS(query, {
							type: typeFilter,
							limit,
						});
						if (results.length > 0) {
							lines.push(`## Observations (${results.length} results)\n`);
							lines.push("| ID | Type | Title | Date |");
							lines.push("|---|---|---|---|");
							for (const r of results)
								lines.push(
									`| ${r.id} | ${r.type} | ${r.title} | ${r.created_at.slice(0, 10)} |`,
								);
							lines.push("");
							for (const r of results.slice(0, 3)) {
								if (r.snippet) lines.push(`**#${r.id}**: ${r.snippet}`);
							}
							lines.push(
								`\nUse \`memory-get({ ids: "${results
									.slice(0, 3)
									.map((r) => r.id)
									.join(",")}" })\` for full details.`,
							);
						} else {
							lines.push("No observation matches found.");
						}
					} else {
						lines.push("FTS5 not available. Use memory-admin to check status.");
					}
				}

				if (scope === "distillations" || scope === "all") {
					const distResults = searchDistillationsFTS(query, limit);
					if (distResults.length > 0) {
						lines.push(`\n## Distillations (${distResults.length} results)\n`);
						for (const d of distResults) {
							lines.push(
								`- **Session ${d.session_id.slice(0, 8)}** (${d.message_count} msgs): ${d.snippet}`,
							);
						}
					}
				}

				if (scope === "handoffs" || scope === "all") {
					try {
						const handoffFiles = await readdir(handoffDir);
						const matches: string[] = [];
						for (const f of handoffFiles.filter((n) => n.endsWith(".md"))) {
							const content = await safeReadFile(path.join(handoffDir, f));
							if (content.toLowerCase().includes(query.toLowerCase()))
								matches.push(f);
						}
						if (matches.length > 0) {
							lines.push(`\n## Handoffs (${matches.length} matches)\n`);
							for (const m of matches.slice(0, 5)) lines.push(`- ${m}`);
						}
					} catch {
						/* No handoffs directory */
					}
				}

				return lines.length > 0 ? lines.join("\n") : "No results found.";
			},
		}),

		"memory-get": tool({
			description: `Get full observation details by ID.\n\t\n\tPurpose:\n\t- Progressive disclosure: fetch full details after identifying relevant observations via search\n\t- Get complete narrative, facts, and metadata\n\t- Supports multiple IDs for batch retrieval\n\t\n\tExample:\n\tmemory-get({ ids: "42" })           // Single observation\n\tmemory-get({ ids: "1,5,10" })       // Multiple observations`,
			args: {
				ids: tool.schema.string().describe("Comma-separated observation IDs"),
			},
			execute: async (args) => {
				const idList = args.ids
					.split(",")
					.map((s) => Number.parseInt(s.trim(), 10))
					.filter((n) => !Number.isNaN(n));
				if (idList.length === 0) return "Error: No valid IDs provided";
				const observations = getObservationsByIds(idList);
				if (observations.length === 0)
					return "No observations found for given IDs.";
				return observations
					.map((obs) => formatObservation(obs))
					.join("\n\n---\n\n");
			},
		}),

		"memory-read": tool({
			description: `Read memory files for persistent cross-session context.\n\t\n\tPurpose:\n\t- Retrieve project state, learnings, and active tasks\n\t- Reads from SQLite database\n\t- Supports subdirectories: handoffs/, research/\n\t\n\tExample:\n\tmemory-read({ file: "handoffs/2024-01-20-phase-1" })\n\tmemory-read({ file: "research/2024-01-topic" })`,
			args: {
				file: tool.schema.string().optional().describe("Memory file path"),
			},
			execute: async (args) => {
				const filePath = (args.file ?? "").replace(/\.md$/, "");
				if (!filePath) return "Error: No file path provided";
				const row = getMemoryFile(filePath);
				return row ? row.content : `Memory file "${filePath}" not found.`;
			},
		}),

		"memory-update": tool({
			description: `Update memory files with new learnings, progress, or context.\n\t\n\tPurpose:\n\t- Write or append to project memory in SQLite\n\t- Supports subdirectories (e.g., 'research/2024-01-topic')\n\t- Two modes: 'replace' (overwrite) or 'append' (add to end)\n\t\n\tExample:\n\tmemory-update({ file: "research/session-findings", content: "..." })\n\tmemory-update({ file: "handoffs/phase-2", content: "...", mode: "append" })`,
			args: {
				file: tool.schema.string().describe("Memory file to update"),
				content: tool.schema.string().describe("Content to write or append"),
				mode: tool.schema
					.string()
					.optional()
					.describe("replace (default) or append"),
			},
			execute: async (args) => {
				const filePath = args.file.replace(/\.md$/, "");
				const mode = (args.mode ?? "replace") as "replace" | "append";
				let finalContent = args.content;
				if (mode === "append") {
					finalContent = `\n---\n_Updated: ${new Date().toISOString()}_\n\n${args.content}`;
				}
				upsertMemoryFile(filePath, finalContent, mode);
				return `Memory file "${filePath}" updated (mode: ${mode}).`;
			},
		}),

		"memory-timeline": tool({
			description: `Get chronological context around an observation.\n\t\n\tPurpose:\n\t- Progressive disclosure: see what was happening before/after a specific observation\n\t- Understand decision context over time\n\t- Navigate memory timeline\n\t\n\tExample:\n\tmemory-timeline({ anchor_id: 42, depth_before: 5, depth_after: 5 })`,
			args: {
				anchor_id: tool.schema.number().describe("ID of the observation"),
				depth_before: tool.schema
					.number()
					.optional()
					.describe("Earlier observations (default: 5)"),
				depth_after: tool.schema
					.number()
					.optional()
					.describe("Later observations (default: 5)"),
			},
			execute: async (args) => {
				const { anchor, before, after } = getTimelineAroundObservation(
					args.anchor_id,
					args.depth_before ?? 5,
					args.depth_after ?? 5,
				);
				if (!anchor) return `Observation #${args.anchor_id} not found.`;
				const lines: string[] = [];
				if (before.length > 0) {
					lines.push("### Earlier");
					for (const b of before)
						lines.push(
							`  ${b.id}: [${b.type}] ${b.title} (${b.created_at.slice(0, 10)})`,
						);
				}
				lines.push(
					`\n### ${TYPE_ICONS[anchor.type] ?? "\uD83D\uDCCC"} Current: #${anchor.id} [${anchor.type}] ${anchor.title}`,
				);
				if (anchor.narrative) lines.push(anchor.narrative.slice(0, 200));
				if (after.length > 0) {
					lines.push("\n### Later");
					for (const a of after)
						lines.push(
							`  ${a.id}: [${a.type}] ${a.title} (${a.created_at.slice(0, 10)})`,
						);
				}
				return lines.join("\n");
			},
		}),
	};
}
