/**
 * sidebar-pet — OpenCode TUI sidebar plugin.
 *
 * Tracks the status of the SELECTED session:
 *   idle | thinking (reasoning streaming) | writing (text streaming)
 *   | working (tools/steps) | success (turn finished) | error
 *
 * Busy statuses are TIMED per cycle: the live row shows elapsed seconds
 * for the current status period ("Thinking... 7s"). Every transition
 * restarts the count — returning to a status later starts from 0 again.
 *
 * Sources of truth — verified against the actual event wire protocol
 * (opencode 1.18.x, captured via `opencode serve` + SSE /event):
 *
 *   The server does NOT emit `session.next.*` events. What it emits:
 *     - `session.status`  {sessionID, status: {type: busy|idle|retry}}
 *       → authoritative turn anchor (the same signal the TUI spinner uses).
 *     - `message.part.updated` {sessionID, part}
 *       part.type: "step-start" | "reasoning" | "text" | "tool"
 *                | "step-finish" (reason: "tool-calls" → more rounds,
 *                                 "stop" → turn done)
 *       A "reasoning" part is created with text:"" (thinking begins) and
 *       updated later with the full text (thinking ended).
 *     - `message.part.delta` {sessionID, partID, field, delta}
 *       → live stream; classify via the partID → part.type map built from
 *       message.part.updated ("reasoning" → thinking, "text" → writing).
 *     - `session.idle` / `session.error` → terminal states.
 *
 *   User-prompt parts arrive BEFORE the first `session.status: busy`, so an
 *   in-turn gate (busy…idle) keeps them from polluting the status.
 */

import { createSignal } from "solid-js"
import type { SessionStatus } from "@opencode-ai/sdk/v2"
import type {
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
  TuiSlotContext,
  TuiSlotPlugin,
} from "@opencode-ai/plugin/tui"

const ID = "sidebar-pet"
const ORDER = 0

type PetStatus = "idle" | "thinking" | "writing" | "working" | "success" | "error"
type UnknownRecord = Record<string, unknown>

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined

type Skin = {
  accent: string
  border: string
  error: string
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
    accent: ink(tokens, "primary", "#5f87ff"),
    border: ink(tokens, "border", "#4a4a4a"),
    error: ink(tokens, "error", "#f14c4c"),
    muted: ink(tokens, "textMuted", "#a5a5a5"),
    success: ink(tokens, "success", "#4ec9b0"),
    text: ink(tokens, "text", "#f0f0f0"),
    warning: ink(tokens, "warning", "#d7ba7d"),
  }
}

/**
 * Each status owns a DISTINCT signature — rotation only adds subtle
 * micro-motion (blinks, glances, mouth movement) and never borrows
 * another status's look, so the face alone reads the state:
 *
 *   idle     calm smile, occasional squint + blink
 *   thinking eyes up, flat mouth (pondering), one side-eye tick
 *   writing  dot eyes on the page, chattering mouth (typing)
 *   working  grinding open mouth, solid stare every few ticks
 *   success  happy dog, one closed-eye grin tick
 *   error   disapproval, then crying
 *
 * All faces are 3 glyphs wide so the row doesn't jitter while cycling.
 */
const petFaces: Record<PetStatus, readonly string[]> = {
  idle: ["(◉‿◉)", "(˘‿˘)", "(◉‿◉)", "(-‿-)"],
  thinking: ["(◔_◔)", "(◉_◔)", "(◔_◔)", "(¬_¬)", "(ᵕ_ᵕ)"],
  writing: ["(•‿•)✎", "(•o•)⋆", "(•‿•)✎", "(•o•)⋆", "(•ᴗ•)✎", "(•ᴗ•)⋆", "(ᵔᴗᵔ)✎"],
  working: ["(◉▿◉)⚙", "(◉▽◉)⋆", "(◉▿◉)⚙", "(●▿●)⋆", "(•ᴗ•)⚙", "(•_•)⋆", "(ᗒᴗᗕ)⚙", "(•̀ᴗ•́)⋆"],
  success: ["(ᵔᴥᵔ)", "(ᵔᴥᵔ)", "(ᵔᴥᵔ)", "(^‿^)", "(ᵔᴗᵔ)♡", "(•ᴗ•)✦", "(^ᴗ^)", "(ᵔ‿ᵔ)"],
  error: ["(ಠ_ಠ)", "()ಠ_ಠ)", "(T_T)", "(T_T)"],
}

