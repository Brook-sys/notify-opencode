/**
 * opencode-notify-nodered — server side.
 *
 * Watches OpenCode sessions and pushes webhook events to a Node-RED flow:
 *   - question    agent is asking the user something (question tool)
 *   - permission  agent is blocked waiting for permission approval
 *   - done        the session turn finished successfully
 *   - error       the session turn failed
 *
 * Design constraints (verified against OpenCode 2.1.4):
 *   - The plugin is instantiated once per loaded location. Every instance
 *     receives the whole event stream, so events are filtered by
 *     `event.location.directory` to avoid duplicate notifications.
 *   - Hooks (tool / permission) run once per session, in the instance that
 *     owns the session's location — no extra filtering needed there.
 *   - Plugin storage is shared across instances, which is where the
 *     per-session "disabled" set lives (RPC is used by the TUI to edit it).
 *   - Every send is fire-and-forget with a short timeout: a notification
 *     outage must never delay or crash a session.
 */
import { Plugin } from "@opencode/plugin"
import { NotifyRpc } from "./rpc.js"

type Options = {
  url?: string
  token?: string
  minDurationSec?: number
  includePreview?: boolean
  includeQuestionText?: boolean
  debug?: boolean
  debugLogPath?: string
}

type State = { disabled?: Record<string, boolean> }

type StreamEvent = {
  id?: string
  type?: string
  location?: { directory?: string }
  data?: { sessionID?: string; text?: string; reason?: string }
}

type QuestionHookEvent = {
  tool?: string
  sessionID?: string
  agent?: string
  input?: { questions?: Array<{ question?: string; header?: string; options?: Array<{ label?: string }> }> }
}

type PermissionHookEvent = {
  sessionID?: string
  agent?: string
  action?: string
  resources?: string[]
  effect?: "allow" | "ask" | "deny"
}

type SessionInfo = {
  title?: string
  parentID?: string
  location?: { directory?: string }
}

