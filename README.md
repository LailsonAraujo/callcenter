# Central de Atendimento Unificada

Uma tela só para o atendente: conversas do **OPA Suite**, **Chatmix** e **grupos de WhatsApp (WAHA)**
chegam numa fila única, com **alertas de TME/TMA**, **relatórios**, **consulta de cliente no IXC e SGP**
e **registro do atendimento gerado por IA** (resumo da conversa inteira).

## Como rodar

```bash
npm install
cp .env.example .env   # preencha as integrações
npm start              # http://localhost:3000
```

Primeiro acesso: `admin@local` / `admin123` (troque a senha). Requer Node.js 20 ou superior.

```bash
npm test               # testes do fluxo: entrada → distribuição → resposta → encerramento, SLA e relatórios
```

## Funcionalidades

| Área | O que faz |
|---|---|
| **Fila unificada** | Mensagens de todos os canais viram atendimentos numa fila única. Distribuição automática para atendentes *Disponível* com menor carga (limite por atendente), ou "Assumir" manual. Transferência para atendente ou fila, notas internas. |
| **TME / TMA** | TME = entrada na fila → atendente assumir. TMA = assumir → encerrar. Cronômetro ao vivo em cada atendimento (amarelo em 80% do limite, vermelho piscando ao estourar). |
| **Alertas** | Monitor a cada 10 s: aviso e estouro de TME/TMA com toast, som e notificação do navegador. O atendente recebe os dele, o supervisor recebe todos. Limites globais no `.env` e por fila (`PUT /api/queues/:id`). |
| **Relatórios** | TME/TMA médio e máximo, % dentro do SLA, 1ª resposta e estouros, agrupados por atendente, canal, fila, dia ou hora. Exportação CSV (abre no Excel) com o resumo de cada atendimento. |
| **Painel do supervisor** | Fila agora, maior espera, atendentes e status, indicadores do dia, alertas abertos. |
| **Grupos de WhatsApp** | Número separado conectado no WAHA. Cada grupo vira um atendimento, com o nome do grupo e quem falou cada mensagem. |
| **IXC / SGP** | Busca por CPF/CNPJ ou telefone nos dois ERPs ao mesmo tempo: dados do cliente, contratos/planos, status da conexão e títulos em aberto. "Vincular ao atendimento" grava o cliente no contato. |
| **Registro por IA** | Ao encerrar, a IA (Claude) lê a conversa toda e grava: resumo, motivo, categoria, ações, pendências, se foi resolvido e o sentimento do cliente. O atendente pode gerar antes, editar e salvar. |

## Configurando as integrações

### WAHA (grupos)
1. Suba o WAHA com o número dedicado e crie a sessão (`WAHA_SESSION`).
2. No WAHA, configure o webhook: URL `https://SEU_HOST/webhooks/waha?token=WEBHOOK_TOKEN`, evento **`message.any`**
   (assim as mensagens enviadas pelo celular também entram no histórico).
3. `WAHA_GROUPS_ONLY=true` faz o número atender só grupos.

