# Guia de operação

Uso diário, diagnóstico e manutenção do `notify-opencode`.

- Arquitetura e decisões: [arquitetura.md](arquitetura.md)
- Verdade sobre eventos (v2.1.4): [eventos.md](eventos.md)
- Flow, canais e segurança Node-RED: [nodered.md](nodered.md)
- Ideias futuras: [ROADMAP.md](ROADMAP.md)

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
  continua disponível para elas.

> Detalhe: se você alternar muito rápido (menos de ~2,5 s entre um clique e
> outro), só o primeiro toast aparece — o OpenCode não desenha um toast por
> cima de outro ainda visível. O ícone e o estado no servidor atualizam
> normalmente; é só o aviso que se perde.

### Checagem rápida (últimos eventos)

```sh
curl -s http://SEU-NODE-RED:1880/opencode/events | head -c 800
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

## Troubleshooting

| Sintoma | Causa provável | Correção |
|---|---|---|
| Nada chega ao Node-RED | Plugin sem `token`/`url` nas options, ou falha de load | Passos 1–3 acima; confira o JSON do `opencode.jsonc` |
| 401 no debug (`send.http-error`) | Token divergente entre plugin e flow | Troque o token (abaixo) nos dois lados |
| `done` chega duplicado | Instâncias duplicadas por location (reload empilhado) + ownership falhou por `session.get` com erro | Confira `done.skipped-not-owner` no debug; consolide com `opencode service restart` (fora de horário de trabalho) |
| `question` não notifica | Toggle desligado ou tool diferente de `question` | `/notify` na sessão; debug `hook.question.error` |
| `permission` nunca notifica | **Sem regras `ask`** — a política base V2 é `allow` para tudo | Adicione regra `ask` no `opencode.jsonc` (abaixo) |
| Notificação some quando o Node-RED reinicia | Buffer de eventos é volátil (context em memória) | Comportamento esperado; buffer persistente está no [roadmap](ROADMAP.md) |
| Evento perdido com Node-RED fora | Sem retry no envio (v0.1) | Debug log tem o registro; fila/retry é item do [roadmap](ROADMAP.md) |

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

- **Node-RED sem `adminAuth`**: qualquer dispositivo que alcance a rede privada abre
  o editor e edita tudo. Configure `adminAuth` (hash bcrypt) no `settings.js`
  da máquina do Node-RED e reinicie o serviço — não dá para fazer via API;
- o webhook já exige token (401 sem/errado), mas o tráfego na rede privada é HTTP
  simples — o token é a única barreira do endpoint;
- ntfy.sh público = o **conteúdo** (preview/pergunta) transita pelo serviço
  deles. Conteúdo sensível → ntfy self-hosted ou
  `includeQuestionText/includePreview: false` nas options.
