/**
 * Memory Database Types & Configuration
 *
 * All types, interfaces, and configuration constants for the 4-tier memory system.
 * This module has zero internal dependencies — safe to import anywhere.
 */

// ============================================================================
// Configuration
// ============================================================================

export type ConfidenceLevel = "high" | "medium" | "low";

export const MEMORY_CONFIG = {
	capture: {
		enabled: true,
		maxContentLength: 4000,
		maxAgeDays: 180,
	},
	distillation: {
		enabled: true,
		minMessages: 10,
		maxMessages: 50,
		compressionTarget: 0.2,
		topTerms: 30,
	},
	curator: {
		enabled: true,
		minDistillations: 3,
		defaultConfidence: "medium" as ConfidenceLevel,
	},
	injection: {
		enabled: true,
		tokenBudget: 2000,
		recencyDecay: 0.95,
		minScore: 0.1,
		topTerms: 30,
	},
	context: {
		enabled: true,
		maxContextTokens: 100_000,
		protectedMessages: 5,
	},
	fts: {
		tokenizer: "porter unicode61",
	},
} as const;

// ============================================================================
// Observation Types
// ============================================================================

export type ObservationType =
	| "decision"
	| "bugfix"
	| "feature"
	| "pattern"
	| "discovery"
	| "learning"
	| "warning";

export type ObservationSource = "manual" | "curator" | "imported";

export interface ObservationRow {
	id: number;
	type: ObservationType;
	title: string;
	subtitle: string | null;
	facts: string | null; // JSON array
	narrative: string | null;
	concepts: string | null; // JSON array
	files_read: string | null; // JSON array
	files_modified: string | null; // JSON array
	confidence: ConfidenceLevel;
	bead_id: string | null;
	supersedes: number | null;
	superseded_by: number | null;
	valid_until: string | null;
	markdown_file: string | null;
	source: ObservationSource;
	created_at: string;
	created_at_epoch: number;
	updated_at: string | null;
}

export interface ObservationInput {
	type: ObservationType;
	title: string;
	subtitle?: string;
	facts?: string[];
	narrative?: string;
	concepts?: string[];
	files_read?: string[];
	files_modified?: string[];
	confidence?: ConfidenceLevel;
	bead_id?: string;
	supersedes?: number;
	markdown_file?: string;
	source?: ObservationSource;
}

export interface SearchIndexResult {
	id: number;
	type: ObservationType;
	title: string;
	snippet: string;
	created_at: string;
	relevance_score: number;
}

// ============================================================================
// Memory File Types
// ============================================================================

export interface MemoryFileRow {
	id: number;
	file_path: string;
	content: string;
	mode: "replace" | "append";
	created_at: string;
	created_at_epoch: number;
	updated_at: string | null;
	updated_at_epoch: number | null;
}

// ============================================================================
// Temporal Message Types (v2)
// ============================================================================

export interface TemporalMessageRow {
	id: number;
	session_id: string;
	message_id: string;
	role: string;
	content: string;
	token_estimate: number;
	time_created: number;
	distillation_id: number | null;
	created_at: string;
}

export interface TemporalMessageInput {
	session_id: string;
	message_id: string;
	role: string;
	content: string;
	token_estimate: number;
	time_created: number;
}

// ============================================================================
// Distillation Types (v2)
// ============================================================================

export interface DistillationRow {
	id: number;
	session_id: string;
	content: string;
	terms: string; // JSON array of top-N TF-IDF terms
	message_count: number;
	compression_ratio: number;
	time_start: number;
	time_end: number;
	time_created: number;
	meta_distillation_id: number | null;
	created_at: string;
}

export interface DistillationInput {
	session_id: string;
	content: string;
	terms: string[];
	message_count: number;
	compression_ratio: number;
	time_start: number;
	time_end: number;
	meta_distillation_id?: number;
}

export interface DistillationSearchResult {
	id: number;
	session_id: string;
	snippet: string;
	message_count: number;
	created_at: string;
	relevance_score: number;
}

// ============================================================================
// Maintenance Types
// ============================================================================

export interface MaintenanceStats {
	archived: number;
	vacuumed: boolean;
	checkpointed: boolean;
	prunedMarkdown: number;
	purgedMessages: number;
	freedBytes: number;
	dbSizeBefore: number;
	dbSizeAfter: number;
}

export interface ArchiveOptions {
	/** Archive observations older than this many days (default: 90) */
	olderThanDays?: number;
	/** Archive superseded observations regardless of age */
	includeSuperseded?: boolean;
	/** Dry run — don't actually archive, just count */
	dryRun?: boolean;
}
