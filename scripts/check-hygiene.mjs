#!/usr/bin/env node
/**
 * Varedura de higiene: o repositório é público — detalhes pessoais do
 * ambiente de quem desenvolve NÃO podem ser comitados.
 *
 * Escaneia apenas o que iria para o repositório: arquivos rastreados +
 * não-ignorados (`git ls-files --cached --others --exclude-standard`).
 * Notas locais (LOCAL.md, .env, *.log) são cobertas pelo .gitignore e
 * ficam fora da varredura **por design** — o alvo é o commit, não a
 * máquina de quem desenvolve.
 *
 * Reprova o commit se achar:
 *   - endereço IP em faixa privada de VPN/CGNAT (100.64.0.0/10);
 *   - caminho de home com usuário real (/home/<nome>);
 *   - ID de sessão real do OpenCode (ses_…);
 *   - menção a topologia de rede específica do autor.
 *
 * Roda no `npm test` (logo, no CI). Este arquivo é a única exceção da
 * varredura — ele precisa nomear os padrões para poder procurá-los.
 */
import { execSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { dirname, extname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, "..")
const self = fileURLToPath(import.meta.url)

const EXTENSIONS = new Set([".md", ".mjs", ".js", ".ts", ".tsx", ".json", ".yml", ".yaml", ".sh", ".txt"])

const PATTERNS = [
  // faixa CGNAT 100.64.0.0/10 (100.64–100.127) — endereços de VPN/overlay
  [/\b100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/, "IP em faixa privada de VPN (100.64.0.0/10)"],
  // caminho de home com usuário em minúsculas (SEU-USUARIO, em maiúsculas, escapa)
  [/\/home\/[a-z][a-z0-9_-]*/, "caminho de home com usuário real — use /home/SEU-USUARIO"],
  // topologia de rede específica do autor
  [/tailnet|tailscale/i, "menção a topologia de rede específica — descreva de forma genérica (rede privada/VPN)"],
  // IDs de sessão reais do OpenCode
  [/\bses_[A-Za-z0-9]{15,}/, "ID de sessão real (ses_…)"],
]

const candidates = execSync("git ls-files --cached --others --exclude-standard", {
  cwd: repoRoot,
  encoding: "utf8",
})
  .split("\n")
  .filter(Boolean)
  .map((rel) => join(repoRoot, rel))

const problems = []
for (const full of candidates) {
  if (full === self) continue
  if (!EXTENSIONS.has(extname(full))) continue
  const rel = full.replace(repoRoot + "/", "")
  const lines = readFileSync(full, "utf8").split("\n")
  lines.forEach((line, i) => {
    for (const [pattern, why] of PATTERNS) {
      if (pattern.test(line)) {
        problems.push(`${rel}:${i + 1} — ${why}\n      ↳ ${line.trim().slice(0, 100)}`)
      }
    }
  })
}

if (problems.length > 0) {
  console.error(`FAIL — ${problems.length} ocorrência(s) de detalhe pessoal/ambiental:\n`)
  for (const p of problems) console.error("  " + p + "\n")
  console.error("O repositório é público: use placeholders (SEU-NODE-RED, SEU-USUARIO).")
  console.error("Notas do SEU ambiente vão em LOCAL.md (está no .gitignore).")
  process.exit(1)
}
console.log("OK — higiene: nenhum detalhe pessoal/ambiental no repositório")
