# Guia de operação

Uso diário, diagnóstico e manutenção do `notify-opencode`.

- Arquitetura e decisões: [arquitetura.md](arquitetura.md)
- Verdade sobre eventos (v2.1.4): [eventos.md](eventos.md)
- Flow, canais e segurança Node-RED: [nodered.md](nodered.md)
- Ideias futuras: [ROADMAP.md](ROADMAP.md)
- Anotações do **seu** ambiente (endereços reais, máquina, procedimentos
  específicos): `LOCAL.md` na raiz do clone — está no `.gitignore` e não vai
  para o repositório público.

## Uso diário

- **Clique no 🔔/🔕 do rodapé** da sessão alterna as notificações dela — o
  ícone troca na hora e um toast confirma;
- **`/notify`** dentro de uma sessão abre o seletor Ligado/Desligado
  (também na paleta de comandos: *"Notificações: alternar desta sessão"*);
- **`/notify off`** / **`/notify on`** alternam direto, sem abrir o seletor;
- o rodapé da sessão mostra **🔔** (ligadas) ou **🔕** (desligadas);
- toda sessão nova **nasce com notificações ligadas** — desligar em uma não
  afeta as outras;
- sessões headless (sem TUI) ficam sempre ligadas, mas o toggle via RPC
  continua disponível para elas;
- os eventos viram **notificações no celular via ntfy** (✅ terminou, ❓
  pergunta, 🔐 permissão, ❗ erro), com prioridade e ícone por tipo. O tópico
  é o `options.ntfyTopic` do `opencode.jsonc` — o app ntfy no celular precisa
  assinar o **mesmo** tópico.

> Detalhe: se você alternar muito rápido (menos de ~2,5 s entre um clique e
> outro), só o primeiro toast aparece — o OpenCode não desenha um toast por
> cima de outro ainda visível. O ícone e o estado no servidor atualizam
> normalmente; é só o aviso que se perde.

### Checagem rápida (últimos eventos)

```sh
curl -s http://SEU-NODE-RED:1880/opencode/events | head -c 800
```

Do lado do celular (o que o ntfy de fato recebeu) — uma linha JSON por
mensagem entregue:

```sh
curl -s "https://ntfy.sh/SEU-TOPICO/json?poll=1&since=5m"
```

## Diagnóstico (na ordem)

1. **Plugin carregado?**
   ```sh
   opencode api get /api/plugin | grep -c notify-nodered   # 1 (por location)
   ```
2. **Erros de carregamento?**
   ```sh
   grep -i "failed to load plugin" ~/.local/share/opencode/log/opencode.log
   ```
3. **O que o plugin enviou/pulou?** Ligue `options.debug: true` e acompanhe o
   `debugLogPath` (default `/tmp/opencode/notify-nodered-debug.jsonl`):
   `send.ok` · `send.http-error` · `send.error` · `done.skipped-not-owner` ·
   `done.suppressed-subagent` · `done.filtered` · `state.set` · `event.unhandled`;
4. **O Node-RED recebeu?** `GET /opencode/events` + painel Debug do editor
   (nó "Evento OpenCode");
5. **Teste com eventos falsos** (não depende do OpenCode):
   ```sh
   npm run flow:test
   ```

### Diagnóstico do resumo por IA (`summary: "llm"`)

As entradas do debug log específicas do resumo:

| Entrada | Significado |
|---|---|
| `summary.heuristic` | Texto curto — limpeza determinística, **nenhuma** chamada ao modelo |
| `summary.generate.start` | Requisição stateless ao modelo iniciada (modelo, tamanho do prompt) |
| `summary.generate.ok` | O modelo respondeu (latência, tamanho da resposta) |
| `summary.generate.error` | O modelo recusou/errou (ex.: `Model not found: …`, erro do provider) |
| `summary.model-failed` | A tentativa falhou — passa para o próximo candidato (no máximo 2) |
| `summary.llm` | Resumo aceito e usado como corpo da notificação |
| `summary.fallback` | Todos os candidatos falharam — o corpo é o texto limpo, cortado |

```sh
grep '"kind":"summary' /tmp/opencode/notify-nodered-debug.jsonl | tail -20
```

Truques de leitura:

- **`summary.generate.ok` depois de `summary.model-failed`** = a requisição
  **não foi cancelada**: ela continuou viva no provider depois do timeout
  (a cota foi consumida mesmo assim). É o comportamento conhecido do
  `Promise.race`;
- **latência alta no `summary.generate.ok`** = o provider está lento ou
  disputando fila com o agente. Um `summaryModel` diferente do modelo do
  agente resolve;
- **`summary.model-failed` com `Model not found`** = `summaryModel` inválido.
  O plugin tenta o modelo da sessão em seguida — se ele falhar também, o
  fallback assume;
- **`summary.fallback` com `timeout after Nms`** = o modelo não respondeu
  dentro de `summaryTimeoutSec`. Aumente o timeout ou reduza
  `summaryMaxInputChars`.

