import 'dotenv/config';

const env = (k, d = '') => process.env[k] ?? d;
const json = (k, d) => {
  try { return process.env[k] ? JSON.parse(process.env[k]) : d; } catch { return d; }
};

export const config = {
  port: Number(env('PORT', '3000')),
  publicUrl: env('PUBLIC_URL', 'http://localhost:3000'),
  jwtSecret: env('JWT_SECRET', 'troque-este-segredo'),
  dbPath: env('DB_PATH', './data/callcenter.db'),
  webhookToken: env('WEBHOOK_TOKEN', ''), // exigido em ?token= nos webhooks, se definido

  sla: {
    // Limites padrão (segundos). Cada fila pode sobrescrever.
    tmeAlertSec: Number(env('SLA_TME_ALERT_SEC', '120')),
    tmaAlertSec: Number(env('SLA_TMA_ALERT_SEC', '900')),
    warnRatio: Number(env('SLA_WARN_RATIO', '0.8')), // aviso em 80% do limite
    checkIntervalSec: Number(env('SLA_CHECK_INTERVAL_SEC', '10')),
  },

  ai: {
    enabled: env('AI_ENABLED', 'true') === 'true',
    model: env('AI_MODEL', 'claude-opus-5-5'),
    effort: env('AI_EFFORT', 'low'),
  },

  waha: {
    enabled: env('WAHA_ENABLED', 'false') === 'true',
    baseUrl: env('WAHA_URL', 'http://localhost:3001'),
    apiKey: env('WAHA_API_KEY', ''),
    session: env('WAHA_SESSION', 'default'),
    // true = só grupos entram pelo WAHA (número separado dedicado a grupos)
    groupsOnly: env('WAHA_GROUPS_ONLY', 'true') === 'true',
  },

  // OPA Suite e Chatmix: sem documentação pública. Conectores genéricos,
  // com caminhos de campo configuráveis (notação a.b.c) para o webhook de entrada
  // e template de envio. Ajuste conforme a documentação que o fornecedor passar.
  opasuite: {
    enabled: env('OPA_ENABLED', 'false') === 'true',
    baseUrl: env('OPA_URL', ''),
    token: env('OPA_TOKEN', ''),
    sendPath: env('OPA_SEND_PATH', '/api/v1/mensagem'),
    sendBody: json('OPA_SEND_BODY', { id_atendimento: '{{chatId}}', mensagem: '{{text}}' }),
    fields: json('OPA_FIELDS', {
      chatId: 'atendimento.id', messageId: 'mensagem.id', text: 'mensagem.texto',
      contactName: 'contato.nome', contactPhone: 'contato.telefone',
      fromMe: 'mensagem.enviada', mediaUrl: 'mensagem.url_arquivo', timestamp: 'mensagem.data',
    }),
  },
  chatmix: {
    enabled: env('CHATMIX_ENABLED', 'false') === 'true',
    baseUrl: env('CHATMIX_URL', ''),
    token: env('CHATMIX_TOKEN', ''),
    sendPath: env('CHATMIX_SEND_PATH', '/api/messages'),
    sendBody: json('CHATMIX_SEND_BODY', { chat_id: '{{chatId}}', text: '{{text}}' }),
    fields: json('CHATMIX_FIELDS', {
      chatId: 'chat.id', messageId: 'message.id', text: 'message.text',
      contactName: 'contact.name', contactPhone: 'contact.phone',
      fromMe: 'message.from_me', mediaUrl: 'message.media_url', timestamp: 'message.timestamp',
    }),
  },

  ixc: {
    enabled: env('IXC_ENABLED', 'false') === 'true',
    baseUrl: env('IXC_URL', ''), // ex: https://ixc.seuprovedor.com.br
    token: env('IXC_TOKEN', ''), // formato "id_usuario:token"
  },
  sgp: {
    enabled: env('SGP_ENABLED', 'false') === 'true',
    baseUrl: env('SGP_URL', ''), // ex: https://sgp.seuprovedor.com.br
    token: env('SGP_TOKEN', ''),
    app: env('SGP_APP', ''),
  },
};
