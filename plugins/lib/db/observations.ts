/**
 * Observation Operations
 *
 * CRUD, search, timeline, and stats for the observations table.
 * Uses FTS5 with porter stemming for full-text search with BM25 ranking.
 */

import { getMemoryDB } from "./schema.js";
import type {
	ObservationInput,
	ObservationRow,
	ObservationType,
	SearchIndexResult,
} from "./types.js";

// ============================================================================
// CRUD
// ============================================================================

/**
 * Store a new observation in the database.
 */
export function storeObservation(input: ObservationInput): number {
	const db = getMemoryDB();
	const now = new Date();

	const result = db
		.query(
			`
    INSERT INTO observations (
      type, title, subtitle, facts, narrative, concepts,
      files_read, files_modified, confidence, bead_id,
      supersedes, markdown_file, source, created_at, created_at_epoch
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
		)
		.run(
			input.type,
			input.title,
			input.subtitle ?? null,
			input.facts ? JSON.stringify(input.facts) : null,
			input.narrative ?? null,
			input.concepts ? JSON.stringify(input.concepts) : null,
			input.files_read ? JSON.stringify(input.files_read) : null,
			input.files_modified ? JSON.stringify(input.files_modified) : null,
			input.confidence ?? "high",
			input.bead_id ?? null,
			input.supersedes ?? null,
			input.markdown_file ?? null,
			input.source ?? "manual",
			now.toISOString(),
			now.getTime(),
		);

	const insertedId = Number(result.lastInsertRowid);

	// Update supersedes relationship
	if (input.supersedes) {
		db.run("UPDATE observations SET superseded_by = ? WHERE id = ?", [
			insertedId,
			input.supersedes,
		]);
	}

	return insertedId;
}

/**
 * Get observation by ID.
 */
export function getObservationById(id: number): ObservationRow | null {
	const db = getMemoryDB();
	return db
		.query("SELECT * FROM observations WHERE id = ?")
		.get(id) as ObservationRow | null;
}

/**
 * Get multiple observations by IDs.
 */
export function getObservationsByIds(ids: number[]): ObservationRow[] {
	if (ids.length === 0) return [];

	const db = getMemoryDB();
	const placeholders = ids.map(() => "?").join(",");
	return db
		.query(`SELECT * FROM observations WHERE id IN (${placeholders})`)
		.all(...ids) as ObservationRow[];
}

// ============================================================================
// Search
// ============================================================================

/**
 * Search observations using FTS5.
 * Returns compact index results for progressive disclosure.
 */
export function searchObservationsFTS(
	query: string,
	options: {
		type?: ObservationType;
		concepts?: string[];
		limit?: number;
	} = {},
): SearchIndexResult[] {
	const db = getMemoryDB();
	const limit = options.limit ?? 10;

	// Build FTS5 query — porter stemming handles word forms automatically
	const ftsQuery = query
		.replace(/['"]/g, '""')
		.split(/\s+/)
		.filter((term) => term.length > 0)
		.map((term) => `"${term}"*`)
		.join(" OR ");

	if (!ftsQuery) {
		// Empty query — return recent observations
		return db
			.query(
				`
      SELECT id, type, title,
             substr(COALESCE(narrative, ''), 1, 100) as snippet,
             created_at,
             0 as relevance_score
      FROM observations
      WHERE superseded_by IS NULL
      ${options.type ? "AND type = ?" : ""}
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `,
			)
			.all(
				...(options.type ? [options.type, limit] : [limit]),
			) as SearchIndexResult[];
	}

	try {
		// Use FTS5 with BM25 ranking
		let sql = `
      SELECT o.id, o.type, o.title,
             substr(COALESCE(o.narrative, ''), 1, 100) as snippet,
             o.created_at,
             bm25(observations_fts) as relevance_score
      FROM observations o
      JOIN observations_fts fts ON fts.rowid = o.id
      WHERE observations_fts MATCH ?
        AND o.superseded_by IS NULL
    `;

		const params: (string | number)[] = [ftsQuery];

		if (options.type) {
			sql += " AND o.type = ?";
			params.push(options.type);
		}

		sql += " ORDER BY relevance_score LIMIT ?";
		params.push(limit);

		return db.query(sql).all(...params) as SearchIndexResult[];
	} catch {
		// FTS5 query failed, fallback to LIKE search
		return fallbackLikeSearch(db, query, options.type, limit);
	}
}

/**
 * Fallback search using LIKE (for when FTS5 fails).
 */
function fallbackLikeSearch(
	db: ReturnType<typeof getMemoryDB>,
	query: string,
	type: ObservationType | undefined,
	limit: number,
): SearchIndexResult[] {
	const likePattern = `%${query}%`;

	let sql = `
    SELECT id, type, title,
           substr(COALESCE(narrative, ''), 1, 100) as snippet,
           created_at,
           0 as relevance_score
    FROM observations
    WHERE superseded_by IS NULL
      AND (title LIKE ? OR narrative LIKE ? OR concepts LIKE ?)
  `;

	const params: (string | number)[] = [likePattern, likePattern, likePattern];

	if (type) {
		sql += " AND type = ?";
		params.push(type);
	}

	sql += " ORDER BY created_at_epoch DESC LIMIT ?";
	params.push(limit);

	return db.query(sql).all(...params) as SearchIndexResult[];
}

// ============================================================================
// Timeline & Stats
// ============================================================================

/**
 * Get timeline around an anchor observation.
 */
export function getTimelineAroundObservation(
	anchorId: number,
	depthBefore = 5,
	depthAfter = 5,
): {
	anchor: ObservationRow | null;
	before: SearchIndexResult[];
	after: SearchIndexResult[];
} {
	const db = getMemoryDB();

	const anchor = getObservationById(anchorId);
	if (!anchor) {
		return { anchor: null, before: [], after: [] };
	}

	const before = db
		.query(
			`
    SELECT id, type, title,
           substr(COALESCE(narrative, ''), 1, 100) as snippet,
           created_at,
           0 as relevance_score
    FROM observations
    WHERE created_at_epoch < ?
      AND superseded_by IS NULL
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `,
		)
		.all(anchor.created_at_epoch, depthBefore) as SearchIndexResult[];

	const after = db
		.query(
			`
    SELECT id, type, title,
           substr(COALESCE(narrative, ''), 1, 100) as snippet,
           created_at,
           0 as relevance_score
    FROM observations
    WHERE created_at_epoch > ?
      AND superseded_by IS NULL
    ORDER BY created_at_epoch ASC
    LIMIT ?
  `,
		)
		.all(anchor.created_at_epoch, depthAfter) as SearchIndexResult[];

	return {
		anchor,
		before: before.reverse(),
		after,
	};
}

/**
 * Get most recent observation.
 */
export function getMostRecentObservation(): ObservationRow | null {
	const db = getMemoryDB();
	return db
		.query(
			"SELECT * FROM observations WHERE superseded_by IS NULL ORDER BY created_at_epoch DESC LIMIT 1",
		)
		.get() as ObservationRow | null;
}

/**
 * Get observation count by type.
 */
export function getObservationStats(): Record<string, number> {
	const db = getMemoryDB();
	const rows = db
		.query(
			`
    SELECT type, COUNT(*) as count
    FROM observations
    WHERE superseded_by IS NULL
    GROUP BY type
  `,
		)
		.all() as { type: string; count: number }[];

	const stats: Record<string, number> = { total: 0 };
	for (const row of rows) {
		stats[row.type] = row.count;
		stats.total += row.count;
	}
	return stats;
}
