/**
 * Context Window Management Module
 *
 * Implements messages.transform: estimates token usage across conversation
 * messages and compresses oldest messages when approaching the budget limit.
 *
 * Protects the most recent N messages from compression.
 */

import { estimateTokens, MEMORY_CONFIG } from "./memory-db.js";

// ============================================================================
// Types
// ============================================================================

/** Minimal message shape from messages.transform output */
interface TransformMessage {
	info: {
		id?: string;
		role?: string;
		time?: {
			created?: number;
		};
	};
	parts: Array<{
		type?: string;
		text?: string;
		data?: {
			type?: string;
			text?: string;
		};
	}>;
}

// ============================================================================
// Token Estimation
// ============================================================================

/**
 * Estimate total tokens in a message (all text parts).
 */
function estimateMessageTokens(msg: TransformMessage): number {
	let total = 0;
	for (const part of msg.parts) {
		if (part.text) {
			total += estimateTokens(part.text);
		} else if (part.data?.text) {
			total += estimateTokens(part.data.text);
		}
	}
	// Add overhead for message framing (~10 tokens per message)
	return total + 10;
}

/**
 * Create a compressed summary of a message.
 * Preserves non-text parts (tool calls, tool results, images) to maintain
 * conversation coherence. Only compresses text parts.
 */
function compressMessage(msg: TransformMessage): TransformMessage {
	const role = msg.info.role ?? "unknown";

	// Separate text parts from non-text parts (tool calls, tool results, etc.)
	const textParts: Array<(typeof msg.parts)[number]> = [];
	const nonTextParts: Array<(typeof msg.parts)[number]> = [];

	for (const part of msg.parts) {
		const isTextPart =
			part.type === "text" || (!part.type && (part.text || part.data?.text));
		if (isTextPart) {
			textParts.push(part);
		} else {
			nonTextParts.push(part);
		}
	}

	// Extract text content for summarization
	const texts: string[] = [];
	for (const part of textParts) {
		if (part.text) texts.push(part.text);
		else if (part.data?.text) texts.push(part.data.text);
	}

	const fullText = texts.join("\n");

	// Build compressed parts: summarized text + preserved non-text parts
	const compressedParts: typeof msg.parts = [];

	if (fullText.length > 0) {
		compressedParts.push({
			type: "text",
			text: createSummary(fullText, role),
		});
	}

	// Preserve tool calls, tool results, and other structural parts
	compressedParts.push(...nonTextParts);

	return {
		info: msg.info,
		parts:
			compressedParts.length > 0
				? compressedParts
				: [{ type: "text", text: `[compressed ${role} message]` }],
	};
}

/**
 * Create a brief summary of message content.
 * Keeps first and last sentence, truncates middle.
 */
function createSummary(text: string, role: string): string {
	const maxChars = 200;

	if (text.length <= maxChars) return text;

	// Split into sentences
	const sentences = text
		.split(/(?<=[.!?])\s+|\n+/)
		.map((s) => s.trim())
		.filter((s) => s.length > 0);

	if (sentences.length <= 2) {
		return `${text.slice(0, maxChars)}...`;
	}

	const first = sentences[0];
	const last = sentences[sentences.length - 1];

	const summary = `[compressed ${role} message] ${first} [...${sentences.length - 2} more sentences...] ${last}`;

	return summary.length > maxChars * 2
		? `${summary.slice(0, maxChars * 2)}...`
		: summary;
}

// ============================================================================
// Context Manager
// ============================================================================

/**
 * Process messages through context management.
 *
 * If total tokens exceed maxContextTokens, compresses oldest messages
 * (excluding the most recent `protectedMessages` count).
 *
 * @param messages - Current conversation messages
 * @returns Potentially compressed messages array
 */
export function manageContext(
	messages: TransformMessage[],
): TransformMessage[] {
	if (!MEMORY_CONFIG.context.enabled) return messages;

	const maxTokens = MEMORY_CONFIG.context.maxContextTokens;
	const protectedCount = MEMORY_CONFIG.context.protectedMessages;

	// Estimate total tokens
	let totalTokens = 0;
	const tokenCounts: number[] = [];

	for (const msg of messages) {
		const tokens = estimateMessageTokens(msg);
		tokenCounts.push(tokens);
		totalTokens += tokens;
	}

	// If under budget, return unchanged
	if (totalTokens <= maxTokens) return messages;

	// Calculate how many tokens to shed
	const tokensToShed = totalTokens - maxTokens;

	// Identify compressible messages (all except protected recent ones)
	const compressibleEnd = Math.max(0, messages.length - protectedCount);
	let shedSoFar = 0;

	const result = [...messages];

	// Compress from oldest to newest until we've shed enough
	for (let i = 0; i < compressibleEnd && shedSoFar < tokensToShed; i++) {
		const originalTokens = tokenCounts[i];
		const compressed = compressMessage(messages[i]);
		const compressedTokens = estimateMessageTokens(compressed);
		const saved = originalTokens - compressedTokens;

		if (saved > 0) {
			result[i] = compressed;
			shedSoFar += saved;
		}
	}

	return result;
}
