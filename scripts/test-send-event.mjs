#!/usr/bin/env node
/**
 * Testa a ponta Node-RED da automação:
 *   1. envia eventos falsos (question/permission/done/error) com o token
 *   2. envia um evento com token inválido (deve dar 401)
 *   3. consulta GET /opencode/events e mostra o que foi processado
 *
 * Uso:
 *   node scripts/test-send-event.mjs [baseUrl]
 *
 * O token é lido de ~/.config/opencode/opencode.jsonc.
 */
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

function readPluginToken() {
  const configPath = join(homedir(), ".config", "opencode", "opencode.jsonc")
  const raw = readFileSync(configPath, "utf8")
  let config
  try {
    config = JSON.parse(raw)
  } catch {
    config = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ""))
  }
  const entry = (config.plugins ?? []).find(
    (plugin) => typeof plugin === "object" && String(plugin.package ?? "").includes("opencode-notify-nodered"),
  )
  return { token: entry?.options?.token, url: entry?.options?.url }
}

const { token, url: webhookUrl } = readPluginToken()
if (!token) {
  console.error("Token não encontrado em ~/.config/opencode/opencode.jsonc")
  process.exit(1)
}

// Mesma precedência do flow:apply — env NODE_RED_URL > argumento > origem
// de plugins[].options.url no opencode.jsonc > localhost.
const base = process.env.NODE_RED_URL ?? process.argv[2] ?? (webhookUrl ? new URL(webhookUrl).origin : "http://localhost:1880")

const send = async (payload, useToken) => {
  const res = await fetch(`${base}/opencode/event`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(useToken ? { "x-webhook-token": token } : { "x-webhook-token": "token-invalido" }),
    },
    body: JSON.stringify(payload),
  })
  return `${res.status} ${await res.text()}`
}

const now = Date.now()
const fakes = [
  { type: "question", sessionID: "ses_teste", header: "Teste", question: "Evento de teste — pergunta?", options: ["A", "B"], ts: now },
  { type: "permission", sessionID: "ses_teste", action: "bash", resources: ["rm -rf /tmp/teste"], ts: now },
  { type: "done", sessionID: "ses_teste", title: "sessão de teste", preview: "Resposta final de teste do turno.", durationSec: 42, ts: now },
  { type: "error", sessionID: "ses_teste", title: "sessão de teste", preview: "Erro simulado.", ts: now },
]

console.log("Enviando 4 eventos falsos (token válido)...")
for (const fake of fakes) console.log(" ", await send(fake, true))

console.log("Enviando evento com token inválido (esperado 401)...")
console.log(" ", await send({ type: "done", sessionID: "ses_teste" }, false))

console.log("Consultando GET /opencode/events ...")
const list = await fetch(`${base}/opencode/events`).then((res) => res.json())
console.log(`count: ${list.count}`)
for (const event of list.events.slice(0, 6)) {
  console.log(`  [${event.type}] ${event.title} :: ${String(event.text).slice(0, 60).replace(/\n/g, " | ")}`)
}