const faceOf = (status: PetStatus, tick: number): string => {
  const faces = petFaces[status]
  return faces[tick % faces.length]
}

const messageOf = (status: PetStatus): string => {
  switch (status) {
    case "thinking":
      return "Thinking..."
    case "writing":
      return "Writing..."
    case "working":
      return "Working..."
    case "success":
      return "Done!"
    case "error":
      return "Error"
    default:
      return "Ready"
  }
}

const colorOf = (status: PetStatus, skin: Skin): string => {
  switch (status) {
    case "thinking":
      return skin.warning
    case "working":
    case "writing":
      return skin.accent
    case "success":
      return skin.success
    case "error":
      return skin.error
    default:
      return skin.muted
  }
}

/** Busy pet states — terminal/anchor transitions behave differently. */
const isBusy = (status: PetStatus): boolean =>
  status === "thinking" || status === "writing" || status === "working"

/** Compact duration: `12s`, `2m05s`. */
const formatMs = (ms: number): string => {
  const total = Math.round(ms / 1000)
  if (total < 60) return `${total}s`
  return `${Math.floor(total / 60)}m${String(total % 60).padStart(2, "0")}s`
}

/** Map the host's session status (the TUI spinner signal) to a pet status. */
const busyStatusOf = (status: SessionStatus | undefined): PetStatus => {
  if (status === undefined) return "idle"
  return status.type === "busy" || status.type === "retry" ? "working" : "idle"
}

const IDLE_DELAY_MS = 4_000

