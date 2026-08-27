import { createSignal } from "solid-js"
import type {
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
  TuiSlotContext,
  TuiSlotPlugin,
} from "@opencode-ai/plugin/tui"

const ID = "sidebar-pet"
const ORDER = 0

type PetStatus = "idle" | "thinking" | "working" | "success" | "error"
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

const petFaces: Record<PetStatus, readonly string[]> = {
  idle: ["◉‿◉", "•ᴗ•", "ᵔᴥᵔ", "(•‿•)", "(¬‿¬)"],
  thinking: ["◉_◉", "◉‿◉", "(¬‿¬)"],
  working: ["◉▿◉", "•ᴗ•", "ᵔᴥᵔ", "(•‿•)"],
  success: ["^‿^", "•ᴗ•", "(•‿•)", "ᵔᴥᵔ"],
  error: ["ಠ_ಠ", "(╥﹏╥)", "◉_◉"],
}

const faceOf = (status: PetStatus, tick: number): string => {
  const faces = petFaces[status]
  return faces[tick % faces.length]
}

const messageOf = (status: PetStatus): string => {
  switch (status) {
    case "thinking":
      return "Thinking..."
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
    case "working":
    case "thinking":
      return skin.warning
    case "success":
      return skin.success
    case "error":
      return skin.error
    default:
      return skin.accent
  }
}

const statusFromToolPart = (part: UnknownRecord): PetStatus | undefined => {
  const state = isRecord(part.state) ? part.state : {}
  switch (asString(state.status)) {
    case "pending":
      return "thinking"
    case "running":
      return "working"
    case "completed":
      return "success"
    case "error":
      return "error"
    default:
      return undefined
  }
}

const IDLE_DELAY_MS = 4_000

const createPetSection = (api: TuiPluginApi): TuiSlotPlugin => {
  const [status, setStatus] = createSignal<PetStatus>("idle")
  const [tick, setTick] = createSignal(0)
  let idleTimer: ReturnType<typeof setTimeout> | undefined

  const clearIdleTimer = (): void => {
    if (idleTimer === undefined) return
    clearTimeout(idleTimer)
    idleTimer = undefined
  }

  const updateStatus = (next: PetStatus): void => {
    clearIdleTimer()
    setStatus(next)
    if (next === "success" || next === "error") {
      idleTimer = setTimeout(() => setStatus("idle"), IDLE_DELAY_MS)
    }
  }

  const animation = setInterval(() => {
    setTick((current) => current + 1)
  }, 1200)

  const disposers = [
    api.event.on("message.part.updated", (event) => {
      const properties: unknown = event.properties
      const part = isRecord(properties) ? properties.part : undefined
      if (!isRecord(part) || part.type !== "tool") return
      const next = statusFromToolPart(part)
      if (next) updateStatus(next)
    }),
    api.event.on("message.updated", () => updateStatus("thinking")),
    api.event.on("session.updated", () => updateStatus("success")),
    api.event.on("session.error", () => updateStatus("error")),
  ]

  api.lifecycle.onDispose(() => {
    clearInterval(animation)
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
              <text fg={skin.muted}>{messageOf(status())}</text>
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