### OPA Suite
Integração feita com base na [documentação oficial da API](https://api.opasuite.com.br/).
1. No OPA, crie um usuário com perfil de permissões do tipo **API** e copie o token.
2. Preencha `OPA_URL` (o domínio do seu OPA) e `OPA_TOKEN` e ative `OPA_ENABLED=true`.

Como funciona:
- **Entrada por polling**: a API do OPA não oferece webhook. A cada `OPA_POLL_SEC` segundos o sistema lista
  os atendimentos não finalizados (`GET /api/v1/atendimento`) e busca as mensagens de cada um
  (`GET /api/v1/atendimento/mensagem`). Mensagens repetidas são descartadas.
- Nome e CPF/CNPJ do cliente vêm do atendimento "populado" (`GET /api/v1/atendimento/:id`). O CPF já
  alimenta a consulta no IXC/SGP.
- **Saída**: `POST /api/v1/atendimento/mensagem/send`. Funciona em atendimentos em andamento: com atendente,
  agente virtual ou na fila.
- **Registro da IA de volta no OPA**: ao encerrar, o resumo é gravado como observação no atendimento
  (`POST /api/v1/atendimento/:id/observacao`). Para desligar, use `OPA_WRITE_SUMMARY=false`.
- O TME conta a partir da abertura do atendimento no OPA.

### Chatmix
Não há documentação pública da API do Chatmix, então o conector é **configurável**:
- **Entrada**: aponte o webhook para `https://SEU_HOST/webhooks/chatmix?token=WEBHOOK_TOKEN` e ajuste
  `CHATMIX_FIELDS` com os caminhos dos campos no JSON recebido (ex.: `"text": "message.text"`).
- **Saída**: `CHATMIX_SEND_PATH` e `CHATMIX_SEND_BODY` definem o endpoint e o corpo do envio.
  `{{chatId}}` e `{{text}}` são substituídos. A autenticação vai como `Authorization: Bearer <TOKEN>`.

Se o formato for muito diferente, crie um conector próprio em `src/connectors/` seguindo `waha.js` ou `opasuite.js`.

### IXC Soft
Token conforme a [wiki do IXC](https://wiki-erp.ixcsoft.com.br/documentacao/guias-tutoriais/api/):
Configurações → Usuários → marque **"Permite acesso a API"** e salve para gerar o token.
`IXC_TOKEN` fica no formato `id_usuario:token`. No grupo do usuário, dê permissão de leitura em `cliente`,
`cliente_contrato` e `fn_areceber`. **Inclua o IP deste servidor nos IPs permitidos**, senão o IXC recusa as chamadas.

### SGP
Integração feita com base na [documentação oficial da API](https://api.sgp.net.br/) (endpoints de URA):
- `POST /api/ura/consultacliente/` por CPF/CNPJ ou **telefone**. O DDI 55 do WhatsApp é removido.
- `POST /api/ura/titulos/` com `status=abertos`: valor corrigido, vencimento, linha digitável/código de barras e link do boleto.
- Autenticação por `SGP_TOKEN` + `SGP_APP` (Sistema → Ferramentas → Painel Admin → Tokens) ou `SGP_USER`/`SGP_PASSWORD`.

### IA
Coloque sua chave em `ANTHROPIC_API_KEY`. O modelo padrão é `claude-opus-5-5` com esforço `low`
(suficiente para resumos). O fallback automático de modelo do servidor está ativado: se o primeiro modelo
recusar, a API tenta outro. Para baratear em volume alto, troque `AI_MODEL` para `claude-haiku-5-5`.
Sem chave, o atendimento encerra normalmente e aparece um aviso de que o resumo não foi gerado.

## Estrutura

```
src/
  server.js                 Express + Socket.IO (tempo real)
  config.js                 Configuração via .env
  db.js                     SQLite (better-sqlite3): users, queues, contacts, conversations, messages, alerts
  connectors/               Canais: waha.js, opasuite.js (polling), generic.js (Chatmix), index.js
  integrations/             ERPs: ixc.js, sgp.js, index.js (consulta paralela)
  services/
    conversations.js        Fila, distribuição, envio, transferência, encerramento
    sla.js                  Monitor de TME/TMA e alertas
    reports.js              Relatórios e CSV
    ai.js                   Resumo do atendimento com Claude
  routes/api.js, webhooks.js
public/                     Interface web (atendente, painel, relatórios)
test/core.test.js
```

## Antes de colocar em produção
- Rode atrás de HTTPS (nginx/Caddy) e defina `JWT_SECRET` e `WEBHOOK_TOKEN`.
- Faça backup do arquivo SQLite. Com muitos atendentes simultâneos, migre para PostgreSQL
  (as consultas estão concentradas em `services/`).
- Teste com dados reais: os conectores do OPA e do SGP seguem as documentações oficiais, mas só foram
  validados com os exemplos delas. O conector do Chatmix precisa do mapeamento de campos.
