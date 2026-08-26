/**
 * LTM Injection Module
 *
 * Implements system.transform: searches observations + distillations using
 * TF-IDF query terms extracted from recent conversation, scores results by
 * BM25 * recency * confidence, and greedy-packs into a token budget.
 *
 * Injected into the system prompt on every turn for relevant context.
 */

import { tokenize } from "./distill.js";
import {
	estimateTokens,
	getRelevantKnowledge,
	MEMORY_CONFIG,
} from "./memory-db.js";

// ============================================================================
// Query Term Extraction
// ============================================================================

/**
 * Extract top query terms from the current system prompt context.
 * Uses TF-IDF-like approach on the existing system prompt to find
 * what the conversation is about.
 */
export function extractQueryTerms(
	systemPrompt: string[],
	topN?: number,
): string[] {
	const n = topN ?? MEMORY_CONFIG.injection.topTerms;

	// Combine all system prompt segments
	const fullText = systemPrompt.join("\n");

	// Tokenize
	const words = tokenize(fullText);
	if (words.length === 0) return [];

	// Compute term frequency
	const tf = new Map<string, number>();
	for (const word of words) {
		tf.set(word, (tf.get(word) ?? 0) + 1);
	}

	// Sort by frequency descending
	const sorted = [...tf.entries()].sort((a, b) => b[1] - a[1]);

	// Return top N terms
	return sorted.slice(0, n).map(([term]) => term);
}

// ============================================================================
// Injection
// ============================================================================

/**
 * Build the LTM injection block for system.transform.
 *
 * @param systemPrompt - Current system prompt segments
 * @returns Additional system prompt segment with relevant knowledge, or null if empty
 */
export function buildInjection(systemPrompt: string[]): string | null {
	if (!MEMORY_CONFIG.injection.enabled) return null;

	// Extract query terms from current system context
	const queryTerms = extractQueryTerms(systemPrompt);
	if (queryTerms.length === 0) return null;

	// Get relevant knowledge, scored and packed within budget
	const knowledge = getRelevantKnowledge(queryTerms, {
		tokenBudget: MEMORY_CONFIG.injection.tokenBudget,
		minScore: MEMORY_CONFIG.injection.minScore,
	});

	if (knowledge.length === 0) return null;

	// Format as injection block
	const lines: string[] = [
		"<memory_context>",
		"Relevant knowledge from previous sessions:",
		"",
	];

	for (const item of knowledge) {
		const sourceTag =
			item.source === "observation" ? `[${item.type}]` : "[distillation]";
		const scoreTag = `(relevance: ${item.score.toFixed(2)})`;

		lines.push(`### ${sourceTag} ${item.title} ${scoreTag}`);

		// Truncate content to avoid dominating the injection
		const maxContentChars = Math.floor(
			(MEMORY_CONFIG.injection.tokenBudget * 4) / knowledge.length,
		);
		const content =
			item.content.length > maxContentChars
				? `${item.content.slice(0, maxContentChars)}...`
				: item.content;

		lines.push(content);
		lines.push("");
	}

	lines.push("</memory_context>");

	const injection = lines.join("\n");

	// Final check: ensure we're within token budget
	const tokens = estimateTokens(injection);
	if (tokens > MEMORY_CONFIG.injection.tokenBudget * 1.2) {
		// Over budget — trim to just titles
		const trimmed = [
			"<memory_context>",
			"Relevant knowledge (summaries):",
			...knowledge.map(
				(k) =>
					`- [${k.source === "observation" ? k.type : "distillation"}] ${k.title}`,
			),
			"</memory_context>",
		].join("\n");
		return trimmed;
	}

	return injection;
}
