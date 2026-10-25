# Changelog

Todas as mudanças relevantes deste projeto ficam documentadas neste arquivo.

O formato segue [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e o
versionamento segue [SemVer](https://semver.org/lang/pt-BR/).

## [0.1.0] — 2026-10-25

Primeira versão funcional, testada de ponta a ponta contra OpenCode 2.1.4 e
Node-RED (flow aplicado via API).

### Adicionado

- **Plugin OpenCode V2** (`plugin/`) com quatro gatilhos:
  - `question` — o agente usou a tool `question` e está esperando resposta
    (hook `tool.execute.before`, com texto, header e opções);
  - `permission` — uma ação está aguardando aprovação
    (hook `permission.evaluate` com `effect === "ask"`, com ação e recursos);
  - `done` — o turno terminou com sucesso (`session.execution.succeeded`),
    com preview da última resposta e duração;
  - `error` — o turno falhou (`session.execution.failed`).
- **Deduplicação entre instâncias**: o plugin é instanciado uma vez por
  *location* carregada e todas recebem o stream de eventos; só a instância
  dona da sessão envia (checagem via `session.get().location`), com LRU de ids
  no storage compartilhado como segunda camada.
- **Supressão de subagentes**: sessões filhas (`parentID`) não geram `done`.
- **Turnos interrompidos** pelo próprio usuário não notificam.
- **Entrega fire-and-forget** com timeout de 4 s: falha de rede nunca bloqueia
  ou derruba uma sessão.
- **Toggle por sessão** (padrão **ligado**), persistido no storage do plugin e
  exposto via RPC (`status` / `setEnabled`) — utilizável pela TUI e pela API.
- **Lado TUI** (`plugin/tui.tsx`): comando `/notify` (seletor Ligado/Desligado),
  `/notify on|off`, entrada na paleta de comandos e indicador 🔔/🔕 no rodapé
  da sessão.
- **Flow Node-RED "OpenCode Notify"** (`nodered/`): webhook
  `POST /opencode/event` com validação de token (401 sem/errado), formatação
  por tipo, buffer dos últimos 30 eventos e endpoint de checagem
  `GET /opencode/events`; nó ntfy placeholder já plugado e desabilitado.
- **Scripts**:
  - `apply-nodered-flow.mjs` — deploy idempotente via API (cria ou atualiza a
    aba), lê o token do `opencode.jsonc` e nunca o comita;
  - `test-send-event.mjs` — teste de ponta com eventos falsos dos 4 tipos + 401;
  - `validate-flow.mjs` — validação estrutural do template (usado pelo CI);
  - `smoke-plugin/` — utilitário de descoberta de eventos (manteve o mapeamento
    da 2.1.4 documentado em `docs/eventos.md`).
- **Documentação**: arquitetura, referência de eventos, guia do Node-RED,
  operação/troubleshooting e roadmap.

### Verificado ao vivo (OpenCode 2.1.4 + Node-RED)

- `done` de sessão real chegando **1×** (dedupe entre 3 locations) com preview;
- `question` com texto e opções de uma pergunta real;
- `permission` com `ask` real (regra temporária de permissão) + aprovação via
  `POST /api/session/{id}/permission/{id}/reply` com `{"decision":"once"}`;
- toggle `off` suprime eventos de um turno novo; `on` retoma;
- token inválido → 401; re-deploy do flow → idempotente (PUT, sem aba duplicada);
- carregamento do lado TUI verificado em pty real (comando visível na paleta).

### Limitações conhecidas

- `session.execution.failed` foi implementado por simetria com `succeeded`, mas
  não houve reprodução real de falha na 2.1.4 para validar o nome do evento;
- sem retry de webhook: se o Node-RED estiver fora no momento do evento, ele
  se perde (fica registrado no debug log);
- o buffer de eventos do Node-RED é volátil (context em memória, some ao
  reiniciar o Node-RED);
- o gatilho `permission` só dispara quando existem regras `ask` configuradas —
  a política base da V2 é `allow` para tudo;
- o comando `/notify` exige TUI; sessões headless ficam sempre ligadas
  (o toggle via RPC continua disponível para elas).
