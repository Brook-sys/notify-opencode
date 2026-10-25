/**
 * Smoke-test plugin: logs the public event stream, tool hooks and permission
 * hooks to a JSONL file so we can discover the exact event type names and
 * payload shapes emitted by the running OpenCode version.
 *
 * This plugin is intentionally tiny and defensive: it must never throw or
 * block a session (it runs inside the shared background service).
 */
import { Plugin } from "@opencode/plugin"
import { appendFileSync } from "node:fs"

type AnyEvent = { type?: string; [key: string]: unknown }

// Module-level state: if this counter accumulates across setup() calls from
// different locations, the module instance is shared inside the server process.
let moduleInstances = 0

export default Plugin.define({
  id: "smoke-log",
  async setup(ctx) {
    moduleInstances += 1
    const options = (ctx.options ?? {}) as { logPath?: string }
    const logPath = options.logPath ?? "/tmp/opencode/notify-smoke-events.jsonl"

    const log = (kind: string, data: unknown) => {
      try {
        let body: string
        try {
          body = JSON.stringify(data)
        } catch {
          body = String(data)
        }
        if (body.length > 4000) body = body.slice(0, 4000) + "…[truncated]"
        appendFileSync(logPath, JSON.stringify({ t: new Date().toISOString(), kind, data: body }) + "\n")
      } catch (err) {
        console.error("[smoke-log] write failed", err)
      }
    }

    let storageCount = 0
    try {
      const stored = (await ctx.storage.get("setupCount")) as { n?: number } | undefined
      storageCount = (stored?.n ?? 0) + 1
      await ctx.storage.set("setupCount", { n: storageCount })
    } catch (err) {
      log("storage.error", String(err))
    }

    log("plugin.setup", { moduleInstances, storageCount, location: ctx.location })

    // Ground truth for tool names (e.g. the question tool).
    try {
      const tools = await ctx.tool.list()
      log("tool.list", tools.map((tool) => tool.id))
    } catch (err) {
      log("tool.list.error", String(err))
    }

    const seenSessions = new Set<string>()
    const maybeLogSession = async (raw: AnyEvent | AnyEvent["properties"]) => {
      const event = (raw ?? {}) as AnyEvent
      const sessionID = (event.sessionID ?? (event.properties as AnyEvent | undefined)?.sessionID) as string | undefined
      if (typeof sessionID !== "string" || sessionID.length === 0 || seenSessions.has(sessionID)) return
      seenSessions.add(sessionID)
      try {
        const session = await ctx.session.get({ sessionID })
        log("session.info", { sessionID, info: session })
      } catch (err) {
        log("session.info.error", { sessionID, error: String(err) })
      }
    }

    // Hooks: stable, documented API.
    const regToolBefore = await ctx.tool.hook("execute.before", (event) => {
      log("hook.tool.execute.before", event)
    })
    const regToolAfter = await ctx.tool.hook("execute.after", (event) => {
      log("hook.tool.execute.after", event)
    })
    const regPermission = await ctx.permission.hook("evaluate", (event) => {
      log("hook.permission.evaluate", event)
    })

    // Public event stream: discover exact type names.
    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal }) as AsyncIterable<AnyEvent>) {
          log("event", event)
          void maybeLogSession(event)
          void maybeLogSession((event as AnyEvent).properties as AnyEvent)
        }
      } catch (err) {
        if ((err as Error)?.name !== "AbortError") log("event.stream.error", String(err))
      }
    })()

    return () => {
      controller.abort()
      void regToolBefore.dispose()
      void regToolAfter.dispose()
      void regPermission.dispose()
    }
  },
})
