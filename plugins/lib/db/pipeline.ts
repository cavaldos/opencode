/**
 * Temporal Messages & Distillation Operations
 *
 * Manages the capture pipeline: raw messages → distillations → relevance scoring.
 * Includes TF-IDF-based relevance scoring with BM25, recency decay, and confidence weighting.
 */

import { getMemoryDB } from "./schema.js";
import type {
	DistillationInput,
	DistillationRow,
	DistillationSearchResult,
	TemporalMessageInput,
	TemporalMessageRow,
} from "./types.js";
import { MEMORY_CONFIG } from "./types.js";

// ============================================================================
// Temporal Message Operations
// ============================================================================

/**
 * Store a captured message in temporal storage.
 * Uses INSERT OR IGNORE to handle duplicate message_ids gracefully.
 */
export function storeTemporalMessage(input: TemporalMessageInput): number {
	const db = getMemoryDB();
	const now = new Date().toISOString();

	// Cap content length
	const content = input.content.slice(
		0,
		MEMORY_CONFIG.capture.maxContentLength,
	);

	const result = db
		.query(
			`
    INSERT OR IGNORE INTO temporal_messages
      (session_id, message_id, role, content, token_estimate, time_created, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `,
		)
		.run(
			input.session_id,
			input.message_id,
			input.role,
			content,
			input.token_estimate,
			input.time_created,
			now,
		);

	return Number(result.lastInsertRowid);
}

/**
 * Get undistilled messages for a session (messages not yet part of a distillation).
 */
export function getUndistilledMessages(
	sessionId: string,
	limit?: number,
): TemporalMessageRow[] {
	const db = getMemoryDB();
	const maxLimit = limit ?? MEMORY_CONFIG.distillation.maxMessages;

	return db
		.query(
			`
    SELECT * FROM temporal_messages
    WHERE session_id = ? AND distillation_id IS NULL
    ORDER BY time_created ASC
    LIMIT ?
  `,
		)
		.all(sessionId, maxLimit) as TemporalMessageRow[];
}

/**
 * Get count of undistilled messages, optionally filtered by session.
 */
export function getUndistilledMessageCount(sessionId?: string): number {
	const db = getMemoryDB();

	if (sessionId) {
		const row = db
			.query(
				"SELECT COUNT(*) as count FROM temporal_messages WHERE session_id = ? AND distillation_id IS NULL",
			)
			.get(sessionId) as { count: number };
		return row.count;
	}

	const row = db
		.query(
			"SELECT COUNT(*) as count FROM temporal_messages WHERE distillation_id IS NULL",
		)
		.get() as { count: number };
	return row.count;
}

/**
 * Mark messages as distilled by linking them to a distillation.
 */
export function markMessagesDistilled(
	messageIds: number[],
	distillationId: number,
): void {
	if (messageIds.length === 0) return;

	const db = getMemoryDB();
	const placeholders = messageIds.map(() => "?").join(",");
	db.run(
		`UPDATE temporal_messages SET distillation_id = ? WHERE id IN (${placeholders})`,
		[distillationId, ...messageIds],
	);
}

/**
 * Delete old temporal messages beyond retention period.
 */
export function purgeOldTemporalMessages(olderThanDays?: number): number {
	const db = getMemoryDB();
	const days = olderThanDays ?? MEMORY_CONFIG.capture.maxAgeDays;
	const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

	const result = db.run(
		"DELETE FROM temporal_messages WHERE time_created < ? AND distillation_id IS NOT NULL",
		[cutoff],
	);

	return result.changes;
}

/**
 * Get capture stats for temporal messages.
 */
export function getCaptureStats(): {
	total: number;
	undistilled: number;
	sessions: number;
	oldestMs: number | null;
	newestMs: number | null;
} {
	const db = getMemoryDB();

	const total = (
		db.query("SELECT COUNT(*) as count FROM temporal_messages").get() as {
			count: number;
		}
	).count;

	const undistilled = (
		db
			.query(
				"SELECT COUNT(*) as count FROM temporal_messages WHERE distillation_id IS NULL",
			)
			.get() as { count: number }
	).count;

	const sessions = (
		db
			.query(
				"SELECT COUNT(DISTINCT session_id) as count FROM temporal_messages",
			)
			.get() as {
			count: number;
		}
	).count;

	const timeRange = db
		.query(
			"SELECT MIN(time_created) as oldest, MAX(time_created) as newest FROM temporal_messages",
		)
		.get() as { oldest: number | null; newest: number | null };

	return {
		total,
		undistilled,
		sessions,
		oldestMs: timeRange.oldest,
		newestMs: timeRange.newest,
	};
}

