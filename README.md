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

### OPA Suite e Chatmix
Não encontrei documentação pública das APIs desses dois sistemas. Por isso os conectores são **configuráveis**:
- **Entrada**: aponte o webhook do sistema para `https://SEU_HOST/webhooks/opasuite` (ou `/webhooks/chatmix`) e
  ajuste `OPA_FIELDS` / `CHATMIX_FIELDS` com os caminhos dos campos no JSON que o sistema envia
  (ex.: `"text": "mensagem.texto"`).
- **Saída**: `*_SEND_PATH` e `*_SEND_BODY` definem o endpoint e o corpo usados para responder.
  `{{chatId}}` e `{{text}}` são substituídos. A autenticação vai como `Authorization: Bearer <TOKEN>`.

Para descobrir o formato do webhook, deixe `*_ENABLED=true` e veja o payload chegando
(ou use um serviço como webhook.site). Peça ao suporte de cada sistema a documentação da API de envio.
Se o formato for muito diferente, crie um conector próprio em `src/connectors/` seguindo `waha.js`:
basta implementar `normalize(body)` e `send(conversation, text)`.

### IXC Soft
`IXC_TOKEN` no formato `id_usuario:token` (Configurações → Usuários → Token de API). O usuário precisa de
permissão de leitura em `cliente`, `cliente_contrato` e `fn_areceber`.

### SGP
Use o token e o nome do app cadastrados no SGP. As consultas usam os endpoints de URA
(`/api/ura/consultacliente/` e `/api/ura/titulos/`). Os nomes dos campos variam entre versões do SGP:
o retorno original fica em `raw`. Se algum campo vier vazio, ajuste o mapeamento em `src/integrations/sgp.js`.

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
  connectors/               Canais: waha.js, generic.js (OPA/Chatmix), index.js
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
- Valide os conectores OPA/Chatmix e os campos do SGP com dados reais (veja acima).
