#!/usr/bin/env node
/**
 * Validação estrutural do template do flow Node-RED.
 *
 * Roda sem rede e sem Node-RED — é o `npm test` do repositório e o passo do CI.
 * Verifica:
 *   - exatamente uma aba, com id igual a TAB_ID;
 *   - ids de nó únicos e todos os `wires` apontando para nós existentes;
 *   - os dois endpoints esperados (POST /opencode/event, GET /opencode/events);
 *   - o placeholder __OC_WEBHOOK_TOKEN__ presente (exatamente 1×) e nenhum
 *     token real (hex de 48 chars) esquecido no template;
 *   - o nó ntfy placeholder presente e DESABILITADO;
 *   - nodered/flow.json (artefato gerado) em sincronia com o template.
 */
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { flowNodes, TAB_ID } from "../nodered/flow.template.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const errors = []
const ok = (cond, msg) => {
  if (!cond) errors.push(msg)
}

// --- aba -------------------------------------------------------------------
const tabs = flowNodes.filter((node) => node.type === "tab")
ok(tabs.length === 1, `esperava exatamente 1 aba, encontrei ${tabs.length}`)
ok(tabs[0]?.id === TAB_ID, `id da aba (${tabs[0]?.id}) diverge de TAB_ID (${TAB_ID})`)

// --- ids e wires -------------------------------------------------------------
const byId = new Map(flowNodes.map((node) => [node.id, node]))
ok(byId.size === flowNodes.length, "existem ids de nó duplicados")
for (const node of flowNodes) {
  for (const wires of node.wires ?? []) {
    for (const target of wires) {
      ok(byId.has(target), `nó ${node.id} aponta para nó inexistente: ${target}`)
    }
  }
}

// --- endpoints ---------------------------------------------------------------
const httpIn = flowNodes.filter((node) => node.type === "http in")
ok(
  httpIn.some((node) => node.url === "/opencode/event" && node.method === "post"),
  "falta o endpoint POST /opencode/event",
)
ok(
  httpIn.some((node) => node.url === "/opencode/events" && node.method === "get"),
  "falta o endpoint GET /opencode/events",
)

// --- segredos ----------------------------------------------------------------
const validateFunc = flowNodes.find((node) => /valida token/i.test(node.name ?? ""))?.func ?? ""
const placeholderCount = (validateFunc.match(/__OC_WEBHOOK_TOKEN__/g) ?? []).length
ok(placeholderCount === 1, `placeholder __OC_WEBHOOK_TOKEN__ deve aparecer 1× na validação (achei ${placeholderCount})`)
ok(
  !/[0-9a-f]{48}/i.test(JSON.stringify(flowNodes)),
  "possível token real (hex de 48 caracteres) encontrado no template — NÃO comitar segredos!",
)

// --- nó de canal placeholder --------------------------------------------------
const ntfy = flowNodes.find((node) => node.type === "http request" && /ntfy/i.test(String(node.url ?? "")))
ok(!!ntfy, "nó ntfy placeholder ausente (saída de canal do flow)")
ok(ntfy?.disabled === true, "o nó ntfy placeholder deve vir desabilitado por padrão")
ok(
  String(ntfy?.url ?? "").includes("TROQUE-ESTE-TOPICO"),
  "a URL do nó ntfy deve continuar placeholder (TROQUE-ESTE-TOPICO…)",
)

// --- corpos de função ---------------------------------------------------------
for (const node of flowNodes.filter((node) => node.type === "function")) {
  ok(typeof node.func === "string" && node.func.trim().length > 0, `nó function ${node.id} (${node.name}) sem corpo`)
}

// --- flow.json em sincronia com o template ------------------------------------
const flowJsonPath = join(here, "..", "nodered", "flow.json")
const expected = JSON.stringify(flowNodes, null, 1) + "\n"
let flowJsonRaw = ""
try {
  flowJsonRaw = readFileSync(flowJsonPath, "utf8")
} catch {
  // arquivo gerado ausente — flow:apply cria; não falha o CI
}
if (flowJsonRaw) {
  ok(flowJsonRaw === expected, "nodered/flow.json está dessincronizado do template — rode `npm run flow:apply`")
}

// --- resultado -----------------------------------------------------------------
if (errors.length > 0) {
  console.error(`FAIL — ${errors.length} problema(s):`)
  for (const error of errors) console.error("  -", error)
  process.exit(1)
}
console.log(
  `OK — flow válido: ${flowNodes.length} nós, aba "${tabs[0].label}", endpoints e placeholders íntegros${
    flowJsonRaw ? ", flow.json sincronizado" : ""
  }`,
)
