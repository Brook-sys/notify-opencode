# Guia Node-RED

O flow "OpenCode Notify" é a ponte entre o plugin e o seu canal de
notificação. Este guia cobre o flow, os endpoints, o schema das mensagens,
como plugar cada canal e o que cuidar em segurança.

## Deploy

```sh
npm run flow:apply            # lê o token do opencode.jsonc e aplica via API
NODE_RED_URL=http://host:1880 npm run flow:apply   # outro host
```

O deploy é **idempotente**: a aba é localizada pelo *label* ("OpenCode
Notify") e atualizada via `PUT /flow/{id}` — rodar duas vezes não duplica nada.
O token real é injetado na hora (`__OC_WEBHOOK_TOKEN__` → valor do
`opencode.jsonc`) e **nunca vai para o repositório**.

Alternativa manual: `nodered/flow.json` (gerado, com placeholder) → editor →
Menu → Import → substituir o placeholder pelo token real.

## Endpoints

| Endpoint | Método | Papel |
|---|---|---|
| `/opencode/event` | POST | Webhook do plugin — valida `x-webhook-token`, formata, registra |
| `/opencode/events` | GET | Últimos 30 eventos processados (JSON) — checagem rápida |

```sh
curl -s http://SEU-NODE-RED:1880/opencode/events | head -c 800
```

## O flow, nó a nó

| Nó | O que faz |
|---|---|
| `POST /opencode/event` | Entrada do webhook |
| `Valida token + formata` | 401 se o header `x-webhook-token` não bater; monta `msg.notify` com prioridade/ícone/título/texto; saída 1 = resposta 200, saída 2 = lane de notificação |
| `Resposta` | Devolve `{"ok":true}` ao plugin |
| `Tipo de evento` | Switch por `msg.notify.type` (question/permission/done/error) — pronto para rotear tipos por canais diferentes |
| `Registra evento` | Guarda no buffer (flow context, últimos 30) e monta `msg.payload` + `msg.headers` prontos para canal |
| `Evento OpenCode` (debug) | Mostra `msg.notify` no painel Debug do editor |
| `CANAL ntfy (placeholder)` | Nó `http request` **desabilitado** — troque a URL pelo seu tópico e habilite |
| `GET /opencode/events` + `Lista últimos eventos` | Consulta do buffer |

## `msg.notify` (schema interno)

```jsonc
{
  "type": "done",              // question | permission | done | error
  "priority": "normal",        // high (question/permission) | normal (done) | urgent (error)
  "sessionID": "ses_…",
  "project": "/home/SEU-USUARIO",   // location de origem (campo `from` do payload)
  "ts": 1792905769912,
  "title": "✅ sessão de trabalho",
  "text": "Resposta final do turno…\n(42s)",
  "raw": { /* payload original do plugin */ }
}
```

Na saída de **Registra evento**, o canal recebe:

- `msg.payload` → `"✅ título\ncorpo"` (texto pronto);
- `msg.headers` → `Title` (título), `Priority` (`4` urgente, `3` alta,
  `default`), `Tags: opencode` — formato **ntfy** de cara.

## Exemplos de payload (o que chega no webhook)

```jsonc
// done
{ "type": "done", "sessionID": "ses_…", "title": "refatorar auth", "preview": "PR aberto.", "durationSec": 214, "from": "/home/SEU-USUARIO", "ts": 1792905769912 }

// question
{ "type": "question", "sessionID": "ses_…", "question": "Qual banco usar?", "header": "Banco", "options": ["Postgres", "SQLite"], "from": "…", "ts": … }

// permission
{ "type": "permission", "sessionID": "ses_…", "action": "shell", "resources": ["rm -rf build"], "from": "…", "ts": … }

// error
{ "type": "error", "sessionID": "ses_…", "title": "refatorar auth", "preview": "…", "from": "…", "ts": … }
```

## Plugar um canal

### ntfy (o mais simples)

1. Instale o app ntfy no celular;
2. No flow, habilite o nó **"CANAL ntfy (placeholder — ativar quando decidir)"**
   e troque a URL: `https://ntfy.sh/<topico-bem-aleatorio>` (o tópico é a
   "senha") ou o seu ntfy self-hosted;
3. Assine o tópico no app. Pronto — `msg.headers` já está no formato ntfy
   (`Title`, `Priority`, `Tags`).

> Conteúdo sensível? Prefira ntfy self-hosted: com o ntfy.sh público, o
> preview/pergunta transita pelo serviço deles.

### Telegram

Instale `node-red-contrib-telegrambot` no Node-RED (bot do @BotFather + chat
ID) e ligue um nó `telegram` na saída de **Registra evento**. Configure
`msg.payload` como texto da mensagem (já vem pronto).

### Pushover

Nó `http request` → `POST https://api.pushover.net/1/messages.json` com
`token` + `user` no payload.

### E-mail / outros

Qualquer nó que consuma `msg.payload`/`msg.headers` serve. O switch
**"Tipo de evento"** permite mandar `error` para um canal urgente e `done`
para um silencioso.

## Segurança

1. **Token do webhook** — é a única barreira do endpoint. Rotacione com
   frequência razoável (troque no `opencode.jsonc` + `npm run flow:apply`);
2. **`adminAuth` no Node-RED** — sem ele, qualquer dispositivo que alcance o
   editor edita seus flows. Configure no `settings.js` da máquina do Node-RED
   (hash bcrypt + reinício do serviço). Isso não pode ser feito pela API;
3. **Exposição** — mantenha o Node-RED acessível só pela rede privada/rede
   confiável; o endpoint aceita HTTP simples;
4. **Tópicos ntfy públicos** — trate o nome do tópico como segredo.

## Manutenção do flow

- **Fonte da verdade**: `nodered/flow.template.mjs` (legível, com os corpos
  das functions como template strings);
- `nodered/flow.json` é **gerado** por `flow:apply` (placeholder) — não edite à mão;
- `npm test` valida estrutura (endpoints, wires, placeholders, ausência de
  token real) e se o `flow.json` está sincronizado;
- mudou o template? `npm run flow:apply` → commit do `flow.template.mjs` +
  `flow.json` regenerado.
