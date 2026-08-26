/**
 * Message Capture Module
 *
 * Handles message.part.updated events: extracts text content from parts,
 * estimates tokens, and stores/updates temporal_messages for later distillation.
 *
 * Architecture note: OpenCode fires separate events for messages and parts.
 * - message.updated → { info: Message } (metadata only, no text)
 * - message.part.updated → { part: Part, delta?: string } (has text content)
 *
 * We capture from message.part.updated since that's where the text lives.
 * Each part update upserts the message row, accumulating content.
 */

import type { Database } from "bun:sqlite";
import {
	estimateTokens,
	getMemoryDB,
	MEMORY_CONFIG,
	type TemporalMessageInput,
} from "./memory-db.js";

// ============================================================================
// Types
// ============================================================================

/** Shape of properties from EventMessagePartUpdated */
export interface PartEvent {
	part?: {
		id?: string;
		sessionID?: string;
		messageID?: string;
		type?: string;
		text?: string;
	};
	delta?: string;
}

/** Shape of properties from EventMessageUpdated (metadata only) */
export interface MessageEvent {
	info?: {
		id?: string;
		sessionID?: string;
		role?: string;
		time?: { created?: number };
	};
}

// ============================================================================
// Capture Handlers
// ============================================================================

/**
 * Process a message.part.updated event.
 * Upserts the temporal_messages row for this message, appending new text.
 *
 * Returns true if part was captured, false if skipped.
 */
export function captureMessagePart(props: PartEvent): boolean {
	if (!MEMORY_CONFIG.capture.enabled) return false;

	const part = props.part;
	if (!part?.sessionID || !part.messageID) return false;

	// Only capture text and reasoning parts
	if (part.type !== "text" && part.type !== "reasoning") return false;

	const text = part.text;
	if (!text || text.trim().length === 0) return false;

	// Cap content length
	const cappedText = text.slice(0, MEMORY_CONFIG.capture.maxContentLength);

	try {
		const db = getMemoryDB();
		upsertMessageContent(db, part.sessionID, part.messageID, cappedText);
		return true;
	} catch {
		return false;
	}
}

/**
 * Process a message.updated event to capture role metadata.
 * Only stores role — content comes from message.part.updated.
 *
 * Returns true if metadata was captured.
 */
export function captureMessageMeta(props: MessageEvent): boolean {
	if (!MEMORY_CONFIG.capture.enabled) return false;

	const info = props.info;
	if (!info?.id || !info.sessionID) return false;

	const role = info.role ?? "unknown";
	if (role !== "user" && role !== "assistant") return false;

	try {
		const db = getMemoryDB();
		// Upsert with role but empty content — parts will fill it in
		const existing = db
			.query<{ content: string }, [string]>(
				"SELECT content FROM temporal_messages WHERE message_id = ?",
			)
			.get(info.id);

		if (!existing) {
			// Insert placeholder that parts will update
			const now = info.time?.created ?? Date.now();
			db.run(
				`INSERT OR IGNORE INTO temporal_messages
				 (session_id, message_id, role, content, token_estimate, time_created)
				 VALUES (?, ?, ?, '', 0, ?)`,
				info.sessionID,
				info.id,
				role,
				now,
			);
		}
		return true;
	} catch {
		return false;
	}
}

// ============================================================================
// Internal
// ============================================================================

/**
 * Upsert a message row, replacing content with the latest part text.
 * Since parts stream in incrementally, we replace (not append) with the
 * latest full text from the part — OpenCode sends cumulative text.
 */
function upsertMessageContent(
	db: Database,
	sessionId: string,
	messageId: string,
	text: string,
): void {
	const tokenEstimate = estimateTokens(text);
	const now = Date.now();

	// Try update first (most common case — message.updated fires before parts)
	const result = db.run(
		`UPDATE temporal_messages
		 SET content = ?, token_estimate = ?
		 WHERE message_id = ?`,
		text,
		tokenEstimate,
		messageId,
	);

	if (result.changes === 0) {
		// No existing row — insert with unknown role (message.updated hasn't fired yet)
		const input: TemporalMessageInput = {
			session_id: sessionId,
			message_id: messageId,
			role: "assistant", // Parts without prior message.updated are typically assistant
			content: text,
			token_estimate: tokenEstimate,
			time_created: now,
		};

		db.run(
			`INSERT OR IGNORE INTO temporal_messages
			 (session_id, message_id, role, content, token_estimate, time_created)
			 VALUES (?, ?, ?, ?, ?, ?)`,
			input.session_id,
			input.message_id,
			input.role,
			input.content,
			input.token_estimate,
			input.time_created,
		);
	}
}