## Troubleshooting

| Sintoma | Causa provável | Correção |
|---|---|---|
| Nada chega ao Node-RED | Plugin sem `token`/`url` nas options, ou falha de load | Passos 1–3 acima; confira o JSON do `opencode.jsonc` |
| 401 no debug (`send.http-error`) | Token divergente entre plugin e flow | Troque o token (abaixo) nos dois lados |
| `done` chega duplicado | Instâncias duplicadas por location (reload empilhado) + ownership falhou por `session.get` com erro | Confira `done.skipped-not-owner` no debug; consolide com `opencode service restart` (fora de horário de trabalho) |
| `question` não notifica | Toggle desligado ou tool diferente de `question` | `/notify` na sessão; debug `hook.question.error` |
| `permission` nunca notifica | **Sem regras `ask`** — a política base V2 é `allow` para tudo | Adicione regra `ask` no `opencode.jsonc` (abaixo) |
| Nada chega no celular (mas chega no Node-RED) | Tópico divergente entre `options.ntfyTopic` e a assinatura do app, ou ntfy.sh fora do ar | Confira o tópico dos dois lados; cheque com o `curl` do tópico acima; reimplante com `npm run flow:apply` |
| Notificação some quando o Node-RED reinicia | Buffer de eventos é volátil (context em memória) | Comportamento esperado; buffer persistente está no [roadmap](ROADMAP.md) |
| Evento perdido com Node-RED fora | Sem retry no envio (v0.1) | Debug log tem o registro; fila/retry é item do [roadmap](ROADMAP.md) |
| Notificação demora muito para chegar (com `summary: "llm"`) | O resumo espera o modelo (4,8 s a >60 s medidos) | Baixe `summaryTimeoutSec` (o fallback assume), reduza `summaryMaxInputChars` ou use um `summaryModel` mais rápido/diferente do agente |
| `summarySource` sempre `fallback` | Modelo indisponível, sem cota ou timeout | `grep '"kind":"summary' no debug log` — o erro exato vem em `summary.generate.error` |
| Corpo da notificação parece "cortado" e não resumido | Fallback determinístico em ação (o texto é limpo e cortado em frase) | Normal quando o modelo falha; com `summary: "off"` isso é sempre o comportamento |

## Fazendo o `permission` disparar (exemplo)

Por padrão a V2 permite tudo — o gatilho só existe com regras `ask`. Exemplo
real usado nos testes:

```jsonc
{
  "permissions": [
    { "action": "shell", "resource": "*", "effect": "ask" },
    { "action": "shell", "resource": "git status *", "effect": "allow" },
    { "action": "shell", "resource": "git diff *", "effect": "allow" }
  ]
}
```

Com uma permissão pendente, dá para **aprovar/rejeitar via API** (base do
recurso "responder do celular" do roadmap):

```sh
# pendentes
opencode api get /api/session/SEU_SESSAO/permission
# aprovar uma vez
opencode api post /api/session/SEU_SESSAO/permission/PERM_ID/reply --data '{"decision":"once"}'
# decisões: once | always | reject
```

## Trocar o token

1. Edite `plugins[].options.token` no `~/.config/opencode/opencode.jsonc`
   (recarrega a quente);
2. Reaplique o flow: `npm run flow:apply` (lê o token novo do config).

O token é a única barreira do endpoint — não o comite e o rotacione se
suspeitar de vazamento.

## Atualizar plugin e flow

- **Plugin**: edite `plugin/*.ts` → `opencode api post /api/location/reload`.
  Recarregamentos sucessivos podem empilhar instâncias duplicadas por
  location (inofensivo — a dedupe cobre), mas um `opencode service restart`
  eventual consolida. **Atenção: o restart derruba as sessões em andamento** —
  faça sem trabalho importante rodando.
- **Flow**: edite `nodered/flow.template.mjs` → `npm run flow:apply`
  (idempotente: acha a aba pelo label e faz PUT). Commit o template e o
  `flow.json` regenerado juntos.
- **TUI**: mudanças em `tui.tsx` exigem **reiniciar o terminal** (a TUI carrega
  plugins de UI na abertura).

## Segurança (pendências recomendadas)

- **Node-RED sem `adminAuth`**: qualquer dispositivo que alcance o editor
  pode editar todos os flows. Configure `adminAuth` (hash bcrypt) no
  `settings.js` da máquina do Node-RED e reinicie o serviço — não dá para
  fazer via API;
- o webhook já exige token (401 sem/errado), mas o tráfego plugin → Node-RED
  pode ser HTTP simples na sua rede — o token é a única barreira do endpoint;
- ntfy.sh público = o **conteúdo** (preview/pergunta) transita pelo serviço
  deles. Conteúdo sensível → ntfy self-hosted ou
  `includeQuestionText/includePreview: false` nas options.
