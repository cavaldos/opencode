/**
 * tool-tracker — OpenCode TUI sidebar plugin.
 *
 * Shows in the right sidebar, after all built-in sections:
 *  - an aggregated "Skills" section counting native `skill` tool invocations
 *  - every tool call of the active session (live status icons)
 *
 * Registered from .opencode/tui.json:
 *   { "plugin": ["./plugins/tool-tracker.tsx"] }
 *
 * Data source: api.state.session.messages() + api.state.part(messageID) —
 * the same synced TUI state the built-in sidebar sections
 * (context / mcp / todo / files) render from. Messages come back flat;
 * their tool parts live under state.part keyed by message id.
 */

/** @jsxImportSource @opentui/solid */

import { createSignal, Show } from "solid-js"
import type {
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
  TuiSlotContext,
  TuiSlotPlugin,
} from "@opencode-ai/plugin/tui"

const ID = "tool-tracker"
/** Render below built-in sidebar sections (context 100, mcp 200, lsp 300,
 *  todo 400, files 500): Skills first, then Tools. */
const SKILLS_ORDER = 600
const TOOLS_ORDER = 700
/** Like the built-in MCP/Todo sections: the toggle only appears (and
 *  collapses) once there are more than this many rows. */
const TOGGLE_AFTER = 2
const MAX_TOOLS = 14
const TITLE_MAX = 34

type UnknownRecord = Record<string, unknown>

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined

const clampText = (value: unknown, max: number): string => {
  const text = (asString(value) ?? "").replace(/\s+/g, " ").trim()
  if (!text) return ""
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

type ToolStatus = "pending" | "running" | "completed" | "error"

type ToolRow = {
  key: string
  tool: string
  status: ToolStatus
  title: string
}

const normalizeStatus = (value: unknown): ToolStatus => {
  switch (asString(value)) {
    case "running":
      return "running"
    case "completed":
      return "completed"
    case "error":
      return "error"
    default:
      return "pending"
  }
}

/** Extract tool-call rows from the session's messages and their parts. */
const extractToolRows = (messages: unknown, partsOf: (messageId: string) => unknown): ToolRow[] => {
  if (!Array.isArray(messages)) return []
  const rows: ToolRow[] = []

  for (const message of messages) {
    if (!isRecord(message)) continue
    const messageId = asString(message.id)
    if (!messageId) continue

    for (const raw of Array.isArray(partsOf(messageId)) ? (partsOf(messageId) as unknown[]) : []) {
      if (!isRecord(raw) || raw.type !== "tool") continue
      const state = isRecord(raw.state) ? raw.state : {}
      rows.push({
        key: asString(raw.id) ?? `${messageId}:${asString(raw.callID) ?? rows.length}`,
        tool: asString(raw.tool) ?? "unknown",
        status: normalizeStatus(state.status),
        title: clampText(state.title, TITLE_MAX),
      })
    }
  }

  // Keep the most recent calls, newest first: every new call lands on
  // top and pushes previously-called (older) tools further down.
  return rows.slice(-MAX_TOOLS).reverse()
}

const readToolRows = (api: TuiPluginApi, sessionId: string): ToolRow[] => {
  try {
    const messages = api.state.session.messages(sessionId)
    return extractToolRows(messages, (messageId) => api.state.part(messageId))
  } catch {
    return []
  }
}

type SkillRow = {
  key: string
  name: string
  status: ToolStatus
  count: number
}

/** Pull the invoked skill name out of a `skill` tool part's state. */
const skillNameOf = (state: UnknownRecord): string => {
  const input = isRecord(state.input) ? state.input : undefined
  const named = asString(input?.name)
  if (named) return clampText(named, TITLE_MAX)
  // Fallback: parse titles like "skill(notion-content)".
  const match = /\(([^)]+)\)/.exec(asString(state.title) ?? "")
  return match ? clampText(match[1], TITLE_MAX) : ""
}

/** Aggregate native `skill` tool calls of the session into counted rows,
 *  ordered by most recent use. */
const extractSkillRows = (messages: unknown, partsOf: (messageId: string) => unknown): SkillRow[] => {
  if (!Array.isArray(messages)) return []
  const calls: { name: string; status: ToolStatus }[] = []

  for (const message of messages) {
    if (!isRecord(message)) continue
    const messageId = asString(message.id)
    if (!messageId) continue

    const parts = partsOf(messageId)
    if (!Array.isArray(parts)) continue

    for (const raw of parts) {
      if (!isRecord(raw) || raw.type !== "tool") continue
      if ((asString(raw.tool) ?? "") !== "skill") continue
      const state = isRecord(raw.state) ? raw.state : {}
      const name = skillNameOf(state)
      if (!name || name === "unknown") continue
      calls.push({ name, status: normalizeStatus(state.status) })
    }
  }

  const byName = new Map<string, SkillRow>()
  for (const call of [...calls].reverse()) {
    const existing = byName.get(call.name)
    byName.set(call.name, {
      key: call.name,
      name: call.name,
      status:
        existing === undefined
          ? call.status
          : existing.status === "error"
            ? "error"
            : call.status,
      count: (existing?.count ?? 0) + 1,
    })
  }
  return [...byName.values()]
}

const readSkillRows = (api: TuiPluginApi, sessionId: string): SkillRow[] => {
  try {
    const messages = api.state.session.messages(sessionId)
    return extractSkillRows(messages, (messageId) => api.state.part(messageId))
  } catch {
    return []
  }
}



type Skin = {
  accent: string
  border: string
  error: string
  muted: string
  panel: string
  success: string
  text: string
  warning: string
}

