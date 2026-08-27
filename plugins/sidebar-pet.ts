/**
 * sidebar-pet — OpenCode hook plugin.
 *
 * Kept as a valid server-side plugin so auto-discovery from
 * ~/.config/opencode/plugins does not fail. The visual pet lives in
 * sidebar-pet.tui.tsx and listens to TUI events directly.
 */

import type { Plugin } from "@opencode-ai/plugin"

export const SidebarPetPlugin: Plugin = async () => {
  return {}
}

export default SidebarPetPlugin
