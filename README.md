# opencode-notify-nodered

Plugin do [OpenCode](https://opencode.ai) (V2) que transforma eventos de sessão em **gatilhos** para um flow do [Node-RED](https://nodered.org) — pronto para disparar notificações no celular (ntfy, Telegram, Pushover, e-mail, o que você plugar).

```
┌─ OpenCode (serviço local) ───────────────────────────────────────┐
│  plugin/                                                          │
│  ├─ index.ts  lado servidor: escuta eventos, respeita o toggle,   │
│  │            e faz POST no webhook                                │
│  ├─ tui.tsx   lado terminal: comando /notify + indicador 🔔/🔕     │
│  └─ rpc.ts    contrato de toggle por sessão (TUI ↔ servidor)      │
└────────────┬──────────────────────────────────────────────────────┘
             │ POST http://<node-red>:1880/opencode/event (token)
             ▼
┌─ Node-RED ── flow "OpenCode Notify" ─────────────────────────────┐
│  valida token → roteia por tipo → registra → [seu canal aqui]     │
│  GET /opencode/events → últimos 30 eventos (checagem rápida)     │
└───────────────────────────────────────────────────────────────────┘
```

## Gatilhos

| Evento | Quando dispara | Prioridade sugerida |
|---|---|---|
| `question` | o agente usou a tool `question` e está esperando resposta | alta |
| `permission` | um comando/arquivo precisa de aprovação (sessão travada esperando) | alta |
| `done` | o turno terminou com sucesso (inclui preview da última resposta) | normal |
| `error` | o turno falhou | urgente |

Detalhes de comportamento:

- **Notificação é por sessão, ligada por padrão** — toda sessão nova notifica. Use `/notify` (ou `/notify on|off`) dentro de uma sessão para alternar; o estado persiste enquanto a sessão existir.
- Turnos de **subagentes não geram "done"** (só a sessão principal notifica); perguntas/permissões de subagentes notificam normal.
- Turnos **interrompidos** pelo usuário não notificam.
- O plugin envia **fire-and-forget** (timeout 4s): problemas de rede nunca travam uma sessão.

## Instalação

### 1. Plugin (OpenCode)

Registre no `~/.config/opencode/opencode.jsonc` (ajuste o caminho):

```jsonc
{
  "plugins": [
    {
      "package": "/caminho/para/opencode-notify-nodered/plugin",
      "options": {
        "url": "http://SEU-NODE-RED:1880/opencode/event",
        "token": "um-token-aleatorio-longo",
        "minDurationSec": 0,
        "includePreview": true,
        "includeQuestionText": true,
        "debug": true,
        "debugLogPath": "/tmp/opencode/notify-nodered-debug.jsonl"
      }
    }
  ]
}
```

A config é recarregada a quente (sem restart). Verifique com `opencode api get /api/plugin | grep notify`.

### 2. Flow (Node-RED)

```sh
node scripts/apply-nodered-flow.mjs http://SEU-NODE-RED:1880
```

O script lê o token do `opencode.jsonc`, aplica (ou atualiza) a aba **OpenCode Notify** e grava `nodered/flow.json` com placeholder (seguro para commit). Para importar manualmente: Menu → Import → cole o `nodered/flow.json` e troque o `__OC_WEBHOOK_TOKEN__` pelo token real.

### 3. Plugar o canal de notificação

No flow, a saída do nó **"Registra evento"** já vem formatada: `msg.payload` = texto da notificação, `msg.headers` = `Title`/`Priority`/`Tags` (formato ntfy). Existe um nó **http request** ntfy desabilitado como placeholder — troque a URL pelo seu tópico (ex.: `https://ntfy.sh/um-topico-bem-aleatorio`) e habilite. Telegram/Pushover: ligue um nó apropriado nessa mesma saída.

## Teste

```sh
node scripts/test-send-event.mjs http://SEU-NODE-RED:1880
```

Envia os 4 tipos de evento falsos, testa rejeição de token inválido (401) e mostra o buffer de eventos.

## Estrutura

```
plugin/           o plugin OpenCode (server + TUI + contrato RPC)
nodered/          template do flow + flow.json gerado (sem segredos)
scripts/
  apply-nodered-flow.mjs   aplica/atualiza o flow via API do Node-RED
  test-send-event.mjs     teste de ponta com eventos falsos
  smoke-plugin/           utilitário de descoberta de eventos (veja docs/)
docs/OPERACAO.md  guia de operação e troubleshooting
```

## Limitações conhecidas

- O webhook não tem retry: se o Node-RED estiver fora no momento do evento, ele se perde (fica registrado no debug log).
- O buffer de eventos do Node-RED vive em memória (context) — zera quando o Node-RED reinicia.
- O toggle `/notify` só existe onde há TUI; sessões headless ficam sempre ligadas.
- `session.execution.failed` foi implementado por simetria com `succeeded`, mas não foi possível reproduzir uma falha real para validar o nome exato do evento nesta versão (2.1.4).
