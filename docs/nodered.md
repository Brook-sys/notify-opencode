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

Alternativa manual: `nodered/flow.json` (gerado, com placeholders) → editor →
Menu → Import → substituir `__OC_WEBHOOK_TOKEN__` pelo token real e
`__OC_NTFY_TOPIC__` pelo seu tópico ntfy.

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
| `Registra evento` | Guarda no buffer (flow context, últimos 30) e monta a publicação JSON do ntfy (`topic`, `title`, `message`, `priority`, `tags`) |
| `Evento OpenCode` (debug) | Mostra `msg.notify` no painel Debug do editor |
| `CANAL ntfy (ntfy.sh)` | Nó `http request` **habilitado** — POST do JSON em `https://ntfy.sh/`; o tópico vai no corpo (injetado no deploy a partir de `options.ntfyTopic`) |
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

Na saída de **Registra evento**, o canal ntfy recebe a publicação pronta —
API JSON do ntfy (`POST https://ntfy.sh/`):

- `msg.payload` → JSON `{"topic","title","message","priority","tags"}` —
  emoji, acentos e multiline vão no corpo (headers HTTP não aceitam nada
  além de Latin-1; o antigo formato via `Title` header quebrava com emoji:
  `invalid character in header content`);
- `msg.headers` → apenas `Content-Type: application/json`;
- `priority` → `5` urgente (erro), `4` alta (pergunta/permissão), `3` normal
  (terminou);
- `tags` → `opencode` + ícone por tipo (`question`, `lock`,
  `white_check_mark`, `warning`) — o app ntfy renderiza como emoji.

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

## O canal de notificação

### ntfy (plugado e habilitado)

O flow já publica no **ntfy.sh via API JSON** — não há nada para habilitar.
Falta só dizer o tópico (e assiná-lo no celular):

1. Instale o app ntfy no celular;
2. Escolha o tópico em `plugins[].options.ntfyTopic` do
   `~/.config/opencode/opencode.jsonc` — nome **longo e aleatório**
   (ex.: `opencode-a7x2k9m4…`);
3. Rode `npm run flow:apply` para implantar com o tópico real;
4. No app, assine o mesmo tópico. Pronto.

> **O tópico é a "senha"**: no ntfy.sh público, quem souber o nome do tópico
> pode ler as notificações (títulos e previews das suas sessões de IA) e
> publicar no seu lugar. Prefira um nome longo e aleatório
> (`opencode-x7k2m9p4qz…`) ou rode ntfy self-hosted com auth. Conteúdo
> sensível no preview? Idem — self-hosted.

> Por que API JSON e não headers? Valores de header HTTP só aceitam Latin-1:
> emoji (✅❓🔐❗) no `Title` faz o Node recusar o request inteiro com
> `invalid character in header content`. No corpo JSON, tudo é permitido.

### Telegram

Instale `node-red-contrib-telegrambot` no Node-RED (bot do @BotFather + chat
ID) e ligue um nó `telegram` na saída de **Registra evento**, com um nó
`change` no meio montando o texto — o payload de saída é o **JSON do ntfy**,
não texto puro:
`msg.payload = msg.notify.title + "\n" + msg.notify.text`.

### Pushover

Nó `function` + `http request` → `POST https://api.pushover.net/1/messages.json`
montando `token` + `user` + `message` a partir de `msg.notify`.

### E-mail / outros

Qualquer canal que consuma `msg.notify` (title/text/priority/type) serve —
monte o corpo do seu lado. O switch **"Tipo de evento"** permite mandar
`error` para um canal urgente e `done` para um silencioso.

## Segurança

1. **Token do webhook** — é a única barreira do endpoint. Rotacione com
   frequência razoável (troque no `opencode.jsonc` + `npm run flow:apply`);
2. **`adminAuth` no Node-RED** — sem ele, qualquer dispositivo que alcance o
   editor edita seus flows. Configure no `settings.js` da máquina do Node-RED
   (hash bcrypt + reinício do serviço). Isso não pode ser feito pela API;
3. **Exposição** — mantenha o Node-RED acessível só pela sua rede privada/VPN;
   o endpoint aceita HTTP simples;
4. **Tópicos ntfy públicos** — trate o nome do tópico como segredo.

## Manutenção do flow

- **Fonte da verdade**: `nodered/flow.template.mjs` (legível, com os corpos
  das functions como template strings);
- `nodered/flow.json` é **gerado** por `flow:apply` (placeholder) — não edite à mão;
- `npm test` valida estrutura (endpoints, wires, placeholders, ausência de
  token real) e se o `flow.json` está sincronizado;
- mudou o template? `npm run flow:apply` → commit do `flow.template.mjs` +
  `flow.json` regenerado.