export default Plugin.define({
  id: "notify-nodered",
  async setup(ctx) {
    const options = (ctx.options ?? {}) as Options
    const url = options.url ?? "http://localhost:1880/opencode/event"
    const token = options.token ?? process.env.OPENCODE_NOTIFY_TOKEN ?? ""
    const includePreview = options.includePreview !== false
    const includeQuestionText = options.includeQuestionText !== false
    const minDurationSec = Math.max(0, Number(options.minDurationSec ?? 0))
    const debug = options.debug === true
    const debugLogPath = options.debugLogPath ?? "/tmp/opencode/notify-nodered-debug.jsonl"
    const here = ctx.location.directory ?? ""

    const debugLog = (kind: string, data: unknown) => {
      if (!debug) return
      try {
        // Lazy import keeps the non-debug path dependency-free.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const fs = require("node:fs")
        let body: string
        try {
          body = JSON.stringify(data)
        } catch {
          body = String(data)
        }
        fs.appendFileSync(debugLogPath, JSON.stringify({ t: new Date().toISOString(), kind, data: body }) + "\n")
      } catch {
        /* never throw from logging */
      }
    }

    // ---------------------------------------------------------------------------
    // Per-session state (shared across plugin instances via plugin storage).
    // Absence from `disabled` means ENABLED — the default for every session.
    // ---------------------------------------------------------------------------
    const state = ((await ctx.storage.get("state")) as State | undefined) ?? {}
    const disabled = new Set(Object.keys(state.disabled ?? {}).filter((id) => state.disabled?.[id]))
    const persistState = async () => {
      const next: State = { disabled: {} }
      for (const id of disabled) next.disabled![id] = true
      await ctx.storage.set("state", next)
    }

    // Turn bookkeeping (module-scoped: after the location filter each instance
    // only handles its own sessions, so per-instance maps are correct).
    const turnStarted = new Map<string, number>()
    const lastAssistantText = new Map<string, string>()

    const isEnabled = (sessionID: string) => !disabled.has(sessionID)

    // ---------------------------------------------------------------------------
    // Webhook delivery — fire-and-forget, short timeout, never throws.
    // ---------------------------------------------------------------------------
    const send = (payload: Record<string, unknown>) => {
      if (!token || !url) {
        debugLog("send.skipped", { reason: "missing url or token", type: payload.type })
        return
      }
      const body = JSON.stringify({ ...payload, from: here, ts: Date.now() })
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 4000)
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-webhook-token": token },
        body,
        signal: controller.signal,
      })
        .then((res) => {
          if (!res.ok) debugLog("send.http-error", { status: res.status, type: payload.type })
          else debugLog("send.ok", { type: payload.type, sessionID: payload.sessionID })
        })
        .catch((err) => debugLog("send.error", { error: String(err), type: payload.type }))
        .finally(() => clearTimeout(timer))
    }

    const sessionMeta = async (sessionID: string): Promise<SessionInfo> => {
      try {
        const info = (await ctx.session.get({ sessionID })) as SessionInfo
        return info ?? {}
      } catch {
        return {}
      }
    }

    /**
     * Turn finished (succeeded or failed).
     *
     * `session.execution.*` events carry no `location`, so every plugin
     * instance receives them. The instance that owns the session's location
     * (per ctx.session.get) is the only one allowed to send.
     */
    const handleExecutionEnd = async (sessionID: string, outcome: "succeeded" | "failed", eventID?: string) => {
      const started = turnStarted.get(sessionID)
      turnStarted.delete(sessionID)
      const preview = includePreview ? (lastAssistantText.get(sessionID) ?? "") : ""
      lastAssistantText.delete(sessionID)

      if (!isEnabled(sessionID)) return

      const meta = await sessionMeta(sessionID)

      // Ownership check — this is what deduplicates across instances.
      if (meta.location?.directory && here && meta.location.directory !== here) {
        debugLog("done.skipped-not-owner", { sessionID, owner: meta.location.directory, me: here })
        return
      }

      // Best-effort id guard for the rare case session.get fails and the
      // ownership check is skipped by all instances at once.
      if (eventID) {
        try {
          const seen = ((await ctx.storage.get("recentIds")) as { ids?: string[] } | undefined) ?? {}
          const ids = new Set(seen.ids ?? [])
          if (ids.has(eventID)) return
          ids.add(eventID)
          await ctx.storage.set("recentIds", { ids: [...ids].slice(-80) })
        } catch (err) {
          debugLog("done.lru-error", String(err))
        }
      }

      // Subagent sessions: the parent turn is what matters to the user.
      if (meta.parentID) {
        debugLog("done.suppressed-subagent", { sessionID, parentID: meta.parentID })
        return
      }

      if (minDurationSec > 0 && started !== undefined && Date.now() - started < minDurationSec * 1000) {
        debugLog("done.filtered", { sessionID, elapsedSec: Math.round((Date.now() - started) / 1000) })
        return
      }

      send({
        type: outcome === "succeeded" ? "done" : "error",
        sessionID,
        title: meta.title,
        preview: preview.slice(0, 280),
        durationSec: started !== undefined ? Math.round((Date.now() - started) / 1000) : undefined,
      })
    }

    // ---------------------------------------------------------------------------
    // Hooks (documented, run once per session).
    // ---------------------------------------------------------------------------
    const regToolBefore = await ctx.tool.hook("execute.before", (event) => {
      try {
        const hookEvent = event as unknown as QuestionHookEvent
        if (hookEvent.tool !== "question") return
        const sessionID = hookEvent.sessionID ?? ""
        if (!sessionID || !isEnabled(sessionID)) return

        const questions = Array.isArray(hookEvent.input?.questions) ? hookEvent.input!.questions! : []
        const first = questions[0] ?? {}
        const optionLabels = (first.options ?? [])
          .map((option) => option?.label ?? "")
          .filter((label) => label.length > 0)
          .slice(0, 6)

        send({
          type: "question",
          sessionID,
          question: includeQuestionText ? (first.question ?? "") : "",
          header: first.header ?? "",
          options: optionLabels,
        })
      } catch (err) {
        debugLog("hook.question.error", String(err))
      }
    })

    const regPermission = await ctx.permission.hook("evaluate", (event) => {
      try {
        const hookEvent = event as unknown as PermissionHookEvent
        if (hookEvent.effect !== "ask") return
        const sessionID = hookEvent.sessionID ?? ""
        if (!sessionID || !isEnabled(sessionID)) return
        send({
          type: "permission",
          sessionID,
          action: hookEvent.action ?? "",
          resources: (hookEvent.resources ?? []).slice(0, 4),
        })
      } catch (err) {
        debugLog("hook.permission.error", String(err))
      }
    })

    // ---------------------------------------------------------------------------
    // Public event stream (duplicated across instances → filter by location).
    // ---------------------------------------------------------------------------
    const controller = new AbortController()
    void (async () => {
      try {
        for await (const raw of ctx.event.subscribe({ signal: controller.signal }) as AsyncIterable<StreamEvent>) {
          try {
            const eventLocation = raw.location?.directory
            if (eventLocation && here && eventLocation !== here) continue

            const type = raw.type ?? ""
            const data = raw.data ?? {}
            const sessionID = data.sessionID
            if (!sessionID) continue

            switch (type) {
              case "session.execution.started":
                turnStarted.set(sessionID, Date.now())
                break
              case "session.text.ended":
                if (typeof data.text === "string") lastAssistantText.set(sessionID, data.text)
                break
              case "session.execution.succeeded":
                void handleExecutionEnd(sessionID, "succeeded", raw.id)
                break
              case "session.execution.failed":
                void handleExecutionEnd(sessionID, "failed", raw.id)
                break
              case "session.execution.interrupted":
                // The user interrupted it themselves; nothing to report.
                turnStarted.delete(sessionID)
                lastAssistantText.delete(sessionID)
                break
              case "session.deleted":
              case "session.removed":
                if (disabled.has(sessionID)) {
                  disabled.delete(sessionID)
                  void persistState().catch(() => {})
                }
                break
              default:
                if (debug && /execution|^session\.error/.test(type)) debugLog("event.unhandled", raw)
            }
          } catch (err) {
            debugLog("event.handler.error", String(err))
          }
        }
      } catch (err) {
        if ((err as Error)?.name !== "AbortError") debugLog("event.stream.error", String(err))
      }
    })()

    // ---------------------------------------------------------------------------
    // RPC: lets the TUI (and anything else) toggle notifications per session.
    // ---------------------------------------------------------------------------
    const rpcRegistration = await ctx.rpc.register(NotifyRpc, {
      status: async (input) => {
        return { enabled: !disabled.has(input.sessionID) }
      },
      setEnabled: async (input) => {
        if (input.enabled) disabled.delete(input.sessionID)
        else disabled.add(input.sessionID)
        await persistState()
        debugLog("state.set", { sessionID: input.sessionID, enabled: input.enabled })
        return { enabled: !disabled.has(input.sessionID) }
      },
    })

    debugLog("plugin.setup", { location: here, url, hasToken: token.length > 0, minDurationSec })

    return () => {
      controller.abort()
      void regToolBefore.dispose()
      void regPermission.dispose()
      void rpcRegistration.dispose().catch(() => {})
    }
  },
})
