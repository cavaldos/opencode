/**
 * skill-tracker — OpenCode hook plugin.
 *
 * Records every native `skill` tool call into .opencode/skill-usage.json,
 * keyed by session, with per-skill counts and timestamps.
 *
 * Auto-loaded from .opencode/plugins/ at startup. Never throws into the
 * tool pipeline: tracking failures are logged and swallowed.
 */

import type { Plugin } from "@opencode-ai/plugin"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

type SkillUsage = {
  name: string
  count: number
  firstUsedAt: string
  lastUsedAt: string
}

type SessionUsage = {
  skills: Record<string, SkillUsage>
  updatedAt: string
}

type UsageFile = {
  sessions: Record<string, SessionUsage>
}

const MAX_SESSIONS = 50

const emptyData = (): UsageFile => ({ sessions: {} })

/** Serialized write queue — avoids interleaved reads/writes when the
 *  agent fires multiple tool calls in quick succession. */
let writeChain: Promise<void> = Promise.resolve()

async function loadData(file: string): Promise<UsageFile> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"))
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      typeof (parsed as Record<string, unknown>).sessions === "object" &&
      (parsed as Record<string, unknown>).sessions !== null
    ) {
      return parsed as UsageFile
    }
    return emptyData()
  } catch {
    return emptyData()
  }
}

function pruneSessions(data: UsageFile): void {
  const entries = Object.entries(data.sessions).sort((a, b) =>
    a[1].updatedAt < b[1].updatedAt ? -1 : 1,
  )
  for (const [key] of entries.slice(0, Math.max(0, entries.length - MAX_SESSIONS))) {
    delete data.sessions[key]
  }
}

export const SkillTracker: Plugin = async ({ client, worktree, directory }) => {
  const root = worktree ?? directory ?? process.cwd()
  const file = path.join(root, ".opencode", "skill-usage.json")

  const recordSkill = async (sessionID: string, skillName: string): Promise<void> => {
    writeChain = writeChain.then(async () => {
      const now = new Date().toISOString()
      const data = await loadData(file)

      data.sessions[sessionID] ??= { skills: {}, updatedAt: now }
      const session = data.sessions[sessionID]
      const previous = session.skills[skillName]

      session.skills[skillName] = {
        name: skillName,
        count: (previous?.count ?? 0) + 1,
        firstUsedAt: previous?.firstUsedAt ?? now,
        lastUsedAt: now,
      }
      session.updatedAt = now

      pruneSessions(data)
      await mkdir(path.dirname(file), { recursive: true })
      await writeFile(file, JSON.stringify({ sessions: sortSessions(data) }, null, 2), "utf8")
    })
    await writeChain
  }

  return {
    "tool.execute.before": async (input, output) => {
      try {
        if (input.tool !== "skill") return

        // Narrow args defensively — shape may vary between versions.
        const args: unknown = output.args
        let skillName: string | undefined
        if (typeof args === "object" && args !== null && !Array.isArray(args)) {
          const candidate = (args as Record<string, unknown>).name
          if (typeof candidate === "string" && candidate.trim()) skillName = candidate.trim()
        }
        if (!skillName) return

        const rawSession =
          typeof (input as Record<string, unknown>).sessionID === "string"
            ? (input as Record<string, unknown>).sessionID
            : undefined
        const sessionID = typeof rawSession === "string" ? rawSession : "unknown-session"

        await recordSkill(sessionID, skillName)

        await client.app.log({
          body: {
            service: "skill-tracker",
            level: "info",
            message: `Skill used: ${skillName}`,
            extra: { sessionID },
          },
        }).catch(() => {})
      } catch {
        // Tracking must never break tool execution.
      }
    },
  }
}

/** Most-recently-updated sessions first in the persisted file. */
function sortSessions(data: UsageFile): UsageFile {
  const ordered = Object.entries(data.sessions).sort((a, b) =>
    a[1].updatedAt > b[1].updatedAt ? -1 : 1,
  )
  return { sessions: Object.fromEntries(ordered) }
}

export default SkillTracker
