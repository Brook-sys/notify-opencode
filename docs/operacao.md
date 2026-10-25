# Guia de operação — opencode-notify-nodered

## Uso diário

- **`/notify`** dentro de uma sessão abre o seletor Ligado/Desligado (também na paleta de comandos: "Notificações: alternar desta sessão").
- **`/notify off`** / **`/notify on`** setam direto.
- O rodapé da sessão mostra 🔔 (ligadas) ou 🔔→🔕 (desligadas) para a sessão atual.
- Toda sessão nova **nasce com notificações ligadas** — desligar em uma não afeta as outras.

## Endpoints do Node-RED

| Endpoint | Uso |
|---|---|
| `POST /opencode/event` | webhook do plugin (header `x-webhook-token`) |
| `GET /opencode/events` | últimos 30 eventos processados (JSON) — checagem rápida |

Checagem de última hora:

```sh
curl -s http://SEU-NODE-RED:1880/opencode/events | head -c 800
```

## Diagnóstico

1. **Plugin carregou?**
   `opencode api get /api/plugin` → deve listar `notify-nodered`.
2. **Erros de carregamento?**
   `grep -i "failed to load plugin" ~/.local/share/opencode/log/opencode.log`
3. **O que o plugin enviou/pulou?**
   Debug log: `/tmp/opencode/notify-nodered-debug.jsonl` (ligado via `options.debug: true`). Registra `send.ok`, `send.http-error`, `send.error`, `done.skipped-not-owner`, `done.suppressed-subagent`, `state.set`.
4. **O Node-RED recebeu?**
   `GET /opencode/events` + painel Debug do editor (nó "Evento OpenCode").
5. **Teste com eventos falsos:** `node scripts/test-send-event.mjs`

## Eventos do OpenCode usados (verificados na v2.1.4)

| Fonte | Nome | Observação |
|---|---|---|
| stream | `session.execution.started` | marca início do turno (duração) |
| stream | `session.execution.succeeded` | **done**; sem campo `location` — dedupe via `ctx.session.get().location` |
| stream | `session.execution.failed` | **error**; por simetria com succeeded |
| stream | `session.execution.interrupted` | ignorado (usuário causou) |
| stream | `session.text.ended` | preview da última resposta |
| hook | `tool.execute.before` (`tool === "question"`) | pergunta + opções |
| hook | `permission.evaluate` (`effect === "ask"`) | ação + recursos aguardando aprovação |
| sessão | `parentID` | filhos de subagentes não geram "done" |

Por que a deduplicação existe: o plugin é instanciado **uma vez por location carregada** e cada instância recebe o stream inteiro. Só a instância "dona" da sessão envia (checagem via `session.get().location`), com um LRU de ids em `ctx.storage` (compartilhado entre instâncias) como segunda camada. Hooks disparam uma única vez por sessão.

## Trocar o token

1. Edite `plugins[].options.token` no `~/.config/opencode/opencode.jsonc` (recarrega a quente).
2. Reaplique o flow: `node scripts/apply-nodered-flow.mjs` (lê o token novo do config).

## Atualizar o flow / o plugin

- Flow: edite `nodered/flow.template.mjs` → `node scripts/apply-nodered-flow.mjs` (PUT idempotente na aba "OpenCode Notify").
- Plugin: edite `plugin/*.ts` → `opencode api post /api/location/reload`. Recarregamentos sucessivos podem deixar instâncias duplicadas por location (inofensivo — a dedupe cobre), mas um `opencode service restart` eventual consolida. **Atenção: o restart derruba as sessões em andamento — faça sem trabalho importante rodando.**

## Ativar um canal de notificação

A saída do nó **"Registra evento"** já traz tudo formatado:

- `msg.payload` → texto pronto ("✅ Título\nCorpo")
- `msg.headers` → `Title`, `Priority` (`4` urgente / `3` alta / `default`), `Tags: opencode`

**ntfy** (mais simples): habilite o nó placeholder, troque a URL por `https://ntfy.sh/<topico-aleatorio>` (o tópico é a "senha" — use uma string longa) ou self-hosted. Instale o app ntfy no celular e assine o tópico.

**Telegram**: instale `node-red-contrib-telegrambot` no Node-RED e ligue um nó `telegram` na saída (precisa de bot token do @BotFather + chat ID).

**Pushover**: nó `http request` POST para `https://api.pushover.net/1/messages.json` com `token` e `user` no payload.

## Segurança (pendências recomendadas)

- **Node-RED sem `adminAuth`**: qualquer dispositivo da rede privada abre o editor e edita tudo. Em `settings.js` do Node-RED, configure `adminAuth` com hash bcrypt (`.node-red/.config.nodes`? não — `node-red admin` / documentação oficial) e reinicie o Node-RED.
- O webhook já exige token (401 sem/errado), mas o tráfego na rede privada não é HTTP-auth além disso — o token é a única barreira do endpoint.
- Se for usar ntfy.sh público, lembre que o **conteúdo** (preview/pergunta) transita pelo serviço deles. Para sensível: self-host ntfy, ou `includeQuestionText/includePreview: false` nas options.
