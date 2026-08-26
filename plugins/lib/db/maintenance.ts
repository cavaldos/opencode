/**
 * Database Maintenance & Auxiliary Operations
 *
 * Memory files, FTS5 maintenance, archiving, and full maintenance cycle.
 */

import { purgeOldTemporalMessages } from "./pipeline.js";
import { getMemoryDB } from "./schema.js";
import type {
	ArchiveOptions,
	MaintenanceStats,
	MemoryFileRow,
} from "./types.js";

// ============================================================================
// Memory File Operations
// ============================================================================

/**
 * Store or update a memory file.
 */
export function upsertMemoryFile(
	filePath: string,
	content: string,
	mode: "replace" | "append" = "replace",
): void {
	const db = getMemoryDB();
	const now = new Date();

	db.run(
		`
    INSERT INTO memory_files (file_path, content, mode, created_at, created_at_epoch)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(file_path) DO UPDATE SET
      content = CASE WHEN excluded.mode = 'append' THEN memory_files.content || '\n\n' || excluded.content ELSE excluded.content END,
      mode = excluded.mode,
      updated_at = ?,
      updated_at_epoch = ?
  `,
		[
			filePath,
			content,
			mode,
			now.toISOString(),
			now.getTime(),
			now.toISOString(),
			now.getTime(),
		],
	);
}

/**
 * Get a memory file by path.
 */
export function getMemoryFile(filePath: string): MemoryFileRow | null {
	const db = getMemoryDB();
	return db
		.query("SELECT * FROM memory_files WHERE file_path = ?")
		.get(filePath) as MemoryFileRow | null;
}

// ============================================================================
// FTS5 Maintenance
// ============================================================================

/**
 * Optimize FTS5 indexes (run periodically).
 */
export function optimizeFTS5(): void {
	const db = getMemoryDB();
	db.run("INSERT INTO observations_fts(observations_fts) VALUES('optimize')");
	try {
		db.run(
			"INSERT INTO distillations_fts(distillations_fts) VALUES('optimize')",
		);
	} catch {
		// distillations_fts may not exist yet
	}
}

/**
 * Rebuild FTS5 indexes from scratch.
 */
export function rebuildFTS5(): void {
	const db = getMemoryDB();
	db.run("INSERT INTO observations_fts(observations_fts) VALUES('rebuild')");
	try {
		db.run(
			"INSERT INTO distillations_fts(distillations_fts) VALUES('rebuild')",
		);
	} catch {
		// distillations_fts may not exist yet
	}
}

/**
 * Check if FTS5 is available and working.
 */
export function checkFTS5Available(): boolean {
	try {
		const db = getMemoryDB();
		db.query("SELECT * FROM observations_fts LIMIT 1").get();
		return true;
	} catch {
		return false;
	}
}

// ============================================================================
// Database Maintenance
// ============================================================================

/**
 * Archive old observations to a separate table.
 */
export function archiveOldObservations(options: ArchiveOptions = {}): number {
	const db = getMemoryDB();
	const olderThanDays = options.olderThanDays ?? 90;
	const includeSuperseded = options.includeSuperseded ?? true;
	const dryRun = options.dryRun ?? false;

	const cutoffEpoch = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;

	// Create archive table if not exists
	db.run(`
		CREATE TABLE IF NOT EXISTS observations_archive (
			id INTEGER PRIMARY KEY,
			type TEXT NOT NULL,
			title TEXT NOT NULL,
			subtitle TEXT,
			facts TEXT,
			narrative TEXT,
			concepts TEXT,
			files_read TEXT,
			files_modified TEXT,
			confidence TEXT,
			bead_id TEXT,
			supersedes INTEGER,
			superseded_by INTEGER,
			valid_until TEXT,
			markdown_file TEXT,
			source TEXT DEFAULT 'manual',
			created_at TEXT NOT NULL,
			created_at_epoch INTEGER NOT NULL,
			updated_at TEXT,
			archived_at TEXT NOT NULL
		)
	`);

	// Build WHERE clause
	let whereClause = `created_at_epoch < ${cutoffEpoch}`;
	if (includeSuperseded) {
		whereClause = `(${whereClause} OR superseded_by IS NOT NULL)`;
	}

	// Count candidates
	const countResult = db
		.query(`SELECT COUNT(*) as count FROM observations WHERE ${whereClause}`)
		.get() as { count: number };

	if (dryRun || countResult.count === 0) {
		return countResult.count;
	}

	// Move to archive
	const now = new Date().toISOString();
	db.run(`
		INSERT INTO observations_archive
		SELECT *, '${now}' as archived_at FROM observations WHERE ${whereClause}
	`);

	// Delete from main table (triggers will remove from FTS)
	db.run(`DELETE FROM observations WHERE ${whereClause}`);

	return countResult.count;
}

