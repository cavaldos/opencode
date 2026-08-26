/**
 * Heuristic Distillation Module
 *
 * Compresses batches of temporal messages into distillations using
 * TF-IDF term extraction and key sentence selection.
 * No LLM dependency — pure heuristic, upgradeable later.
 *
 * Pipeline: temporal_messages → TF-IDF terms + key sentences → distillation
 */

import {
	type DistillationInput,
	getUndistilledMessageCount,
	getUndistilledMessages,
	MEMORY_CONFIG,
	markMessagesDistilled,
	storeDistillation,
	type TemporalMessageRow,
} from "./memory-db.js";

// ============================================================================
// TF-IDF Engine
// ============================================================================

/** Stop words to exclude from term extraction */
const STOP_WORDS = new Set([
	"the",
	"be",
	"to",
	"of",
	"and",
	"a",
	"in",
	"that",
	"have",
	"i",
	"it",
	"for",
	"not",
	"on",
	"with",
	"he",
	"as",
	"you",
	"do",
	"at",
	"this",
	"but",
	"his",
	"by",
	"from",
	"they",
	"we",
	"say",
	"her",
	"she",
	"or",
	"an",
	"will",
	"my",
	"one",
	"all",
	"would",
	"there",
	"their",
	"what",
	"so",
	"up",
	"out",
	"if",
	"about",
	"who",
	"get",
	"which",
	"go",
	"me",
	"when",
	"make",
	"can",
	"like",
	"time",
	"no",
	"just",
	"him",
	"know",
	"take",
	"people",
	"into",
	"year",
	"your",
	"good",
	"some",
	"could",
	"them",
	"see",
	"other",
	"than",
	"then",
	"now",
	"look",
	"only",
	"come",
	"its",
	"over",
	"think",
	"also",
	"back",
	"after",
	"use",
	"two",
	"how",
	"our",
	"work",
	"first",
	"well",
	"way",
	"even",
	"new",
	"want",
	"because",
	"any",
	"these",
	"give",
	"day",
	"most",
	"us",
	"is",
	"are",
	"was",
	"were",
	"been",
	"being",
	"has",
	"had",
	"did",
	"does",
	"doing",
	"am",
	// Code-specific stop words
	"function",
	"const",
	"let",
	"var",
	"return",
	"import",
	"export",
	"true",
	"false",
	"null",
	"undefined",
	"string",
	"number",
	"boolean",
]);

/**
 * Tokenize text into normalized words.
 */
function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9_\-/.]+/g, " ")
		.split(/\s+/)
		.filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

/**
 * Compute term frequency for a document.
 */
function computeTF(words: string[]): Map<string, number> {
	const tf = new Map<string, number>();
	for (const word of words) {
		tf.set(word, (tf.get(word) ?? 0) + 1);
	}
	// Normalize by total words
	const total = words.length || 1;
	for (const [word, count] of tf) {
		tf.set(word, count / total);
	}
	return tf;
}

/**
 * Compute inverse document frequency across multiple documents.
 */
function computeIDF(documents: string[][]): Map<string, number> {
	const idf = new Map<string, number>();
	const N = documents.length || 1;

	// Count documents containing each term
	const docFreq = new Map<string, number>();
	for (const words of documents) {
		const unique = new Set(words);
		for (const word of unique) {
			docFreq.set(word, (docFreq.get(word) ?? 0) + 1);
		}
	}

	// IDF = log(N / df)
	for (const [word, df] of docFreq) {
		idf.set(word, Math.log(N / df));
	}

	return idf;
}

/**
 * Extract top-N TF-IDF terms from a collection of messages.
 */
function extractTopTerms(
	messages: TemporalMessageRow[],
	topN: number,
): string[] {
	// Tokenize each message as a document
	const documents = messages.map((m) => tokenize(m.content));

	// Compute IDF across all documents
	const idf = computeIDF(documents);

	// Compute TF-IDF for the merged corpus
	const allWords = documents.flat();
	const tf = computeTF(allWords);

	// Score each term
	const scores: Array<[string, number]> = [];
	for (const [word, tfScore] of tf) {
		const idfScore = idf.get(word) ?? 0;
		scores.push([word, tfScore * idfScore]);
	}

	// Sort by score descending, return top N
	scores.sort((a, b) => b[1] - a[1]);
	return scores.slice(0, topN).map(([term]) => term);
}

