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
import { cleanText, fallbackText, summarize } from "./summary.mjs"

type Options = {
  url?: string
  token?: string
  minDurationSec?: number
  includePreview?: boolean
  includeQuestionText?: boolean
  debug?: boolean
  debugLogPath?: string
  /**
   * "off" (default) = corpo da notificação vem do texto limpo (sem IA).
   * "llm"           = uma requisição extra ao modelo gera o resumo.
   */
  summary?: "off" | "llm"
  /** Modelo do resumo: "provider/model" ou { providerID, id }. */
  summaryModel?: string | { providerID?: string; id?: string; modelID?: string }
  summaryTimeoutSec?: number
  summaryMaxChars?: number
  summaryMinSourceChars?: number
  summaryMaxInputChars?: number
  summaryLanguage?: string
}

type ModelRef = { providerID: string; id: string }

type State = { disabled?: Record<string, boolean> }

type StreamEvent = {
  id?: string
  type?: string
  location?: { directory?: string }
  data?: {
    sessionID?: string
    text?: string
    reason?: string
    error?: { type?: string; message?: string }
  }
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
  model?: { providerID?: string; id?: string; modelID?: string }
}

const clampInt = (value: unknown, fallback: number, min: number, max: number) => {
  const num = Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.min(max, Math.max(min, Math.round(num)))
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
    const summaryMode = options.summary === "llm" ? "llm" : "off"
    const summaryConfig = {
      maxChars: clampInt(options.summaryMaxChars, 240, 40, 1000),
      minSourceChars: clampInt(options.summaryMinSourceChars, 200, 0, 100000),
      // Medido: prompt de ~1k chars → 14,6 s; prompt de ~2k chars → mais.
      // 2000 é o ponto em que o resumo ainda captura o essencial (o corte
      // prefer="end" mantém a conclusão) sem inflar a latência.
      maxInputChars: clampInt(options.summaryMaxInputChars, 2000, 200, 100000),
      language:
        typeof options.summaryLanguage === "string" && options.summaryLanguage.trim()
          ? options.summaryLanguage.trim()
          : "pt-BR",
    }
    // Deadline único para as tentativas de resumo. Medido neste ambiente:
    // 5–15 s por chamada com provider livre, até >60 s sob carga (o mesmo
    // provider rotativo serve o agente e o resumo). 30 s cobre o caso comum
    // sem deixar a notificação pendurada por muito tempo; o fallback
    // determinístico garante que ela sai mesmo assim.
    const summaryTimeoutMs = clampInt(options.summaryTimeoutSec, 30, 1, 600) * 1000
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
    const lastErrorText = new Map<string, string>()

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

    // ---------------------------------------------------------------------------
    // Summary (Camada 2 — one extra request to the model).
    //
    // The request goes through `ctx.experimental.generate.text` (falling back
    // to the deprecated `ctx.generate.text` on older runtimes). It is
    // stateless: no session is created, no tools are available and nothing is
    // written to the session history. That makes a notification loop
    // structurally impossible (there is no session to emit session.execution.*
    // from).
    //
    // Failure modes are all handled by the deterministic fallback (clean text
    // cut at a sentence boundary), so the notification always goes out.
    // ---------------------------------------------------------------------------
    const parseModelRef = (value: unknown): ModelRef | undefined => {
      if (!value) return undefined
      if (typeof value === "object") {
        const obj = value as { providerID?: string; id?: string; modelID?: string; ref?: unknown }
        if (obj.ref) return parseModelRef(obj.ref)
        const id = obj.id ?? obj.modelID
        return obj.providerID && id ? { providerID: obj.providerID, id } : undefined
      }
      if (typeof value === "string") {
        const slash = value.indexOf("/")
        if (slash <= 0 || slash === value.length - 1) return undefined
        return { providerID: value.slice(0, slash), id: value.slice(slash + 1) }
      }
      return undefined
    }

    /** Candidate models, in order: explicit option → session model → default. */
    const modelCandidates = async (sessionID: string): Promise<ModelRef[]> => {
      const candidates: ModelRef[] = []
      const push = (model: ModelRef | undefined) => {
        if (!model) return
        if (candidates.some((m) => m.providerID === model.providerID && m.id === model.id)) return
        candidates.push(model)
      }
      push(parseModelRef(options.summaryModel))
      const meta = await sessionMeta(sessionID)
      push(parseModelRef(meta.model))
      try {
        // ctx.model.default() returns { data: ModelInfo | null }.
        const defaultModel = (await ctx.model.default()) as unknown as { data?: unknown }
        push(parseModelRef(defaultModel?.data ?? defaultModel))
      } catch {
        /* default model unavailable — previous candidates still apply */
      }
      return candidates
    }

    /**
     * Stateless text generation. `ctx.experimental.generate.text` is the
     * current API; `ctx.generate.text` is kept as a fallback for older
     * runtimes (both hit the same /experimental/generate endpoint).
     */
    const generateText = async (model: ModelRef, prompt: string): Promise<{ text: string }> => {
      const experimental = (ctx as unknown as {
        experimental?: { generate?: { text?: (input: { prompt: string; model: unknown }) => Promise<{ text: string }> } }
      }).experimental
      const fn = experimental?.generate?.text
      const started = Date.now()
      const via = typeof fn === "function" ? "experimental" : "legacy"
      debugLog("summary.generate.start", { model, via, promptChars: prompt.length })
      try {
        const out = typeof fn === "function"
          ? await fn.call(experimental!.generate, { prompt, model })
          : await ctx.generate.text({ prompt, model })
        // Log tardio: se o deadline estourou, esta linha aparece depois do
        // timeout — prova de que a requisição continuou viva no servidor.
        debugLog("summary.generate.ok", { model, via, latencyMs: Date.now() - started, outputChars: out?.text?.length ?? 0 })
        return out
      } catch (err) {
        debugLog("summary.generate.error", {
          model,
          via,
          latencyMs: Date.now() - started,
          error: err instanceof Error ? err.message : String(err),
          errorName: err instanceof Error ? err.name : typeof err,
        })
        throw err
      }
    }

    const deterministicSummary = (kind: string, source: string) => {
      const cleaned = cleanText(source)
      if (!cleaned) return { text: "", source: "none" as const }
      const text = fallbackText(cleaned, kind, summaryConfig.maxChars)
      return { text, source: "heuristic" as const }
    }

    /**
     * Summary of the notification body.
     *
     * summary = "off" → deterministic cleanup only (no model call).
     * summary = "llm" → one extra request; on error/timeout/empty response the
     * deterministic cleanup is used instead (fallback is mandatory).
     */
    const summarizeText = async (
      kind: "done" | "error" | "question" | "permission",
      source: string,
      sessionID: string,
    ): Promise<{ text: string; source: string; latencyMs?: number; error?: string }> => {
      const cleaned = cleanText(source)
      if (!cleaned) return { text: "", source: "none" }

      if (summaryMode !== "llm") return deterministicSummary(kind, cleaned)

      const candidates = await modelCandidates(sessionID)
      const deadline = Date.now() + summaryTimeoutMs
      let lastError = ""

      for (const model of candidates.slice(0, 2)) {
        const remaining = deadline - Date.now()
        if (remaining <= 0) break
        const result = await summarize({
          kind,
          source: cleaned,
          config: summaryConfig,
          timeoutMs: remaining,
          generate: ({ prompt }) => generateText(model, prompt),
        })
        if (result.source === "llm") {
          debugLog("summary.llm", {
            kind,
            sessionID,
            model,
            latencyMs: result.latencyMs,
            inputChars: result.inputChars,
            outputChars: result.outputChars,
          })
          return { text: result.text, source: "llm", latencyMs: result.latencyMs }
        }
        // Texto curto (abaixo de summaryMinSourceChars) não chega ao modelo:
        // a heurística determinística já é a resposta — não é falha.
        if (result.source === "heuristic" || result.source === "none") {
          debugLog("summary.heuristic", {
            kind,
            sessionID,
            inputChars: result.inputChars,
            outputChars: result.outputChars,
          })
          return { text: result.text, source: result.source, latencyMs: result.latencyMs }
        }
        lastError = result.error ?? ""
        debugLog("summary.model-failed", {
          kind,
          sessionID,
          model,
          error: lastError,
          errorName: result.errorName,
          errorStack: result.errorStack ? result.errorStack.slice(0, 600) : undefined,
          latencyMs: result.latencyMs,
        })
      }

      const fallback = deterministicSummary(kind, cleaned)
      debugLog("summary.fallback", { kind, sessionID, error: lastError, outputChars: fallback.text.length })
      return { text: fallback.text, source: "fallback", error: lastError }
    }

    /**
     * Per-session FIFO: two events of the same turn must not arrive out of
     * order just because one summary took longer than the next one.
     */
    const chains = new Map<string, Promise<void>>()
    const enqueue = (sessionID: string, task: () => Promise<void>) => {
      const previous = chains.get(sessionID) ?? Promise.resolve()
      const next = previous.then(task, task).catch(() => {})
      chains.set(sessionID, next)
      void next.finally(() => {
        if (chains.get(sessionID) === next) chains.delete(sessionID)
      })
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
      const assistantText = lastAssistantText.get(sessionID) ?? ""
      const errorText = lastErrorText.get(sessionID) ?? ""
      lastAssistantText.delete(sessionID)
      lastErrorText.delete(sessionID)
      // includePreview gates the assistant text; the error message is the
      // diagnostic of the failure and is always worth reporting.
      const source =
        outcome === "failed"
          ? errorText || (includePreview ? assistantText : "")
          : includePreview
            ? assistantText
            : ""

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

      // The summary is resolved INSIDE the queue: the FIFO order must follow
      // the order of the events, not the order in which the summaries happen
      // to be ready (a slow summary must not let a later event overtake it).
      enqueue(sessionID, async () => {
        const base = {
          type: outcome === "succeeded" ? "done" : "error",
          sessionID,
          title: meta.title,
          durationSec: started !== undefined ? Math.round((Date.now() - started) / 1000) : undefined,
        }
        // summary = "off" (default): the payload is exactly what it always
        // was — no new fields, no change of semantics for existing consumers.
        if (summaryMode !== "llm") {
          send({ ...base, preview: source.slice(0, 280) })
          return
        }
        const summary = await summarizeText(outcome === "failed" ? "error" : "done", source, sessionID)
        send({
          ...base,
          preview: summary.text,
          summary: summary.text,
          summarySource: summary.source,
        })
      })
    }

    // ---------------------------------------------------------------------------
    // Hooks (documented, run once per session).
    // ---------------------------------------------------------------------------
    const regToolBefore = await ctx.tool.hook("execute.before", async (event) => {
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

        const questionText = includeQuestionText ? (first.question ?? "") : ""
        const payload = {
          type: "question",
          sessionID,
          question: questionText,
          header: first.header ?? "",
          options: optionLabels,
        }

        // This hook is on the agent's critical path: the summary request must
        // NOT be awaited here (it would freeze the question for seconds).
        // The notification goes out when the summary arrives.
        void enqueue(sessionID, async () => {
          if (summaryMode !== "llm") {
            send(payload)
            return
          }
          const summary = await summarizeText("question", questionText, sessionID)
          if (!isEnabled(sessionID)) return
          send({ ...payload, summary: summary.text, summarySource: summary.source })
        })
      } catch (err) {
        debugLog("hook.question.error", String(err))
      }
    })

    const regPermission = await ctx.permission.hook("evaluate", async (event) => {
      try {
        const hookEvent = event as unknown as PermissionHookEvent
        if (hookEvent.effect !== "ask") return
        const sessionID = hookEvent.sessionID ?? ""
        if (!sessionID || !isEnabled(sessionID)) return

        const resources = (hookEvent.resources ?? []).slice(0, 4)
        const action = hookEvent.action ?? ""
        const payload = {
          type: "permission",
          sessionID,
          action,
          resources,
        }
        const source = [action, ...resources].filter(Boolean).join(" — ")

        // Same rule as the question hook: never block the agent on the model.
        void enqueue(sessionID, async () => {
          if (summaryMode !== "llm") {
            send(payload)
            return
          }
          const summary = await summarizeText("permission", source, sessionID)
          if (!isEnabled(sessionID)) return
          send({ ...payload, summary: summary.text, summarySource: summary.source })
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
                if (typeof data.error?.message === "string") lastErrorText.set(sessionID, data.error.message)
                void handleExecutionEnd(sessionID, "failed", raw.id)
                break
              case "session.execution.interrupted":
                // The user interrupted it themselves; nothing to report.
                turnStarted.delete(sessionID)
                lastAssistantText.delete(sessionID)
                lastErrorText.delete(sessionID)
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