const createPetSection = (api: TuiPluginApi): TuiSlotPlugin => {
  const [status, setStatus] = createSignal<PetStatus>("idle")
  const [tick, setTick] = createSignal(0)
  /** Fast cadence for the live seconds counter — separate from the face
   *  animation so counting up doesn't speed up the pet's mood. */
  const [timerTick, setTimerTick] = createSignal(0)
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  /** Session the pet is currently tracking (from the last slot render). */
  let selectedSessionId: string | undefined
  /** True between `session.status: busy` and its `idle` — gates part events
   *  so the user's own prompt parts never pollute the status. */
  let inTurn = false
  /** partID → part.type, so `message.part.delta` can be classified. */
  const partTypes = new Map<string, string>()
  /** When the current status period began (undefined while not busy). */
  let statusSince: number | undefined

  const clearIdleTimer = (): void => {
    if (idleTimer === undefined) return
    clearTimeout(idleTimer)
    idleTimer = undefined
  }

  const updateStatus = (next: PetStatus): void => {
    const prev = status()
    if (next === prev) return // repeated deltas must not restart the timer
    clearIdleTimer()
    // Each status period counts from zero — going thinking → working →
    // thinking restarts the thinking counter instead of resuming it.
    statusSince = isBusy(next) ? Date.now() : undefined
    setStatus(next)
    if (next === "success" || next === "error") {
      idleTimer = setTimeout(() => updateStatus("idle"), IDLE_DELAY_MS)
    }
  }

  /** A fresh "Done!"/"Error" flash is allowed to decay naturally instead of
   *  being cut short by the trailing idle event. */
  const isFlashing = (): boolean => status() === "success" || status() === "error"

  /** Re-sync from the host's synced session state — used on session switch
   *  so a pet mounted mid-run shows busy immediately. Deferred to a
   *  microtask because the slot render scope reads `status()`. */
  const syncFromSessionState = (sessionId: string): void => {
    queueMicrotask(() => {
      if (sessionId !== selectedSessionId) return
      let next: PetStatus = "idle"
      try {
        next = busyStatusOf(api.state.session.status(sessionId))
      } catch {
        next = "idle"
      }
      inTurn = isBusy(next)
      statusSince = isBusy(next) ? Date.now() : undefined
      updateStatus(next)
    })
  }

  /** "Thinking... 7s" — live elapsed for the current status period. */
  const statusLine = (): string => {
    const current = status()
    const label = messageOf(current)
    if (!isBusy(current) || statusSince === undefined) return label
    // Reactive dep: without this the expression runs once at the
    // transition (elapsed ≈ 0) and the seconds freeze at "1s".
    timerTick()
    return `${label} ${formatMs(Date.now() - statusSince)}`
  }

  const animation = setInterval(() => {
    setTick((current) => current + 1)
  }, 1200)

  const timerInterval = setInterval(() => {
    setTimerTick((current) => current + 1)
  }, 500)

  const disposers = [
    // Turn anchor — the authoritative busy/idle signal (TUI spinner source).
    api.event.on("session.status", (event) => {
      if (event.properties.sessionID !== selectedSessionId) return
      const type = event.properties.status.type
      inTurn = type !== "idle"
      if (type === "idle") {
        if (isFlashing()) return
        updateStatus("idle")
        return
      }
      // busy / retry — anchor as busy; refinement events follow. Re-issued
      // busy events between steps must not override thinking/writing, and
      // the trailing busy after `step-finish: stop` must not wipe the
      // "Done!" flash (a genuine new turn re-anchors via its part events).
      if (isFlashing() || isBusy(status())) return
      updateStatus("working")
    }),
    api.event.on("session.idle", (event) => {
      if (event.properties.sessionID !== selectedSessionId) return
      inTurn = false
      if (isFlashing()) return
      updateStatus("idle")
    }),

    // Part lifecycle — tells us WHAT the busy session is doing.
    api.event.on("message.part.updated", (event) => {
      if (event.properties.sessionID !== selectedSessionId) return
      const part: unknown = event.properties.part
      if (!isRecord(part)) return
      const partId = asString(part.id)
      const partType = asString(part.type)
      if (partId && partType) partTypes.set(partId, partType)
      if (!inTurn) return // user prompt parts arrive before busy

      switch (partType) {
        case "step-start":
          updateStatus("working")
          break
        case "reasoning":
          // Created with text:"" → thinking begins; the full-text update
          // that closes the block arrives after the tool call starts.
          updateStatus(asString(part.text) ? "working" : "thinking")
          break
        case "text":
          // Assistant text block created → the model is writing its answer.
          updateStatus("writing")
          break
        case "tool": {
          // pending/running → tools executing; completed/error → the turn
          // continues (the model reacts to the result), so stay busy.
          const state = isRecord(part.state) ? part.state : {}
          const toolStatus = asString(state.status) ?? "pending"
          if (toolStatus === "pending" || toolStatus === "running") {
            updateStatus("working")
          } else if (!isBusy(status())) {
            updateStatus("working")
          }
          break
        }
        case "step-finish": {
          // "stop" → the model is done for good; any other reason
          // ("tool-calls", ...) means more rounds are coming.
          if (asString(part.reason) === "stop") updateStatus("success")
          break
        }
        default:
          break
      }
    }),

    // Live stream — classify deltas via the partID → type map.
    api.event.on("message.part.delta", (event) => {
      if (event.properties.sessionID !== selectedSessionId) return
      if (!inTurn) return
      const kind = partTypes.get(event.properties.partID)
      if (kind === "reasoning") updateStatus("thinking")
      else if (kind === "text") updateStatus("writing")
    }),

    api.event.on("session.error", (event) => {
      const sessionID = event.properties.sessionID
      if (sessionID !== undefined && sessionID !== selectedSessionId) return
      inTurn = false
      updateStatus("error")
    }),
  ]

  api.lifecycle.onDispose(() => {
    clearInterval(animation)
    clearInterval(timerInterval)
    clearIdleTimer()
    for (const dispose of disposers) dispose()
  })

  return {
    order: ORDER,
    slots: {
      sidebar_content(ctx: TuiSlotContext, value: { session_id?: string }) {
        const skin = look(ctx.theme.current)
        const sessionId = asString(isRecord(value) ? value.session_id : undefined)

        if (!sessionId) return <box />

        if (sessionId !== selectedSessionId) {
          selectedSessionId = sessionId
          syncFromSessionState(sessionId)
        }

        return (
          <box
            flexDirection="column"
            gap={0}
            marginTop={-1}
            marginBottom={-1}
            paddingLeft={1}
            paddingRight={1}
            paddingTop={0}
            paddingBottom={0}
            borderStyle="single"
            borderColor={skin.border}
          >
            <box flexDirection="row" gap={1}>
              <text fg={colorOf(status(), skin)}>{faceOf(status(), tick())}</text>
              <text fg={skin.muted}>{statusLine()}</text>
            </box>
          </box>
        )
      },
    },
  }
}

const tui: TuiPlugin = async (api) => {
  api.slots.register(createPetSection(api))
}

const plugin: TuiPluginModule & { id: string } = {
  id: ID,
  tui,
}

export default plugin
