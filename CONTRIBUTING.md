# Contribuindo

Obrigado pelo interesse em melhorar o projeto! Este documento descreve o
ambiente, os comandos e o processo para contribuir.

## Ambiente

- **OpenCode V2** (desenvolvido e verificado na 2.1.4) rodando como serviço local;
- **Node.js ≥ 18** (os scripts usam `fetch` global — não há dependências npm);
- um **Node-RED** alcançável pela sua rede (o endereço fica no seu
  `opencode.jsonc` — nada pessoal vem no repositório).

## Setup

```sh
git clone https://github.com/Brook-sys/notify-opencode.git
cd notify-opencode
```

Registre o plugin no `~/.config/opencode/opencode.jsonc` apontando `package`
para o caminho local do clone (veja o [README](README.md#instalação)) e aplique
o flow no seu Node-RED:

```sh
npm run flow:apply    # lê o token do opencode.jsonc e faz o deploy idempotente
npm test              # validação estrutural do template do flow
```

## Comandos

| Comando | O que faz |
|---|---|
| `npm run flow:apply` | Aplica/atualiza a aba "OpenCode Notify" no Node-RED (via API) |
| `npm run flow:test` | Envia eventos falsos dos 4 tipos + token inválido (401) e lista o buffer |
| `npm run flow:validate` | Valida a estrutura do template do flow (executado pelo CI) |
| `npm test` | Validação do flow + varredura de higiene de dados pessoais |

A URL do Node-RED pode ser passada como argumento (`npm run flow:apply -- http://host:1880`),
pela variável de ambiente `NODE_RED_URL` — ou fica implícita: os scripts
derivam a origem de `plugins[].options.url` no `opencode.jsonc`.

## Higiene: o repo é público, o seu ambiente não

Nada que descreva **o seu** setup vai para o repositório: endereços IP
internos (inclusive faixas de VPN), caminhos de home com seu usuário, nomes
de host, topologia de rede ou estado da sua infraestrutura. A documentação
usa placeholders genéricos (`SEU-NODE-RED`, `SEU-USUARIO`).

- Anotações do seu ambiente (IP real, máquina, procedimentos específicos)
  vão em `LOCAL.md` — está no `.gitignore` e nunca é comitado;
- `npm test` também roda `scripts/check-hygiene.mjs`, que reprova o commit
  se achar IP de faixa privada de VPN, caminho `/home/<usuário>`, ID de
  sessão real ou menção a topologia de rede específica;
- valores por instalação (token, tópico ntfy, URL do Node-RED) vivem no
  `opencode.jsonc` e só entram no flow no deploy (placeholders no repo).

## Onde mexer

| Caminho | Conteúdo |
|---|---|
| `plugin/index.ts` | Lado servidor: hooks, stream, dedupe, toggle, envio |
| `plugin/tui.tsx` | Lado terminal: `/notify`, seletor, indicador no rodapé |
| `plugin/rpc.ts` | Contrato RPC compartilhado (`status` / `setEnabled`) |
| `nodered/flow.template.mjs` | Fonte da verdade do flow (`flow.json` é **gerado** por `flow:apply`) |
| `scripts/` | Deploy, teste e validação |
| `docs/` | Documentação por área |

## Convenções

- **Commits**: [conventional commits](https://www.conventionalcommits.org/pt-br/)
  (`feat`, `fix`, `docs`, `chore`, `refactor`), descrição em PT-BR, corpo
  detalhando o *porquê*.
- **Docs**: qualquer mudança de comportamento precisa refletir em `docs/` —
  especialmente `docs/eventos.md` (verdade sobre eventos da versão alvo) e
  `docs/operacao.md`.
- **Markdown**: uma linha em branco entre blocos, tabelas alinhadas, sem HTML.

## Checklist antes de abrir um PR

- [ ] `npm test` verde (validação do flow);
- [ ] `npm run flow:apply` idempotente — aplicar **duas vezes** não pode
      duplicar a aba no Node-RED;
- [ ] teste ao vivo: rode um turno real e confirme o evento em
      `GET /opencode/events` (e nenhum evento duplicado);
- [ ] nenhum segredo no diff — o token real do webhook **nunca** é comitado
      (o template usa `__OC_WEBHOOK_TOKEN__` e `__OC_NTFY_TOPIC__` como
      placeholders — valores reais vêm do `opencode.jsonc` no deploy);
- [ ] nenhum detalhe pessoal/ambiental no diff (IPs internos, caminho de
      home, topologia de rede) — `npm test` varre, mas confira com seus olhos;
- [ ] documentação atualizada quando o comportamento mudar.

## Segurança

- O token do webhook vive no `opencode.jsonc` e no flow deployado — nunca no
  repositório;
- um token vazado permite que qualquer host que alcançe o Node-RED injete
  notificações falsas — para rotacionar, veja
  [docs/operacao.md](docs/operacao.md#trocar-o-token);
- prefira `ntfy` self-hosted ou Telegram a `ntfy.sh` público se o preview das
  respostas puder conter conteúdo sensível.