// ============================================================================
// Key Sentence Selection
// ============================================================================

/**
 * Select key sentences from messages based on term density.
 * Prefers sentences that contain high-value TF-IDF terms.
 */
function selectKeySentences(
	messages: TemporalMessageRow[],
	topTerms: string[],
	targetLength: number,
): string {
	const termSet = new Set(topTerms);

	// Split all messages into sentences
	interface ScoredSentence {
		text: string;
		score: number;
		messageIndex: number;
	}

	const sentences: ScoredSentence[] = [];

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		// Split on sentence boundaries
		const msgSentences = msg.content
			.split(/(?<=[.!?])\s+|\n+/)
			.map((s) => s.trim())
			.filter((s) => s.length > 10 && s.length < 500);

		for (const sentence of msgSentences) {
			const words = tokenize(sentence);
			const termHits = words.filter((w) => termSet.has(w)).length;
			const density = termHits / (words.length || 1);

			sentences.push({
				text: sentence,
				score: density * (1 + termHits), // Boost sentences with more term hits
				messageIndex: i,
			});
		}
	}

	// Sort by score descending
	sentences.sort((a, b) => b.score - a.score);

	// Greedy-pack sentences up to target length
	const selected: ScoredSentence[] = [];
	let currentLength = 0;

	for (const sentence of sentences) {
		if (currentLength + sentence.text.length + 2 > targetLength) continue;
		selected.push(sentence);
		currentLength += sentence.text.length + 2; // +2 for separator
	}

	// Re-sort by original message order for coherence
	selected.sort((a, b) => a.messageIndex - b.messageIndex);

	return selected.map((s) => s.text).join("\n");
}

// ============================================================================
// Distillation Pipeline
// ============================================================================

/**
 * Run distillation for a session if enough undistilled messages exist.
 *
 * Returns the distillation ID if created, or null if no distillation was needed.
 */
export function distillSession(sessionId: string): number | null {
	if (!MEMORY_CONFIG.distillation.enabled) return null;

	const undistilledCount = getUndistilledMessageCount(sessionId);

	if (undistilledCount < MEMORY_CONFIG.distillation.minMessages) {
		return null; // Not enough messages yet
	}

	// Get undistilled messages (up to maxMessages)
	const messages = getUndistilledMessages(
		sessionId,
		MEMORY_CONFIG.distillation.maxMessages,
	);

	if (messages.length < MEMORY_CONFIG.distillation.minMessages) {
		return null;
	}

	// Extract top TF-IDF terms
	const topTerms = extractTopTerms(
		messages,
		MEMORY_CONFIG.distillation.topTerms,
	);

	// Compute target length based on compression ratio
	const totalChars = messages.reduce((sum, m) => sum + m.content.length, 0);
	const targetLength = Math.max(
		200,
		Math.floor(totalChars * MEMORY_CONFIG.distillation.compressionTarget),
	);

	// Select key sentences
	const distilledContent = selectKeySentences(messages, topTerms, targetLength);

	if (!distilledContent || distilledContent.length < 50) {
		return null; // Distillation too thin
	}

	// Compute compression ratio
	const compressionRatio = distilledContent.length / (totalChars || 1);

	// Time range
	const timeStart = messages[0].time_created;
	const timeEnd = messages[messages.length - 1].time_created;

	// Store distillation
	const input: DistillationInput = {
		session_id: sessionId,
		content: distilledContent,
		terms: topTerms,
		message_count: messages.length,
		compression_ratio: compressionRatio,
		time_start: timeStart,
		time_end: timeEnd,
	};

	const distillationId = storeDistillation(input);

	// Mark messages as distilled
	const messageIds = messages.map((m) => m.id);
	markMessagesDistilled(messageIds, distillationId);

	return distillationId;
}

// Export term extraction for use by inject.ts
export { extractTopTerms, tokenize };
