/**
 * opencode-notify-nodered — terminal (TUI) side.
 *
 * Adds a per-session notification toggle to the OpenCode TUI:
 *   - the 🔔/🔕 icon in the prompt footer is CLICKABLE — one left click
 *     toggles the notifications for the current session and the icon
 *     swaps reactively;
 *   - `/notify`            opens a Ligado/Desligado selector for the session;
 *   - `/notify on|off`     sets it directly;
 *   - Command palette:     "Notificações: alternar desta sessão".
 *
 * The server plugin is the source of truth (via RPC). This TUI keeps a local
 * reactive cache (durable, synced across TUI instances) so the icon updates
 * instantly; clicks ask the server for the real state before toggling.
 *
 * Hardening notes (verified live on OpenCode 2.1.4):
 *   - an invalid toast `variant` CRASHES the whole TUI (the toast surface
 *     reads theme.text.feedback[variant].base unguarded), so every toast goes
 *     through `showToast`, which contains any error;
 *   - OpenCode does not render a toast shown while another one is still
 *     visible — rapid consecutive toggles show only the first toast. The
 *     icon swap and the server state stay correct; the toast is best-effort.
 */
import { Plugin } from "@opencode/plugin/tui"
import { NotifyRpc } from "./rpc.js"

type ToggleResult = { enabled: boolean }

/** OpenTUI MouseEvent button codes. */
const LEFT_BUTTON = 0

/** Minimal shape of the mouse events we consume in JSX handlers. */
type MouseEventLike = {
  button?: number
  stopPropagation?: () => void
}

export default Plugin.define({
  id: "notify-nodered.tui",
  setup(context) {
    const rpc = context.client.rpc(NotifyRpc)

    // Local cache of sessions explicitly disabled. Unknown session = enabled
    // (the server default), so the cache only needs the exceptions.
    const [cache, updateCache] = context.storage.store("notify-nodered", {
      initial: { disabled: {} as Record<string, boolean> },
    })

    const currentSessionID = (): string | undefined => {
      try {
        const current = context.ui.router.current() as { type?: string; sessionID?: string } | undefined
        if (current && current.type === "session" && typeof current.sessionID === "string") return current.sessionID
      } catch {
        /* router not ready */
      }
      return undefined
    }

    const isEnabled = (sessionID: string): boolean => cache.disabled?.[sessionID] !== true

    // A toast with an invalid variant takes the whole TUI down (see header),
    // so every toast goes through this contained helper.
    type ToastVariant = "info" | "success" | "warning" | "error"
    const showToast = (message: string, variant: ToastVariant = "info", duration = 2500) => {
      try {
        context.ui.toast.show({ title: "Notificações", message, variant, duration })
      } catch {
        /* never let a toast kill the app */
      }
    }

    // Cosmetic: show a pointer cursor over the icon when the terminal
    // supports pointer styles. Any failure is silently ignored.
    const setPointer = (style: string) => {
      try {
        const renderer = context.renderer as
          | { setMousePointer?: (style: string) => void; requestRender?: () => void }
          | undefined
        renderer?.setMousePointer?.(style)
        renderer?.requestRender?.()
      } catch {
        /* cosmetic only */
      }
    }

    const setEnabled = async (sessionID: string, enabled: boolean) => {
      try {
        const result = (await rpc.setEnabled({ sessionID, enabled })) as ToggleResult
        await updateCache((draft) => {
          if (result.enabled) delete draft.disabled[sessionID]
          else draft.disabled[sessionID] = true
        })
        showToast(
          result.enabled ? "🔔 Ligadas nesta sessão" : "🔕 Desligadas nesta sessão",
          result.enabled ? "success" : "info",
        )
      } catch (err) {
        showToast("Falha ao aplicar (servidor respondeu?): " + String(err).slice(0, 200), "error")
      }
    }

    /** Ask the server for the real state, then flip it. Used by the icon click. */
    const toggleEnabled = async (sessionID: string) => {
      let enabled = isEnabled(sessionID)
      try {
        enabled = ((await rpc.status({ sessionID })) as ToggleResult).enabled
      } catch {
        /* fall back to the local cache */
      }
      return setEnabled(sessionID, !enabled)
    }

    // One-shot background sync per session so the icon matches the server
    // (e.g. the state was toggled via API or by another TUI instance).
    const synced = new Set<string>()
    const syncSessionState = (sessionID: string) => {
      if (synced.has(sessionID)) return
      synced.add(sessionID)
      void rpc
        .status({ sessionID })
        .then((result) => {
          const enabled = (result as ToggleResult).enabled
          void updateCache((draft) => {
            if (enabled) delete draft.disabled[sessionID]
            else draft.disabled[sessionID] = true
          })
        })
        .catch(() => {
          synced.delete(sessionID) // allow a retry on a later render
        })
    }

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "notify-nodered.toggle",
          title: "Notificações: alternar desta sessão",
          group: "Notificações",
          palette: true,
          slash: { name: "notify", aliases: ["notif"], arguments: true },
          suggested: true,
          run: async (input?: string) => {
            const sessionID = currentSessionID()
            if (!sessionID) {
              showToast("Abra uma sessão para alternar as notificações dela.", "info")
              return
            }
            const arg = (input ?? "").trim().toLowerCase()
            if (arg === "on" || arg === "ligado" || arg === "ligar") return setEnabled(sessionID, true)
            if (arg === "off" || arg === "desligado" || arg === "desligar") return setEnabled(sessionID, false)

            let enabled = isEnabled(sessionID)
            try {
              enabled = ((await rpc.status({ sessionID })) as ToggleResult).enabled
            } catch {
              /* fall back to the local cache */
            }
            const choice = await context.ui.dialog.select({
              title: "Notificações desta sessão",
              current: enabled ? "on" : "off",
              options: [
                { title: "🔔 Ligadas (padrão)", value: "on", description: "Avisa: terminou, pergunta, permissão, erro." },
                { title: "🔕 Desligadas", value: "off", description: "Nenhum aviso desta sessão." },
              ],
            })
            if (choice === undefined) return
            return setEnabled(sessionID, choice === "on")
          },
        },
      ],
    }))

    // Footer icon — clickable toggle.
    // OpenTUI does not synthesize a "click": a click is a down+up pair, so we
    // only toggle when the left-button up happens after a down on the icon
    // (guards against, say, a text-selection drag released over the icon).
    let iconPressed = false
    const unregisterFooter = context.ui.slot({
      append: "prompt.footer.status",
      render: (props: { sessionID?: string }) => {
        const sessionID = props?.sessionID
        if (!sessionID) return null
        syncSessionState(sessionID)
        const enabled = isEnabled(sessionID)
        const muted = (context.theme.text as Record<string, string | undefined>).muted
        return (
          <text
            selectable={false}
            fg={enabled ? context.theme.text.base : (muted ?? context.theme.text.base)}
            onMouseOver={() => setPointer("pointer")}
            onMouseOut={() => setPointer("default")}
            onMouseDown={(event: MouseEventLike) => {
              if (event.button !== LEFT_BUTTON) return
              iconPressed = true
            }}
            onMouseUp={(event: MouseEventLike) => {
              if (event.button !== LEFT_BUTTON || !iconPressed) return
              iconPressed = false
              event.stopPropagation?.()
              void toggleEnabled(sessionID)
            }}
          >
            {enabled ? "🔔" : "🔕"}
          </text>
        )
      },
    })

    return () => {
      try {
        unregisterFooter?.()
      } catch {
        /* already disposed */
      }
    }
  },
})
