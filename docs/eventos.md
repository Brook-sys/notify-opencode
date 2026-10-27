# Referência de eventos (OpenCode 2.1.4)

Tudo aqui foi **observado ao vivo** contra a 2.1.4 (com `scripts/smoke-plugin/`
— veja como reproduzir no fim da página), exceto onde marcado como assumido.
É a fonte da verdade para entender o que o plugin escuta e o que ignora.

## Eventos do stream público usados pelo plugin

| Evento | `data` | Carrega `location`? | Uso no plugin |
|---|---|---|---|
| `session.execution.started` | `sessionID` | **não** | Marca o início do turno (duração) |
| `session.execution.succeeded` | `sessionID` | **não** | **Gatilho `done`** — fim de turno com sucesso |
| `session.execution.failed` | `sessionID` | não *(assumido)* | **Gatilho `error`** — por simetria com `succeeded`; não reproduzido ao vivo |
| `session.execution.interrupted` | `sessionID`, `reason` | não | Ignorado — o usuário interrompeu |
| `session.text.ended` | `sessionID`, `ordinal`, `text` | **sim** | Preview: última resposta do assistente |
| `session.deleted` / `session.removed` | `sessionID` | — | Higiene do toggle (defensivo; não observado ao vivo) |

> ⚠️ O ponto crítico: `session.execution.*` **não carrega `location`**, então
> toda instância do plugin (uma por location carregada) recebe uma cópia —
> é daí que vem a [deduplicação em camadas](arquitetura.md#deduplicação-em-camadas).
> Eventos de stream chegam **1× por location** (3 locations = 3 cópias).

## Hooks (disparam 1× por sessão)

| Hook | Quando | Campos usados |
|---|---|---|
| `tool.execute.before` | Antes de toda execução de tool | `tool === "question"`, `sessionID`, `input.questions[0]` (`question`, `header`, `options[].label`) |
| `permission.evaluate` | Toda avaliação de permissão | `effect === "ask"`, `sessionID`, `action`, `resources[]` |
| `tool.execute.after` | Após toda execução de tool | (disponível; não usado) |

### O gato do `permission.evaluate`

A política base da V2 é **`allow` para tudo**:

```jsonc
[{ "action": "*", "resource": "*", "effect": "allow" }, /* + ask p/ *.env */]
```

Ou seja: **por padrão, nada pede permissão** — o gatilho `permission` só
dispara se você configurar regras `ask` no `opencode.jsonc`:

```jsonc
{
  "permissions": [
    { "action": "shell", "resource": "*", "effect": "ask" },
    { "action": "shell", "resource": "git status *", "effect": "allow" }
  ]
}
```

(Verificado: com uma regra `ask` específica, o hook chega com `effect: "ask"`
e o plugin notifica; sem regras, tudo vem `allow`.)

## Campos de sessão relevantes (`session.get` / listagem)

| Campo | Uso |
|---|---|
| `title` | Título na notificação de done/error |
| `parentID` | Presente = subagente → `done` suprimido |
| `location.directory` | **Ownership check** da deduplicação |
| `model` | `{id, providerID, variant?}` — candidato para o resumo por IA (quando `summaryModel` não está setado) |
| `cost`, `tokens` | Disponíveis para enriquecer notificações (roadmap) |

## Payload da Camada 2 (resumo por IA)

Com `summary: "llm"`, o plugin acrescenta dois campos ao payload de **todos**
os tipos de evento (`question`, `permission`, `done`, `error`):

| Campo | Tipo | Valores | Descrição |
|---|---|---|---|
| `summary` | string | — | Corpo final da notificação (o resumo do modelo, ou o texto limpo no fallback) |
| `summarySource` | string | `llm` \| `heuristic` \| `fallback` \| `none` | De onde veio o corpo: modelo, limpeza determinística (texto curto), fallback por falha/timeout, ou nada |

Regras observadas:

- com `summary: "off"` (default) o payload **não ganha** os campos novos — o
  `preview` continua sendo o texto bruto cortado em 280 chars, como antes;
- com `summary: "llm"`, `summary` e `preview` têm o **mesmo conteúdo** — o
  `preview` continua existindo por compatibilidade com consumidores antigos,
  mas passa a trazer o resumo;
- `question` mantém `question`, `header` e `options` **literais** — o resumo
  nunca substitui os dados acionáveis;
- `permission` mantém `action` e `resources` literais;
- `error` usa `data.error.message` do evento `session.execution.failed` como
  texto de origem (antes usava só a última mensagem do assistente);
- o Node-RED usa `summary` como corpo **preferencial** e cai no texto antigo
  (`question`/`preview`) quando ele não vem; o `summarySource` fica no
  buffer de eventos.

### Requisições de resumo (não são eventos do OpenCode)

O resumo é uma **requisição stateless** ao modelo
(`ctx.experimental.generate.text`, o mesmo endpoint `/api/experimental/generate`):
sem sessão, sem tools, sem histórico — por isso não existe risco de loop de
notificação. A resposta do modelo é sanitizada (tira cercas de código, rótulo
`Resumo:`, aspas e markdown) e cortada no limite de `summaryMaxChars`.

Medições (OpenCode 2.2.0, provider próprio com um modelo "rotativo"
compartilhado entre o agente e o resumo):

| Cenário | Latência observada |
|---|---|
| prompt curto (~90 chars de entrada) | 4,8 s |
| prompt de ~800 chars de entrada | 14,6 s |
| provider sob carga (3 requisições simultâneas) | 32–64 s |
| texto abaixo de `summaryMinSourceChars` | **0 s** (heurística, sem chamar o modelo) |

A latência é do provider, não do plugin — e a requisição **não é cancelada**
quando o timeout estoura: a cota continua sendo consumida.

## APIs correlatas (todas verificadas ao vivo)

Relevantes para o roadmap bidirecional (responder do celular):

| Chamada | Corpo | Uso |
|---|---|---|
| `GET /api/session/{id}/permission` | — | Permissões pendentes (`id`, `action`, `resources`, `save` propostos, `source`) |
| `POST /api/session/{id}/permission/{perID}/reply` | `{"decision":"once"}` (`once` \| `always` \| `reject`) | Aprovar/negar uma permissão pendente |
| `GET /api/session/{id}/form` | — | Formulário pendente da tool `question` |
| `POST /api/session/{id}/form/{formID}/reply` | `{"answer":{"q0":"…"}}` | Responder uma pergunta pendente |
| `POST /api/rpc/notify-nodered/status` | `{"input":{"sessionID":"…"}}` | Consultar o toggle |
| `POST /api/rpc/notify-nodered/setEnabled` | `{"input":{"sessionID":"…","enabled":false}}` | Alternar o toggle |

> O wrapper `{"input":…}` é exigido nas chamadas RPC via HTTP; o cliente
> gerado usado pela TUI adiciona sozinho.

## Outros eventos observados (não usados)

`session.inbox.enqueued/delivered`, `session.instructions.updated`,
`session.step.started/ended` (com `cost`/`tokens`), `session.usage.updated`,
`session.tool.input.started/ended`, `session.tool.called`,
`session.tool.progress`, `session.tool.success`,
`session.reasoning.started/delta/ended`, `session.text.started/delta`,
`session.step.streamed`, `form.replied`, `shell.created/exited` — tudo isso é
ruído de streaming/contabilidade para este plugin, mas fica registrado aqui
porque `session.usage.updated`/`step.ended` são os candidatos naturais para
**custo por notificação** (roadmap).

## Reproduzindo a descoberta

O `scripts/smoke-plugin/` loga todo o stream, os hooks e a lista de tools num
JSONL. Registre-o no `opencode.jsonc` (array `plugins`), rode um turno e analise:

```sh
node -e '/* filtre kinds e event types do JSONL */' /tmp/opencode/notify-smoke-events.jsonl
```

O plugin real NÃO precisa dele — é ferramenta de descoberta para quando você
atualizar o OpenCode e quiser revalidar os nomes dos eventos.
