/**
 * Memory Plugin — Helpers
 *
 * Constants, tool formatting helpers, and file utilities.
 * Pure functions — no plugin/closure dependencies.
 */

import { readFile } from "node:fs/promises";
import type { ObservationType } from "./memory-db.js";

// ============================================================================
// Constants
// ============================================================================

export const VALID_TYPES: ObservationType[] = [
	"decision",
	"bugfix",
	"feature",
	"pattern",
	"discovery",
	"learning",
	"warning",
];

export const TYPE_ICONS: Record<string, string> = {
	decision: "\u2696\uFE0F",
	bugfix: "\uD83D\uDC1B",
	feature: "\u2728",
	pattern: "\uD83D\uDD04",
	discovery: "\uD83D\uDD2D",
	learning: "\uD83D\uDCDA",
	warning: "\u26A0\uFE0F",
};

export const FILE_REF_PATTERNS = [
	/(?:^|\s)(\S+\.(?:ts|tsx|js|jsx|json|md|yaml|yml|toml|sql|sh|py|rs|go)):(\d+)/g,
	/`([^`]+\.(?:ts|tsx|js|jsx|json|md|yaml|yml|toml))`/g,
	/(?:^|\s)(src\/\S+)/gm,
	/(?:^|\s)(\.opencode\/\S+)/gm,
];

// ============================================================================
// File Helpers
// ============================================================================

export async function safeReadFile(filePath: string): Promise<string> {
	try {
		return await readFile(filePath, "utf-8");
	} catch {
		return "";
	}
}

// ============================================================================
// Tool Helpers
// ============================================================================

export function autoDetectFiles(text: string): string[] {
	const files = new Set<string>();
	for (const pattern of FILE_REF_PATTERNS) {
		const regex = new RegExp(pattern.source, pattern.flags);
		let match: RegExpExecArray | null;
		while ((match = regex.exec(text)) !== null) {
			files.add(match[1]);
		}
	}
	return [...files];
}

export function parseCSV(value: string | undefined): string[] | undefined {
	if (!value) return undefined;
	return value
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

export function formatObservation(obs: {
	id: number;
	type: string;
	title: string;
	subtitle?: string | null;
	confidence?: string | null;
	concepts?: string | null;
	files_read?: string | null;
	files_modified?: string | null;
	facts?: string | null;
	narrative?: string | null;
	bead_id?: string | null;
	supersedes?: number | null;
	superseded_by?: number | null;
	source?: string | null;
	created_at?: string | null;
}): string {
	const icon = TYPE_ICONS[obs.type] ?? "\uD83D\uDCCC";
	const lines = [`${icon} **#${obs.id}** [${obs.type}] ${obs.title}`];
	if (obs.subtitle) lines.push(`  _${obs.subtitle}_`);
	if (obs.confidence) lines.push(`  Confidence: ${obs.confidence}`);
	if (obs.source && obs.source !== "manual")
		lines.push(`  Source: ${obs.source}`);
	if (obs.concepts) lines.push(`  Concepts: ${obs.concepts}`);
	if (obs.files_read) lines.push(`  Files read: ${obs.files_read}`);
	if (obs.files_modified) lines.push(`  Files modified: ${obs.files_modified}`);
	if (obs.facts) lines.push(`  Facts: ${obs.facts}`);
	if (obs.bead_id) lines.push(`  Bead: ${obs.bead_id}`);
	if (obs.supersedes) lines.push(`  Supersedes: #${obs.supersedes}`);
	if (obs.superseded_by) lines.push(`  Superseded by: #${obs.superseded_by}`);
	if (obs.narrative) lines.push(`\n${obs.narrative}`);
	if (obs.created_at) lines.push(`\n  _Created: ${obs.created_at}_`);
	return lines.join("\n");
}
