/**
 * model-recent — OpenCode TUI sidebar plugin (Favorites edition).
 *
 * Shows a "Favorites" section in the right sidebar listing the user's
 * favorite models (from OpenCode's own model store). Click any row to
 * switch the current session to that model instantly.
 *
 * Registered from ~/.config/opencode/tui.json:
 *   { "plugin": ["./plugins/model-recent.tsx"] }
 *
 * How switching works (important — the TUI owns the model state):
 *   The prompt's model chip and the model sent with the next prompt both
 *   come from the TUI-internal model store, which plugins cannot write
 *   directly. The only programmatic writer is the built-in keymap command
 *   `model.cycle_favorite` (F3-style cycling), which:
 *     - lands on the FIRST favorite when the current model is not a
 *       favorite, otherwise moves +1 with wrap-around, and
 *     - persists the per-session model override (and the file).
 *   So a click on favorite at index k performs:
 *     steps = currentIdx === -1 ? k + 1 : (k - currentIdx + N) % N
 *   dispatches of that command — deterministic, same math as the host.
 *
 * State sources:
 *   - favorites: {state}/model.json → "favorite" (same file the TUI uses)
 *   - current chip: per-session override we issued, else the synced
 *     session model, else config default (mirrors the host's resolution)
 *   - external changes (native dialog, F-cycles, other clients) are
 *     reconciled via `session.updated` events and fresh file reads.
 *
 * Options (tuple form in tui.json):
 *   ["./plugins/model-recent.tsx", { "maxItems": 8, "title": "Favorites" }]
 */

/** @jsxImportSource @opentui/solid */

import { createSignal, Show, type Accessor } from "solid-js"
import { readFileSync } from "node:fs"
import type {
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
  TuiSlotContext,
  TuiSlotPlugin,
} from "@opencode-ai/plugin/tui"

const ID = "model-recent"
/** Render above tool-tracker's sections (skills 600, tools 700), right
 *  after the last built-in section (files 500). */
const MODELS_ORDER = 550
/** Built-in keymap command that cycles favorites and writes the TUI's
 *  per-session model override. This is the only host-sanctioned way for a
 *  plugin to change the active model deterministically. */
const CYCLE_COMMAND = "model.cycle_favorite"

type UnknownRecord = Record<string, unknown>

/** How the TUI store identifies models ({providerID, modelID} shape). */
type Ref = { providerID: string; modelID: string }

type ResolvedOptions = {
  maxItems: number
  labelMax: number
  title: string
  collapsedByDefault: boolean
}

// ---------------------------------------------------------------------------
// Narrowing helpers (no `any` — everything crossing a boundary is unknown)
// ---------------------------------------------------------------------------

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined

const asInt = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : undefined

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value))

const clampText = (value: unknown, max: number): string => {
  const text = (asString(value) ?? "").replace(/\s+/g, " ").trim()
  if (!text) return ""
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

const errorMessage = (error: unknown): string => {
  if (isRecord(error)) {
    const message = asString(error.message)
    if (message) return clampText(message, 80)
  }
  if (typeof error === "string") return clampText(error, 80)
  return "unknown error"
}

/** Accept both {modelID} (TUI store shape) and {id} (session shape). */
const normalizeRef = (value: unknown): Ref | undefined => {
  if (!isRecord(value)) return undefined
  const providerID = asString(value.providerID)
  const modelID = asString(value.modelID) ?? asString(value.id)
  if (!providerID || !modelID) return undefined
  return { providerID, modelID }
}

const sameRef = (a: Ref, b: Ref): boolean =>
  a.providerID === b.providerID && a.modelID === b.modelID

// ---------------------------------------------------------------------------
// Host model-store bridge ({state}/model.json)
// ---------------------------------------------------------------------------

type StoreFile = {
  /** Favorites as persisted by the host (user-curated, stable order). */
  favorites: Ref[]
}

const storePathOf = (api: TuiPluginApi): string => {
  const join = (left: string, right: string): string =>
    left.endsWith("/") ? `${left}${right}` : `${left}/${right}`
  return join(api.state.path.state, "model.json")
}

const parseStoreFile = (raw: string): StoreFile => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { favorites: [] }
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.favorite)) return { favorites: [] }
  const favorites: Ref[] = []
  for (const entry of parsed.favorite) {
    const ref = normalizeRef(entry)
    if (ref) favorites.push(ref)
  }
  return { favorites }
}

const readStoreFile = (api: TuiPluginApi): StoreFile => {
  try {
    return parseStoreFile(readFileSync(storePathOf(api), "utf8"))
  } catch {
    return { favorites: [] }
  }
}

/** Replicate the host's validity filter: `cycleFavorite` only cycles
 *  favorites whose provider+model are currently available. */
