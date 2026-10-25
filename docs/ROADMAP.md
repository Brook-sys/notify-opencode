# Roadmap

Ideias de melhoria e expansão — ordenadas por **valor ÷ esforço**, com o que
já foi pesquisado de marcação "pesquisa pronta". Contribuições em qualquer
destes itens são bem-vindas (veja [CONTRIBUTING](../CONTRIBUTING.md)).

## Curto prazo

### 1. Canal de notificação real 📱 ✅ (feito na 0.2.1)

Entregue via **ntfy.sh** (publicação JSON: título/ícone/prioridade no corpo,
tópico injetado no deploy por `options.ntfyTopic`). Melhorias que restam no
tema: ntfy self-hosted com auth e canais alternativos (Telegram/Pushover) —
ver [docs/nodered.md](nodered.md#o-canal-de-notificação).

### 2. Fila/retry de eventos
Hoje o envio é fire-and-forget: Node-RED fora no momento do evento = evento
perdido (fica só no debug log). Proposta: buffer persistente no `ctx.storage`
do plugin com replay ao reconectar + relay de indisponibilidade.

### 3. Custo e tokens na notificação
`session.get()` já expõe `cost`/`tokens` e o stream tem
`session.usage.updated`/`session.step.ended` com os mesmos campos
(pesquisa pronta). Meta: `✅ done · $0,012 · 3 min` no corpo da notificação.

### 4. Toggle global e por projeto
Hoje o toggle é por sessão (default ligado). Adicionar: default **por
location** no `opencode.jsonc` (`"default": "off"` para projetos de teste)
e um toggle global via RPC.

### 5. Reportar/corrigir fragilidades upstream 🛡️
Descobertas na 0.2.0, verificadas na 2.1.4: (a) `toast.show` com variante
fora de `info|success|warning|error` **derruba a TUI inteira** (o componente
lê `theme.text.feedback[variant].base` sem guarda — nós mitigamos com
try/catch, o correto é corrigir lá); (b) toast exibido enquanto outro está
visível **não renderiza**; (c) o parser de mouse engole press+release
coalescidos no mesmo chunk de stdin. Vale issue/PR no `anomalyco/opencode`.

## Médio prazo

### 6. Bidirecional: responder do celular 🔁
A base já foi verificada ao vivo (pesquisa pronta):

- aprovar/negar permissões: `POST /api/session/{id}/permission/{perID}/reply`
  com `{"decision":"once"|"always"|"reject"}`;
- responder perguntas: `POST /api/session/{id}/form/{formID}/reply` com
  `{"answer":{"q0":"…"}}`.

Falta: um flow Telegram bot (ou ntfy + ação) que receba a resposta do celular
e chame essas APIs. **Segurança obrigatória**: chat ID em allowlist + token
próprio no endpoint de volta. Este é o item de maior impacto da lista —
transforma notificação em controle remoto.

### 7. Quiet hours / não perturbe
Janela de silêncio (ex.: 23h–8h) no próprio Node-RED (function node no
caminho do canal) — sem tocar no plugin. `error` pode furar a janela
sobrepujando prioridade.

### 8. Rate limit / digest
Muitos `done` em rajada (loops, subagentes paralelos) = spam. Agrupar em
janela (ex.: máximo 1 mensagem/minuto com resumo) no Node-RED.

### 9. Dashboard Node-RED (Dashboard 2.0)
Painel web na mesma instância: histórico de eventos, botões de mute por
sessão, aprovar/negar permissões pendentes com um clique — reaproveitando as
APIs do item 6.

### 10. `done` de subagente opcional
Hoje suprimimos (`parentID`). Opção `notifySubagents: true` para quem quiser
visibilidade total, talvez só em canal separado.

### 11. `minDurationSec` por tipo
O filtro de duração mínima existe global; estender por tipo
(ex.: filtrar `done` < 30 s, mas nunca filtrar `error`).

## Longo prazo

### 12. Publicação como pacote
Publicar no npm e registrar no diretório/registry de plugins do OpenCode
quando houver — instalação sem clone: `"package": "notify-opencode"`.

### 13. Watchdog / heartbeat
O plugin pinga o Node-RED a cada N minutos; o Node-RED alerta se ficar sem
heartbeat (pipeline morto = você fica sem notificação e não percebe).

### 14. Multi-servidor
Vários hosts com OpenCode apontando para o mesmo Node-RED — o payload já
carrega `from` (location); falta separar visualmente/rotear por origem.

### 15. Testes automatizados de verdade
Hoje: validação estrutural (`npm test`) + procedimento manual ao vivo.
Evolução: harness que sobe um OpenCode server efêmero, injeta eventos falsos
no stream e afirma os payloads; contratos RPC tipados com testes de schema.

### 16. i18n das mensagens
Títulos/textos ("Terminou", "Pergunta") parametrizáveis (PT/EN) — as strings
vivem no flow Node-RED, então é barato.

### 17. Métricas
Contadores de enviados/falhos/suprimidos por motivo expostos via RPC
(`stats`) ou endpoint — para enxergar a saúde do pipeline sem log.

---

## Não temos interesse (por enquanto)

- **Polling agressivo** de estado da sessão no plugin (custo/complexidade
  sem gatilho claro — o stream já entrega tudo);
- **Canais proprietários** além dos que o Node-RED já oferece como nós
  (manter o foco no pipeline, não em integrações uma a uma).