// ============================================================================
// Distillation Operations
// ============================================================================

/**
 * Store a new distillation.
 */
export function storeDistillation(input: DistillationInput): number {
	const db = getMemoryDB();
	const now = Date.now();
	const nowISO = new Date(now).toISOString();

	const result = db
		.query(
			`
    INSERT INTO distillations
      (session_id, content, terms, message_count, compression_ratio,
       time_start, time_end, time_created, meta_distillation_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
		)
		.run(
			input.session_id,
			input.content,
			JSON.stringify(input.terms),
			input.message_count,
			input.compression_ratio,
			input.time_start,
			input.time_end,
			now,
			input.meta_distillation_id ?? null,
			nowISO,
		);

	return Number(result.lastInsertRowid);
}

/**
 * Get distillation by ID.
 */
export function getDistillationById(id: number): DistillationRow | null {
	const db = getMemoryDB();
	return db
		.query("SELECT * FROM distillations WHERE id = ?")
		.get(id) as DistillationRow | null;
}

/**
 * Get recent distillations, optionally filtered by session.
 */
export function getRecentDistillations(
	sessionId?: string,
	limit = 10,
): DistillationRow[] {
	const db = getMemoryDB();

	if (sessionId) {
		return db
			.query(
				`SELECT * FROM distillations
         WHERE session_id = ?
         ORDER BY time_created DESC LIMIT ?`,
			)
			.all(sessionId, limit) as DistillationRow[];
	}

	return db
		.query("SELECT * FROM distillations ORDER BY time_created DESC LIMIT ?")
		.all(limit) as DistillationRow[];
}

/**
 * Search distillations using FTS5.
 */
export function searchDistillationsFTS(
	query: string,
	limit = 10,
): DistillationSearchResult[] {
	const db = getMemoryDB();

	const ftsQuery = query
		.replace(/['"]/g, '""')
		.split(/\s+/)
		.filter((term) => term.length > 0)
		.map((term) => `"${term}"*`)
		.join(" OR ");

	if (!ftsQuery) return [];

	try {
		return db
			.query(
				`
      SELECT d.id, d.session_id,
             substr(d.content, 1, 150) as snippet,
             d.message_count, d.created_at,
             bm25(distillations_fts) as relevance_score
      FROM distillations d
      JOIN distillations_fts fts ON fts.rowid = d.id
      WHERE distillations_fts MATCH ?
      ORDER BY relevance_score
      LIMIT ?
    `,
			)
			.all(ftsQuery, limit) as DistillationSearchResult[];
	} catch {
		// FTS5 failed, fallback to LIKE
		const likePattern = `%${query}%`;
		return db
			.query(
				`
      SELECT id, session_id,
             substr(content, 1, 150) as snippet,
             message_count, created_at,
             0 as relevance_score
      FROM distillations
      WHERE content LIKE ?
      ORDER BY time_created DESC
      LIMIT ?
    `,
			)
			.all(likePattern, limit) as DistillationSearchResult[];
	}
}

/**
 * Get distillation stats.
 */
export function getDistillationStats(): {
	total: number;
	sessions: number;
	avgCompression: number;
	totalMessages: number;
} {
	const db = getMemoryDB();

	const row = db
		.query(
			`
    SELECT
      COUNT(*) as total,
      COUNT(DISTINCT session_id) as sessions,
      AVG(compression_ratio) as avg_compression,
      SUM(message_count) as total_messages
    FROM distillations
  `,
		)
		.get() as {
		total: number;
		sessions: number;
		avg_compression: number | null;
		total_messages: number | null;
	};

	return {
		total: row.total,
		sessions: row.sessions,
		avgCompression: row.avg_compression ?? 0,
		totalMessages: row.total_messages ?? 0,
	};
}

// ============================================================================
// Relevance Scoring & Token Estimation
// ============================================================================

/**
 * Get all observations scored by relevance for injection.
 * Combines BM25 relevance with recency decay and confidence weighting.
 */
export function getRelevantKnowledge(
	queryTerms: string[],
	options: {
		tokenBudget?: number;
		minScore?: number;
		limit?: number;
	} = {},
): Array<{
	id: number;
	type: string;
	title: string;
	content: string;
	score: number;
	source: "observation" | "distillation";
	created_at: string;
}> {
	const db = getMemoryDB();
	const budget = options.tokenBudget ?? MEMORY_CONFIG.injection.tokenBudget;
	const minScore = options.minScore ?? MEMORY_CONFIG.injection.minScore;
	const limit = options.limit ?? 50;

	if (queryTerms.length === 0) return [];

	const ftsQuery = queryTerms
		.map((term) => `"${term.replace(/['"]/g, '""')}"*`)
		.join(" OR ");

	const results: Array<{
		id: number;
		type: string;
		title: string;
		content: string;
		score: number;
		source: "observation" | "distillation";
		created_at: string;
	}> = [];

	// Search observations
	try {
		const obsResults = db
			.query(
				`
      SELECT o.id, o.type, o.title,
             COALESCE(o.narrative, o.title) as content,
             bm25(observations_fts) as bm25_score,
             o.confidence, o.created_at_epoch, o.created_at
      FROM observations o
      JOIN observations_fts fts ON fts.rowid = o.id
      WHERE observations_fts MATCH ?
        AND o.superseded_by IS NULL
      ORDER BY bm25_score
      LIMIT ?
    `,
			)
			.all(ftsQuery, limit) as Array<{
			id: number;
			type: string;
			title: string;
			content: string;
			bm25_score: number;
			confidence: string;
			created_at_epoch: number;
			created_at: string;
		}>;

		const now = Date.now();
		for (const row of obsResults) {
			// Combine BM25 with recency and confidence
			const ageHours = (now - row.created_at_epoch) / (1000 * 60 * 60);
			const recencyFactor =
				MEMORY_CONFIG.injection.recencyDecay ** (ageHours / 24);
			const confidenceWeight =
				row.confidence === "high"
					? 1.0
					: row.confidence === "medium"
						? 0.7
						: 0.4;
			// BM25 scores are negative (lower = better), so negate
			const score = -row.bm25_score * recencyFactor * confidenceWeight;

			if (score >= minScore) {
				results.push({
					id: row.id,
					type: row.type,
					title: row.title,
					content: row.content,
					score,
					source: "observation",
					created_at: row.created_at,
				});
			}
		}
	} catch {
		// FTS5 query failed
	}

	// Search distillations
	try {
		const distResults = db
			.query(
				`
      SELECT d.id, d.content,
             bm25(distillations_fts) as bm25_score,
             d.time_created, d.created_at
      FROM distillations d
      JOIN distillations_fts fts ON fts.rowid = d.id
      WHERE distillations_fts MATCH ?
      ORDER BY bm25_score
      LIMIT ?
    `,
			)
			.all(ftsQuery, limit) as Array<{
			id: number;
			content: string;
			bm25_score: number;
			time_created: number;
			created_at: string;
		}>;

		const now = Date.now();
		for (const row of distResults) {
			const ageHours = (now - row.time_created) / (1000 * 60 * 60);
			const recencyFactor =
				MEMORY_CONFIG.injection.recencyDecay ** (ageHours / 24);
			const score = -row.bm25_score * recencyFactor;

			if (score >= minScore) {
				results.push({
					id: row.id,
					type: "distillation",
					title: `Session distillation`,
					content: row.content,
					score,
					source: "distillation",
					created_at: row.created_at,
				});
			}
		}
	} catch {
		// FTS5 query failed
	}

	// Sort by score descending, then greedy-pack within token budget
	results.sort((a, b) => b.score - a.score);

	const packed: typeof results = [];
	let usedTokens = 0;

	for (const item of results) {
		const itemTokens = estimateTokens(item.content);
		if (usedTokens + itemTokens <= budget) {
			packed.push(item);
			usedTokens += itemTokens;
		}
	}

	return packed;
}

/**
 * Rough token estimation (~4 chars per token).
 */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}
