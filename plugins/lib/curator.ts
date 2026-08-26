/**
 * Curator Module
 *
 * Pattern-matches distillations to automatically create observations.
 * Uses regex patterns to detect decisions, bugfixes, patterns, discoveries, warnings.
 * All curated observations are created with source='curator'.
 *
 * No LLM dependency — pure heuristic pattern matching.
 */

import {
	type DistillationRow,
	getRecentDistillations,
	MEMORY_CONFIG,
	type ObservationInput,
	type ObservationType,
	storeObservation,
} from "./memory-db.js";

// ============================================================================
// Pattern Definitions
// ============================================================================

/** Curator patterns — regex + type mapping.
 *
 * Each pattern requires multi-word phrases or contextual markers to reduce
 * false positives. Single common words like "using", "found", "always" are
 * NOT matched alone — they must appear in decision/discovery phrases.
 */
const CURATOR_PATTERNS: Array<{
	type: ObservationType;
	pattern: RegExp;
	titleExtractor: (match: RegExpMatchArray, sentence: string) => string;
}> = [
	{
		type: "decision",
		pattern:
			/\b(decided to|chose to|selected\s+\w+\s+(?:over|instead)|went with|opted for|switched to|migrated to|picked\s+\w+\s+(?:over|for))\b/i,
		titleExtractor: (_match, sentence) => truncateSentence(sentence, 80),
	},
	{
		type: "bugfix",
		pattern:
			/\b(fixed (?:a|the|an)\b|resolved (?:a|the|an)\b|patched (?:a|the|an)\b|corrected (?:a|the|an)\b|bug in\b|error in\b|crash in\b|regression in\b)\b/i,
		titleExtractor: (_match, sentence) => truncateSentence(sentence, 80),
	},
	{
		type: "pattern",
		pattern:
			/\b(pattern(?::|is| for)\b|convention(?::|is)\b|best practice\b|standard practice\b|workflow for\b|(?:we|I|the team) (?:always|never)\b)\b/i,
		titleExtractor: (_match, sentence) => truncateSentence(sentence, 80),
	},
	{
		type: "discovery",
		pattern:
			/\b(found that|discovered that|noticed that|learned that|turns out|realized that|it (?:seems|appears) that)\b/i,
		titleExtractor: (_match, sentence) => truncateSentence(sentence, 80),
	},
	{
		type: "warning",
		pattern:
			/\b(warning:|caution:|careful with|gotcha:|pitfall(?:s|:)?\b|don't use\b|avoid (?:using|calling|importing)\b|beware of\b|watch out for\b|never (?:use|call|import|commit|push)\b)\b/i,
		titleExtractor: (_match, sentence) => truncateSentence(sentence, 80),
	},
];

// ============================================================================
// Utilities
// ============================================================================

/**
 * Truncate a sentence to max length, preserving word boundaries.
 */
function truncateSentence(sentence: string, maxLen: number): string {
	const clean = sentence.replace(/\s+/g, " ").trim();
	if (clean.length <= maxLen) return clean;

	const truncated = clean.slice(0, maxLen);
	const lastSpace = truncated.lastIndexOf(" ");
	return lastSpace > maxLen / 2
		? `${truncated.slice(0, lastSpace)}...`
		: `${truncated}...`;
}

/**
 * Split distillation content into sentences.
 */
function splitSentences(content: string): string[] {
	return content
		.split(/(?<=[.!?])\s+|\n+/)
		.map((s) => s.trim())
		.filter((s) => s.length > 30); // Skip short fragments that lack enough context
}

/**
 * Extract concept tags from a sentence (significant nouns/terms).
 */
function extractConcepts(sentence: string): string[] {
	// Extract potential concept words (3+ chars, not common stop words)
	const words = sentence
		.toLowerCase()
		.replace(/[^a-z0-9_\-/.]+/g, " ")
		.split(/\s+/)
		.filter((w) => w.length > 3);

	// Return unique terms, limited to 5
	return [...new Set(words)].slice(0, 5);
}

/**
 * Deduplicate against existing observation titles (simple guard).
 * Returns true if a similar title already exists.
 */
function isDuplicateTitle(title: string, existingTitles: Set<string>): boolean {
	const normalized = title.toLowerCase().trim();
	if (existingTitles.has(normalized)) return true;

	// Also check prefix match (first 40 chars) for fuzzy dedup
	const prefix = normalized.slice(0, 40);
	for (const existing of existingTitles) {
		if (
			existing.startsWith(prefix) ||
			prefix.startsWith(existing.slice(0, 40))
		) {
			return true;
		}
	}

	return false;
}

// ============================================================================
// Curator Pipeline
// ============================================================================

interface CuratorResult {
	created: number;
	skipped: number;
	patterns: Record<string, number>;
}

/**
 * Run curator on recent distillations to extract observations.
 *
 * @param sessionId - If provided, only process distillations from this session
 * @param limit - Max distillations to process (default: MEMORY_CONFIG.curator.minDistillations)
 */
export function curateFromDistillations(
	sessionId?: string,
	limit?: number,
): CuratorResult {
	if (!MEMORY_CONFIG.curator.enabled) {
		return { created: 0, skipped: 0, patterns: {} };
	}

	const maxDistillations = limit ?? MEMORY_CONFIG.curator.minDistillations;
	const distillations = getRecentDistillations(sessionId, maxDistillations);

	if (distillations.length < MEMORY_CONFIG.curator.minDistillations) {
		return { created: 0, skipped: 0, patterns: {} };
	}

	const result: CuratorResult = { created: 0, skipped: 0, patterns: {} };
	const seenTitles = new Set<string>();

	for (const distillation of distillations) {
		const sentences = splitSentences(distillation.content);

		for (const sentence of sentences) {
			const observation = matchPatterns(sentence, distillation, seenTitles);

			if (observation) {
				try {
					storeObservation(observation);
					result.created++;
					result.patterns[observation.type] =
						(result.patterns[observation.type] ?? 0) + 1;
					seenTitles.add(observation.title.toLowerCase().trim());
				} catch {
					result.skipped++;
				}
			}
		}
	}

	return result;
}

/**
 * Match a sentence against curator patterns and return an observation input if matched.
 */
function matchPatterns(
	sentence: string,
	distillation: DistillationRow,
	seenTitles: Set<string>,
): ObservationInput | null {
	for (const { type, pattern, titleExtractor } of CURATOR_PATTERNS) {
		const match = sentence.match(pattern);
		if (!match) continue;

		const title = titleExtractor(match, sentence);

		// Skip duplicates
		if (isDuplicateTitle(title, seenTitles)) {
			continue;
		}

		const concepts = extractConcepts(sentence);

		// Parse distillation terms for additional concepts
		let distTerms: string[] = [];
		try {
			distTerms = JSON.parse(distillation.terms);
		} catch {
			// Invalid JSON, skip
		}

		// Merge concepts from sentence + distillation terms (max 8)
		const allConcepts = [
			...new Set([...concepts, ...distTerms.slice(0, 3)]),
		].slice(0, 8);

		return {
			type,
			title,
			narrative: sentence,
			concepts: allConcepts,
			confidence: MEMORY_CONFIG.curator.defaultConfidence,
			source: "curator",
		};
	}

	return null;
}
