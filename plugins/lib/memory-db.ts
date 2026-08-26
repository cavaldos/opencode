/**
 * Memory Database Module v2 — Barrel Export
 *
 * Re-exports all functions and types from sub-modules in ./db/.
 * This preserves backward compatibility for existing imports from "./lib/memory-db.js".
 *
 * Sub-module structure:
 *   db/types.ts        — Configuration, types, interfaces
 *   db/schema.ts       — SQL schema, migrations, DB manager
 *   db/observations.ts — Observation CRUD, search, timeline, stats
 *   db/pipeline.ts     — Temporal messages, distillations, relevance scoring
 *   db/maintenance.ts  — Memory files, FTS5, DB maintenance
 */

// Memory Files, FTS5, and Maintenance
export {
	archiveOldObservations,
	checkFTS5Available,
	checkpointWAL,
	getDatabaseSizes,
	getMarkdownFilesInSqlite,
	getMemoryFile,
	optimizeFTS5,
	rebuildFTS5,
	runFullMaintenance,
	upsertMemoryFile,
	vacuumDatabase,
} from "./db/maintenance.js";
// Observation Operations
export {
	getMostRecentObservation,
	getObservationById,
	getObservationStats,
	getObservationsByIds,
	getTimelineAroundObservation,
	searchObservationsFTS,
	storeObservation,
} from "./db/observations.js";
// Temporal Message & Distillation Operations
export {
	estimateTokens,
	getCaptureStats,
	getDistillationById,
	getDistillationStats,
	getRecentDistillations,
	getRelevantKnowledge,
	getUndistilledMessageCount,
	getUndistilledMessages,
	markMessagesDistilled,
	purgeOldTemporalMessages,
	searchDistillationsFTS,
	storeDistillation,
	storeTemporalMessage,
} from "./db/pipeline.js";
// Database Manager
export { closeMemoryDB, getMemoryDB } from "./db/schema.js";
// Types & Configuration
export * from "./db/types.js";
