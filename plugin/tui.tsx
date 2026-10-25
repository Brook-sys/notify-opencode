/**
 * opencode-notify-nodered — terminal (TUI) side.
 *
 * Adds a per-session notification toggle to the OpenCode TUI:
 *   - `/notify`            opens a Ligado/Desligado selector for the session
 *   - `/notify on|off`    sets it directly
 *   - Command palette: "Notificações: alternar desta sessão"
 *   - A 🔔/🔕 indicator in the prompt footer shows the state of the
 *     current session.
 *
 * The server plugin is the source of truth (via RPC). This TUI keeps a local
 * reactive cache so the footer updates instantly.
 */
import { Plugin } from "@opencode/plugin/tui"
import { NotifyRpc } from "./rpc.js"

type ToggleResult = { enabled: boolean }

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

    const setEnabled = async (sessionID: string, enabled: boolean) => {
      try {
        const result = (await rpc.setEnabled({ sessionID, enabled })) as ToggleResult
        await updateCache((draft) => {
          if (result.enabled) delete draft.disabled[sessionID]
          else draft.disabled[sessionID] = true
        })
        context.ui.toast.show({
          title: "Notificações",
          message: result.enabled ? "🔔 Ligadas nesta sessão" : "🔕 Desligadas nesta sessão",
          variant: result.enabled ? "success" : "default",
          duration: 2500,
        })
      } catch (err) {
        context.ui.toast.show({
          title: "Notificações",
          message: "Falha ao aplicar (servidor respondeu?): " + String(err),
          variant: "error",
        })
      }
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
              context.ui.toast.show({
                title: "Notificações",
                message: "Abra uma sessão para alternar as notificações dela.",
                variant: "default",
              })
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

    const unregisterFooter = context.ui.slot({
      append: "prompt.footer.status",
      render: (props: { sessionID?: string }) => {
        const sessionID = props?.sessionID
        if (!sessionID) return null
        return <text fg={context.theme.text.base}>{isEnabled(sessionID) ? "🔔" : "🔕"}</text>
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