const availableFavorites = (api: TuiPluginApi, favorites: readonly Ref[]): Ref[] => {
  let providers: unknown
  try {
    providers = api.state.provider
  } catch {
    return []
  }
  if (!Array.isArray(providers)) return []
  return favorites.filter((ref) => {
    const provider = providers.find(
      (candidate: unknown) => isRecord(candidate) && candidate.id === ref.providerID,
    )
    if (!isRecord(provider) || !isRecord(provider.models)) return false
    return provider.models[ref.modelID] !== undefined
  })
}

// ---------------------------------------------------------------------------
// Current-chip resolution (mirrors the host: override → session → config)
// ---------------------------------------------------------------------------

const sessionModelOf = (api: TuiPluginApi, sessionId: string): Ref | undefined => {
  try {
    return normalizeRef(api.state.session.get(sessionId)?.model)
  } catch {
    return undefined
  }
}

const configModelOf = (api: TuiPluginApi): Ref | undefined => {
  try {
    return normalizeRef(api.state.config)
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Display names (mirror the built-in model picker)
// ---------------------------------------------------------------------------

type ModelDisplay = {
  /** Human model name, e.g. "Ox Alpha Free (Unlimited)". */
  name?: string
  /** Zero input+output cost → the picker shows a "Free" tag. */
  free?: boolean
}

const describeModel = (api: TuiPluginApi, ref: Ref): ModelDisplay => {
  try {
    const provider = api.state.provider.find((candidate) => candidate.id === ref.providerID)
    if (!provider) return {}
    const raw: unknown = provider.models[ref.modelID]
    if (!isRecord(raw)) return {}
    const name = asString(raw.name)
    const cost = isRecord(raw.cost) ? raw.cost : undefined
    const input = typeof cost?.input === "number" ? cost.input : 0
    const output = typeof cost?.output === "number" ? cost.output : 0
    return {
      ...(name ? { name } : {}),
      free: input + output === 0 ? true : undefined,
    }
  } catch {
    return {}
  }
}

const primaryLabelOf = (ref: Ref, display: ModelDisplay): string =>
  display.name ?? `${ref.providerID}/${ref.modelID}`

// ---------------------------------------------------------------------------
// Theme (same approach as tool-tracker)
// ---------------------------------------------------------------------------

type Skin = {
  accent: string
  muted: string
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
    text: ink(tokens, "text", "#f0f0f0"),
    muted: ink(tokens, "textMuted", "#a5a5a5"),
    accent: ink(tokens, "primary", "#5f87ff"),
    success: ink(tokens, "success", "#4ec9b0"),
    warning: ink(tokens, "warning", "#d7ba7d"),
  }
}

// ---------------------------------------------------------------------------
// Sidebar section
// ---------------------------------------------------------------------------

const createFavoritesSection = (
  api: TuiPluginApi,
  cfg: ResolvedOptions,
  chip: Accessor<Map<string, Ref>>,
  switchTo: (sessionId: string, target: Ref) => Promise<void>,
): TuiSlotPlugin => ({
  order: MODELS_ORDER,
  slots: {
    sidebar_content(ctx: TuiSlotContext, value: { session_id?: string }) {
      const skin = look(ctx.theme.current)
      const [expanded, setExpanded] = createSignal(!cfg.collapsedByDefault)

      return (
        <box flexDirection="column">
          {(() => {
            const sessionId = asString(
              isRecord(value) ? (value as UnknownRecord).session_id : undefined,
            )

            if (!sessionId) {
              return [
                <box flexDirection="row" gap={1}>
                  <text fg={skin.accent}>
                    <b>{cfg.title}</b>
                  </text>
                </box>,
                <text fg={skin.muted}>no active session</text>,
              ]
            }

            const store = readStoreFile(api)
            const favorites = availableFavorites(api, store.favorites)
            const current = chip().get(sessionId) ?? sessionModelOf(api, sessionId) ?? configModelOf(api)

            const entries: Array<{ ref: Ref; isCurrent: boolean }> = []
            if (current && !favorites.some((ref) => sameRef(ref, current))) {
              entries.push({ ref: current, isCurrent: true })
            }
            for (const ref of favorites) {
              entries.push({ ref, isCurrent: current !== undefined && sameRef(ref, current) })
            }
            const visible = entries.slice(0, cfg.maxItems)
            const collapsible = visible.length > 0

            const headerRow = (
              <box flexDirection="row" gap={1} onMouseDown={() => collapsible && setExpanded((v) => !v)}>
                <Show when={collapsible}>
                  <text fg={skin.text}>{expanded() ? "▼" : "▶"}</text>
                </Show>
                <text fg={skin.accent}>
                  <b>{cfg.title}</b>
                </text>
              </box>
            )

            if (visible.length === 0) {
              return [
                headerRow,
                <text fg={skin.muted}>no favorites yet</text>,
                <text fg={skin.muted}>/models → Ctrl+F to add</text>,
              ]
            }

            const rows = visible.map(({ ref, isCurrent }) => {
              const display = describeModel(api, ref)
              return (
                <box
                  flexDirection="row"
                  gap={1}
                  onMouseDown={() => {
                    if (!isCurrent) void switchTo(sessionId, ref)
                  }}
                >
                  <text fg={isCurrent ? skin.success : skin.muted}>{isCurrent ? "●" : "○"}</text>
                  <text fg={isCurrent ? skin.success : skin.text}>
                    {clampText(primaryLabelOf(ref, display), cfg.labelMax)}
                  </text>
                  {display.free ? <text fg={skin.warning}>Free</text> : null}
                </box>
              )
            })

            return [
              headerRow,
              ...(expanded() ? rows : []),
            ]
          })()}
        </box>
      )
    },
  },
})

// ---------------------------------------------------------------------------
// Plugin entrypoint
// ---------------------------------------------------------------------------

const resolveOptions = (raw: unknown): ResolvedOptions => {
  const source: UnknownRecord = isRecord(raw) ? raw : {}
  return {
    maxItems: clamp(asInt(source.maxItems) ?? 8, 1, 20),
    labelMax: clamp(asInt(source.labelMax) ?? 22, 8, 60),
    title: clampText(asString(source.title) ?? "Favorites", 24) || "Favorites",
    collapsedByDefault: source.collapsedByDefault === true,
  }
}

const tui: TuiPlugin = async (api, options) => {
  const cfg = resolveOptions(options)

  /** Per-session model override WE issued (mirrors the host's
   *  q.model[session] map; external changes reconciled via events). */
  const override = new Map<string, Ref>()
  const [chip, setChip] = createSignal<Map<string, Ref>>(override)

  /** Keep the override map in sync with externally-driven model changes
   *  (native dialog picks, manual favorite cycling, other clients). By the
   *  time the server records the new model, the host store already holds
   *  it — mirroring it here keeps our step math exact. */
  api.event.on("session.updated", (event) => {
    const sessionId = event.properties.sessionID
    const ref = normalizeRef(event.properties.info.model)
    if (!ref) return
    if (override.get(sessionId) && sameRef(override.get(sessionId)!, ref)) return
    override.set(sessionId, ref)
    setChip(new Map(override))
  })

  const dispatchCycle = (steps: number): void => {
    for (let i = 0; i < steps; i += 1) {
      try {
        api.keymap.dispatchCommand(CYCLE_COMMAND)
      } catch {
        return
      }
    }
  }

  const switchTo = async (sessionId: string, target: Ref): Promise<void> => {
    try {
      // Fresh read: favorites may have changed since the last render.
      const favorites = availableFavorites(api, readStoreFile(api).favorites)
      if (favorites.length === 0) {
        api.ui.toast({
          variant: "warning",
          title: cfg.title,
          message: "No favorites — add one via /models (Ctrl+F)",
          duration: 4000,
        })
        return
      }

      const current =
        chip().get(sessionId) ?? sessionModelOf(api, sessionId) ?? configModelOf(api)
      if (current && sameRef(current, target)) {
        api.ui.toast({
          variant: "info",
          title: cfg.title,
          message: `${clampText(primaryLabelOf(target, describeModel(api, target)), 40)} is active`,
          duration: 2000,
        })
        return
      }

      const indexCurrent = current ? favorites.findIndex((ref) => sameRef(ref, current)) : -1
      const indexTarget = favorites.findIndex((ref) => sameRef(ref, target))
      if (indexTarget === -1) return

      // Same arithmetic as the host: not-in-list lands on favorites[0],
      // otherwise +1 steps with wrap-around.
      const steps =
        indexCurrent === -1
          ? indexTarget + 1
          : (indexTarget - indexCurrent + favorites.length) % favorites.length
      if (steps <= 0) return

      dispatchCycle(steps)
      override.set(sessionId, target)
      setChip(new Map(override))

      // Best-effort: keep the server-side session model aligned for other
      // clients (web/desktop). The TUI itself already switched above.
      try {
        await api.client.v2.session.switchModel({
          sessionID: sessionId,
          model: { providerID: target.providerID, id: target.modelID },
        })
      } catch {
        // Server sync is optional; the TUI drives subsequent prompts.
      }

      api.ui.toast({
        variant: "success",
        title: cfg.title,
        message: `→ ${clampText(primaryLabelOf(target, describeModel(api, target)), 40)}`,
        duration: 2000,
      })
    } catch (error) {
      api.ui.toast({
        variant: "error",
        title: cfg.title,
        message: `Switch failed: ${errorMessage(error)}`,
        duration: 4000,
      })
    }
  }

  api.slots.register(createFavoritesSection(api, cfg, chip, switchTo))
}

const plugin: TuiPluginModule & { id: string } = {
  id: ID,
  tui,
}

export default plugin