const ink = (tokens: UnknownRecord, name: string, fallback: string): string => {
  const value = tokens[name]
  return typeof value === "string" ? value : fallback
}

const look = (theme: unknown): Skin => {
  const tokens = isRecord(theme) ? theme : {}
  return {
    panel: ink(tokens, "backgroundPanel", "#1d1d1d"),
    border: ink(tokens, "border", "#4a4a4a"),
    text: ink(tokens, "text", "#f0f0f0"),
    muted: ink(tokens, "textMuted", "#a5a5a5"),
    accent: ink(tokens, "primary", "#5f87ff"),
    success: ink(tokens, "success", "#4ec9b0"),
    warning: ink(tokens, "warning", "#d7ba7d"),
    error: ink(tokens, "error", "#f14c4c"),
  }
}

const STATUS_ICON: Record<ToolStatus, string> = {
  pending: "○",
  running: "◐",
  completed: "✔",
  error: "✘",
}

const statusColor = (status: ToolStatus, skin: Skin): string => {
  switch (status) {
    case "completed":
      return skin.success
    case "error":
      return skin.error
    case "running":
      return skin.warning
    default:
      return skin.muted
  }
}

/** "Skills" section — hidden while no skill has been invoked. Collapsible
 *  like the built-in MCP section: click the header once there are more
 *  than TOGGLE_AFTER rows; collapsed shows a one-line summary. */
const createSkillsSection = (api: TuiPluginApi): TuiSlotPlugin => ({
  order: SKILLS_ORDER,
  slots: {
    sidebar_content(ctx: TuiSlotContext, value: { session_id?: string }) {
      const skin = look(ctx.theme.current)
      const [expanded, setExpanded] = createSignal(true)

      return (
        <box flexDirection="column">
          {(() => {
            const id = asString(isRecord(value) ? (value as UnknownRecord).session_id : undefined)
            const skills = id ? readSkillRows(api, id) : []
            if (!id || skills.length === 0) return <box />
            const collapsible = skills.length > TOGGLE_AFTER
            const uses = skills.reduce((sum, skill) => sum + skill.count, 0)
            return [
              <box flexDirection="row" gap={1} onMouseDown={() => collapsible && setExpanded((v) => !v)}>
                <Show when={collapsible}>
                  <text fg={skin.text}>{expanded() ? "▼" : "▶"}</text>
                </Show>
                <text fg={skin.accent}>
                  <b>Skills</b>
                </text>
                <Show when={!expanded() && collapsible}>
                  <text fg={skin.muted}> ({skills.length} skills, {uses} calls)</text>
                </Show>
              </box>,
              ...((expanded() || !collapsible)
                ? skills.map((skill) => (
                  <text>
                    <span style={{ fg: statusColor(skill.status, skin) }}>{STATUS_ICON[skill.status]} </span>
                    <span style={{ fg: skin.text }}>{skill.name}</span>
                    {skill.count > 1 ? <span style={{ fg: skin.muted }}> ×{skill.count}</span> : null}
                  </text>
                ))
                : []),
            ]
          })()}
        </box>
      )
    },
  },
})

/** "Tools" section — every tool call of the session, newest at the top:
 *  a fresh call jumps to first place and older calls get pushed down.
 *  Collapsible like the built-in MCP section. */
const createToolsSection = (api: TuiPluginApi): TuiSlotPlugin => ({
  order: TOOLS_ORDER,
  slots: {
    sidebar_content(ctx: TuiSlotContext, value: { session_id?: string }) {
      const skin = look(ctx.theme.current)
      const [expanded, setExpanded] = createSignal(true)
      const sessionId = () =>
        asString(isRecord(value) ? (value as UnknownRecord).session_id : undefined)

      return (
        <box flexDirection="column">
          {(() => {
            const id = sessionId()
            const rows = id ? readToolRows(api, id) : []
            if (!id) {
              return [
                <text fg={skin.accent}>
                  <b>Tools</b>
                </text>,
                <text fg={skin.muted}>no active session</text>,
              ]
            }
            if (rows.length === 0) {
              return [
                <text fg={skin.accent}>
                  <b>Tools</b>
                </text>,
                <text fg={skin.muted}>no tool calls yet</text>,
              ]
            }
            const collapsible = rows.length > TOGGLE_AFTER
            const failed = rows.filter((row) => row.status === "error").length
            const running = rows.filter((row) => row.status === "running").length
            return [
              <box flexDirection="row" gap={1} onMouseDown={() => collapsible && setExpanded((v) => !v)}>
                <Show when={collapsible}>
                  <text fg={skin.text}>{expanded() ? "▼" : "▶"}</text>
                </Show>
                <text fg={skin.accent}>
                  <b>Tools</b>
                </text>
                <Show when={!expanded() && collapsible}>
                  <text fg={skin.muted}>
                    {" ("}{rows.length} calls{failed > 0 ? `, ${failed} failed` : ""}
                    {running > 0 ? `, ${running} running` : ""}{")"}
                  </text>
                </Show>
              </box>,
              ...((expanded() || !collapsible)
                ? rows.map((row) => (
                  <text>
                    <span style={{ fg: statusColor(row.status, skin) }}>{STATUS_ICON[row.status]} </span>
                    <span style={{ fg: skin.text }}>{row.tool}</span>
                    {row.title ? <span style={{ fg: skin.muted }}> {row.title}</span> : null}
                  </text>
                ))
                : []),
            ]
          })()}
        </box>
      )
    },
  },
})

const tui: TuiPlugin = async (api) => {
  api.slots.register(createSkillsSection(api))
  api.slots.register(createToolsSection(api))
}

const plugin: TuiPluginModule & { id: string } = {
  id: ID,
  tui,
}

export default plugin
