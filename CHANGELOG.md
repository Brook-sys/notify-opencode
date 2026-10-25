# Changelog

Todas as mudanças relevantes deste projeto ficam documentadas neste arquivo.

O formato segue [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e o
versionamento segue [SemVer](https://semver.org/lang/pt-BR/).

## [0.2.2] — 2026-10-25

O repositório é público e é produto para terceiros — ele não deve descrever o
ambiente de quem desenvolve. Removidos os detalhes pessoais que tinham vazado
para docs e defaults: endereço IP interno de rede privada, caminho de home
com usuário real e menções ao estado da infraestrutura do autor.

### Corrigido

- **Nenhum endereço pessoal como default**: o plugin passa a assumir
  `http://localhost:1880/opencode/event` quando `options.url` não é
  informado; `flow:apply` e `flow:test` passam a derivar a URL do Node-RED
  da **origem** de `plugins[].options.url` do `opencode.jsonc` (precedência:
  env `NODE_RED_URL` > argumento > config > localhost). Para quem já tem
  `options.url` configurada, nada muda no dia a dia;
- **documentação 100% genérica**: exemplos com `SEU-NODE-RED` e
  `SEU-USUARIO`; conselhos de segurança (`adminAuth`, rede privada) sem
  revelar o estado da infraestrutura de ninguém.

### Adicionado

- **`scripts/check-hygiene.mjs`** (roda no `npm test`, logo no CI): reprova
  o commit se achar IP em faixa CGNAT/VPN (RFC 6598), caminho
  `/home/<usuário>`, ID de sessão real ou menção a topologia de rede
  específica — a barreira para este tipo de vazamento não repetir;
- convenção **`LOCAL.md`**: anotações do próprio ambiente (endereços reais,
  máquina, procedimentos específicos) vivem nesse arquivo da raiz, que já
  vem no `.gitignore` — detalhes pessoais nunca são comitados.

## [0.2.1] — 2026-10-25

O canal ntfy sai do placeholder e entrega de verdade — com a correção de um
bug empírico no caminho: publicar via headers HTTP quebrava **100%** das
notificações.

### Corrigido

- **`invalid character in header content` no nó ntfy**: a publicação usava
  headers HTTP (`Title`, `Priority`, `Tags`) e todo título começa com emoji
  (✅❓🔐❗). Valores de header HTTP só aceitam Latin-1, então o Node recusava
  o request inteiro para **qualquer** evento (reprodução isolada: POST direto
  ao ntfy.sh com emoji no `Title` → `TypeError … value of 9989 … greater than
  255`; ASCII puro → 200 entregue). Migração para a **API JSON do ntfy**
  (`POST https://ntfy.sh/` com `topic`/`title`/`message`/`priority`/`tags`
  no corpo) — emoji, acentos e multiline no título funcionam.

### Adicionado

- **Prioridades numéricas** (erro → 5/urgente, pergunta e permissão → 4/alta,
  `done` → 3/normal) e **tags** (`opencode` + ícone por tipo: `question`,
  `lock`, `white_check_mark`, `warning`) — o app ntfy renderiza como emoji;
- **`ntfyTopic` como opção de deploy** (`plugins[].options` no
  `opencode.jsonc`): o `flow:apply` injeta o valor no lugar do placeholder
  `__OC_NTFY_TOPIC__` — o tópico nunca é comitado, como o token (o validador
  do `npm test` passou a exigir exatamente 1 ocorrência do placeholder e nó
  apontando para a raiz da API JSON, `POST`);
- Nó **"CANAL ntfy (ntfy.sh)" sai habilitado** por padrão no template — não
  há mais nada para ativar à mão no editor.

### Verificado ao vivo

- 6 entregas ao tópico conferidas via `https://ntfy.sh/<topico>/json`:
  4 eventos falsos (um de cada tipo, com prioridades/tags corretas) + 2
  pós-redeploy do template — o template é a fonte única e o patch manual da
  instância não sobrevive como estado necessário.

### Fragilidades conhecidas

- ntfy.sh público: **o nome do tópico é a "senha"** — quem souber o nome lê
  as notificações (títulos/previews das sessões) e publica no seu lugar.
  Use um tópico longo e aleatório, rotacione em caso de suspeita, ou rode
  ntfy self-hosted com auth;
- sem retry em direção ao ntfy: se o ntfy.sh estiver fora no momento do
  evento, a publicação se perde (fica no buffer local, sem reenvio).

## [0.2.0] — 2026-10-25

O ícone do rodapé virou o controle principal: **um clique alterna as
notificações da sessão** e o ícone troca reativamente (🔔 ↔ 🔕). Testado de
ponta a ponta em pty real contra OpenCode 2.1.4 — clique, RPC, estado no
servidor, troca de ícone e toast verificados nos dois sentidos (ligar e
desligar), sem crash.

### Adicionado

- **Ícone clicável no rodapé da sessão** (`plugin/tui.tsx`): um clique com o
  botão esquerdo alterna o estado da sessão atual. O OpenTUI não sintetiza um
  evento de "clique" — um clique é o par `down`+`up` — então o toggle só
  dispara no `up` se o `down` aconteceu sobre o ícone (evita, por exemplo,
  arrastar uma seleção de texto e soltar sobre o ícone). `selectable={false}`
  e `stopPropagation()` no `up`, seguindo o padrão dos próprios componentes
  do OpenCode (autocomplete, tabs, diff viewer).
- **Cursor de ponteiro no hover** sobre o ícone (`renderer.setMousePointer`,
  tratado como cosmético: qualquer falha é engolida).
- **Sincronização inicial por sessão**: um `status` por sessão, em background,
  na primeira renderização — o ícone nasce correto mesmo se o estado foi
  alterado via API ou por outra instância da TUI.
- **Cache reativo local** (`context.storage.store`, durável e sincronizado
  entre instâncias da TUI): o ícone troca na hora; o clique pergunta o estado
  real ao servidor antes de alternar.

### Corrigido

- **Toast com variante inválida derrubava a TUI inteira** (bug desde 0.1.0):
  `variant: "default"` não existe no mapa `text.feedback` do tema e a
  exceção (`TypeError: undefined is not an object (evaluating
  'n.text.feedback[t.toast.variant].base')`) crashava o app. Era o caminho do
  `/notify` sem sessão aberta e do toast de "desligadas". Agora só saem
  variantes válidas (`info | success | warning | error`) e **todo** toast
  passa por um helper com `try/catch` — um toast nunca mais pode derrubar o
  app.

### Fragilidades conhecidas (documentadas, não bloqueiam)

- O componente de toast do OpenCode **não renderiza um toast exibido enquanto
  outro ainda está visível** (verificado empiricamente: 4 variantes
  sobrepostas → só a 1ª desenha; espaçadas → todas desenham). Em trocas
  rápidas só o primeiro toast aparece; o ícone e o estado no servidor seguem
  corretos — o toast é feedback best-effort.
- O ícone vive no slot `prompt.footer.status`: **não renderiza enquanto o
  composer está fora da tela** (sessão em estado "working" com footer
  oculto). O toggle via `/notify` e RPC continua disponível.
- Cliques sintéticos que injetam press+release colados no mesmo chunk de
  stdin são engolidos pelo parser do OpenTUI; terminais reais não coalescem
  (não afeta usuários, só ferramentas de automação que emulam mouse).

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
