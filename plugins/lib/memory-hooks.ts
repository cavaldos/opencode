/**
 * Memory Plugin — Hooks
 *
 * All event handlers, transforms, and compaction logic.
 * Uses factory pattern: createHooks(deps) returns hook definitions.
 *
 * Hook architecture (from @opencode-ai/plugin Hooks interface):
 * - `event` — generic handler for ALL events (session.idle, message.updated, etc.)
 * - Named hooks — separate handlers with (input, output) signature:
 *   - "tool.execute.after", "chat.message", "experimental.chat.*", etc.
 *
 * Events NOT in the Hooks interface (handled via generic `event`):
 * - session.idle, session.error, session.created, session.deleted
 * - message.updated, message.removed, message.part.updated, message.part.removed
 */

import { captureMessageMeta, captureMessagePart } from "./capture.js";
import { manageContext } from "./context.js";
import { curateFromDistillations } from "./curator.js";
import { distillSession } from "./distill.js";
import { buildInjection } from "./inject.js";
import {
	checkFTS5Available,
	checkpointWAL,
	getDatabaseSizes,
	optimizeFTS5,
} from "./memory-db.js";

interface HookDeps {
	showToast: (
		title: string,
		message: string,
		variant?: "info" | "warning",
	) => Promise<void>;
	log: (message: string, level?: "info" | "warn") => Promise<void>;
}

export function createHooks(deps: HookDeps) {
	const { showToast, log } = deps;

	return {
		// ================================================================
		// Generic event handler — ALL events route through here
		// Receives: { event: { type, properties? } }
		// ================================================================
		event: async (input: unknown) => {
			const { event } = input as {
				event: {
					type?: string;
					properties?: Record<string, unknown>;
				};
			};
			if (!event?.type) return;

			// --- Message capture ---
			if (event.type === "message.updated") {
				try {
					captureMessageMeta(
						event.properties as Parameters<typeof captureMessageMeta>[0],
					);
				} catch {
					/* Non-fatal */
				}
			}

			if (event.type === "message.part.updated") {
				try {
					captureMessagePart(
						event.properties as Parameters<typeof captureMessagePart>[0],
					);
				} catch {
					/* Non-fatal */
				}
			}

			// --- Session idle: distill + curate + optimize ---
			if (event.type === "session.idle") {
				const sessionId =
					(event.properties as { sessionID?: string })?.sessionID ??
					(event as unknown as { sessionID?: string })?.sessionID;
				try {
					if (sessionId) distillSession(sessionId);
					curateFromDistillations(sessionId, 5);
					if (checkFTS5Available()) optimizeFTS5();
					const sizes = getDatabaseSizes();
					if (sizes.wal > 1024 * 1024) checkpointWAL();
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					await log(`Idle maintenance failed: ${msg}`, "warn");
				}
			}

			// --- Session error: warn user ---
			if (event.type === "session.error") {
				await showToast(
					"Session Error",
					"Save important learnings with observation tool",
					"warning",
				);
			}
		},

		// ================================================================
		// Named hook: tool.execute.after
		// Receives: (input: { tool, sessionID, callID, args }, output: { title, output, metadata })
		// ================================================================
		"tool.execute.after": async (input: {
			tool?: string;
			sessionID?: string;
		}) => {
			try {
				if (input.tool === "observation" && typeof showToast === "function") {
					await showToast("Saved", "Observation added to memory");
				}
			} catch {
				/* Toast is cosmetic, never block tool execution */
			}
		},

		// ================================================================
		// LTM injection into system prompt
		// ================================================================
		"experimental.chat.system.transform": async (
			_input: unknown,
			output: { system: string[] },
		) => {
			try {
				const injection = buildInjection(output.system);
				if (injection) output.system.push(injection);
			} catch {
				/* Non-fatal */
			}
		},

		// ================================================================
		// Context window management
		// ================================================================
		"experimental.chat.messages.transform": async (
			_input: unknown,
			output: { messages: unknown[] },
		) => {
			try {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				output.messages = manageContext(output.messages as any) as any;
			} catch {
				/* Non-fatal */
			}
		},

		// ================================================================
		// Compaction — inject session continuity context
		// Receives: (input: { sessionID }, output: { context, prompt? })
		// ================================================================
		"experimental.session.compacting": async (
			_input: { sessionID?: string },
			output: { context: string[]; prompt?: string },
		) => {
			// No context injection here — the session is already at the
			// model limit when compaction fires. Only append prompt guidance.
			output.prompt = `${output.prompt ?? ""}

<compaction_task>
Summarize conversation state for reliable continuation after compaction.
</compaction_task>

<compaction_rules>
- Preserve exact IDs, file paths, and unresolved constraints.
- Distinguish completed work from current in-progress work.
- Keep summary concise and execution-focused.
- If critical context is missing, state uncertainty explicitly.
</compaction_rules>

<compaction_output>
Include:
- What was done
- What is being worked on now
- Files currently in play
- Next actions
- Persistent user constraints/preferences
</compaction_output>
`;
		},
	};
}
