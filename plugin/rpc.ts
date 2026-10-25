/**
 * RPC contract shared between the server plugin (plugin/index.ts) and the
 * terminal plugin (plugin/tui.tsx).
 *
 * The server is the source of truth for which sessions have notifications
 * disabled. The TUI calls these methods so `/notify` works from any
 * terminal, even when several TUI instances are open.
 */
import { Rpc } from "@opencode/plugin/rpc"

export const NotifyRpc = Rpc.define({
  id: "notify-nodered",
  events: {},
  methods: {
    /** Read the notification state of a session (absent = enabled, the default). */
    status: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { enabled: { type: "boolean" } },
        required: ["enabled"],
        additionalProperties: false,
      },
    },
    /** Enable or disable notifications for one session. */
    setEnabled: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          enabled: { type: "boolean" },
        },
        required: ["sessionID", "enabled"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { enabled: { type: "boolean" } },
        required: ["enabled"],
        additionalProperties: false,
      },
    },
  },
})
