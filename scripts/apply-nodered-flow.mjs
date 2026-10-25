#!/usr/bin/env node
/**
 * Aplica o flow "OpenCode Notify" no Node-RED (cria a aba ou atualiza, se já existir).
 *
 * Uso:
 *   node scripts/apply-nodered-flow.mjs [baseUrl]
 *
 * baseUrl padrão: http://SEU-NODE-RED:1880
 *
 * O token do webhook é lido de ~/.config/opencode/opencode.jsonc
 * (plugins[].options.token) e substituído no template antes do deploy —
 * assim o token não vira commit no repositório.
 *
 * Também (re)escreve nodered/flow.json com o placeholder, para importação
 * manual via editor (Menu → Import), caso prefira fazer na mão.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { flowNodes, TAB_ID } from "../nodered/flow.template.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, "..")

const base = process.env.NODE_RED_URL ?? process.argv[2] ?? "http://SEU-NODE-RED:1880"

function readPluginToken() {
  const configPath = join(homedir(), ".config", "opencode", "opencode.jsonc")
  const raw = readFileSync(configPath, "utf8")
  let config
  try {
    config = JSON.parse(raw)
  } catch {
    // Fallback: remove comentários de linha antes de parsear
    config = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ""))
  }
  const entry = (config.plugins ?? []).find(
    (plugin) => typeof plugin === "object" && String(plugin.package ?? "").includes("opencode-notify-nodered"),
  )
  return entry?.options?.token
}

const token = readPluginToken()
if (!token) {
  console.error("Token não encontrado em ~/.config/opencode/opencode.jsonc (plugins[].options.token)")
  process.exit(1)
}

const tab = flowNodes.find((node) => node.type === "tab")
const nodes = flowNodes.filter((node) => node.type !== "tab")
if (!tab || tab.id !== TAB_ID) {
  console.error("Template inválido: aba não encontrada")
  process.exit(1)
}

// 1) Exporta nodered/flow.json (com placeholder) para importação manual
writeFileSync(join(repoRoot, "nodered", "flow.json"), JSON.stringify(flowNodes, null, 1) + "\n")
console.log("nodered/flow.json atualizado (placeholder de token, seguro para commit)")

// 2) Prepara o corpo do deploy com o token real
const deployBody = {
  id: TAB_ID,
  label: tab.label,
  nodes: nodes.map((node) => ({ ...node, func: node.func ? node.func.replace("__OC_WEBHOOK_TOKEN__", token) : node.func })),
  configs: [],
}

// 3) Cria ou atualiza a aba no Node-RED
const existing = await fetch(`${base}/flows`).then((res) => {
  if (!res.ok) throw new Error(`GET /flows falhou: ${res.status}`)
  return res.json()
})
const alreadyThere = existing.find(
  (node) => node.type === "tab" && (node.id === TAB_ID || node.label === tab.label),
)
const existingTabId = alreadyThere?.id

const res = await fetch(existingTabId ? `${base}/flow/${existingTabId}` : `${base}/flow`, {
  method: existingTabId ? "PUT" : "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(existingTabId ? { ...deployBody, id: existingTabId } : deployBody),
})
const resText = await res.text()
console.log(`${existingTabId ? "PUT" : "POST"} /flow → ${res.status} ${resText}`)
if (!res.ok) process.exit(1)
console.log(`\nFlow aplicado: ${base}/opencode/event (POST) e ${base}/opencode/events (GET)`)