/**
 * Checkpoint WAL file back to main database.
 */
export function checkpointWAL(): { walSize: number; checkpointed: boolean } {
	const db = getMemoryDB();

	try {
		const result = db.query("PRAGMA wal_checkpoint(TRUNCATE)").get() as {
			busy: number;
			log: number;
			checkpointed: number;
		};

		return {
			walSize: result.log,
			checkpointed: result.busy === 0,
		};
	} catch {
		return { walSize: 0, checkpointed: false };
	}
}

/**
 * Vacuum database to reclaim space and defragment.
 */
export function vacuumDatabase(): boolean {
	const db = getMemoryDB();
	try {
		db.run("VACUUM");
		return true;
	} catch {
		return false;
	}
}

/**
 * Get database file sizes.
 */
export function getDatabaseSizes(): {
	mainDb: number;
	wal: number;
	shm: number;
	total: number;
} {
	const db = getMemoryDB();

	try {
		const pageCount = db.query("PRAGMA page_count").get() as {
			page_count: number;
		};
		const pageSize = db.query("PRAGMA page_size").get() as {
			page_size: number;
		};
		const mainDb = pageCount.page_count * pageSize.page_size;

		const walResult = db.query("PRAGMA wal_checkpoint").get() as {
			busy: number;
			log: number;
			checkpointed: number;
		};
		const wal = walResult.log * pageSize.page_size;

		return {
			mainDb,
			wal,
			shm: 32768,
			total: mainDb + wal + 32768,
		};
	} catch {
		return { mainDb: 0, wal: 0, shm: 0, total: 0 };
	}
}

/**
 * Get list of markdown files that exist in SQLite (for pruning).
 */
export function getMarkdownFilesInSqlite(): string[] {
	const db = getMemoryDB();
	const rows = db
		.query(
			"SELECT markdown_file FROM observations WHERE markdown_file IS NOT NULL",
		)
		.all() as { markdown_file: string }[];

	return rows.map((r) => r.markdown_file);
}

/**
 * Run full maintenance cycle.
 */
export function runFullMaintenance(
	options: ArchiveOptions = {},
): MaintenanceStats {
	const sizesBefore = getDatabaseSizes();

	// 1. Archive old observations
	const archived = archiveOldObservations(options);

	// 2. Purge old temporal messages
	let purgedMessages = 0;
	if (!options.dryRun) {
		purgedMessages = purgeOldTemporalMessages();
	}

	// 3. Optimize FTS5
	if (!options.dryRun) {
		optimizeFTS5();
	}

	// 4. Checkpoint WAL
	let checkpointed = false;
	if (!options.dryRun) {
		const walResult = checkpointWAL();
		checkpointed = walResult.checkpointed;
	}

	// 5. Vacuum
	let vacuumed = false;
	if (!options.dryRun) {
		vacuumed = vacuumDatabase();
	}

	const sizesAfter = getDatabaseSizes();

	return {
		archived,
		vacuumed,
		checkpointed,
		prunedMarkdown: 0,
		purgedMessages,
		freedBytes: sizesBefore.total - sizesAfter.total,
		dbSizeBefore: sizesBefore.total,
		dbSizeAfter: sizesAfter.total,
	};
}
