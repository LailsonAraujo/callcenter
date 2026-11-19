// Conector genérico baseado em mapeamento de campos — usado para OPA Suite e Chatmix,
// cujas APIs não têm documentação pública. Os caminhos dos campos e o corpo de envio
// são configuráveis via .env (veja config.js / README).
import { getPath, fillTemplate, httpJson, toMs, truthy } from './util.js';

export function createGenericConnector({ channel, label, cfg }) {
  return {
    channel,
    label,

    async normalize(body) {
      const f = cfg.fields;
      const chatId = getPath(body, f.chatId);
      if (chatId == null) return null;
      const fromMe = truthy(getPath(body, f.fromMe));
      const contactName = getPath(body, f.contactName);
      const phone = String(getPath(body, f.contactPhone) ?? '').replace(/\D/g, '') || null;
      return {
        channel,
        chatId: String(chatId),
        isGroup: false,
        groupName: null,
        contact: { name: contactName || phone || String(chatId), phone },
        message: {
          externalId: getPath(body, f.messageId) != null ? String(getPath(body, f.messageId)) : null,
          text: getPath(body, f.text) ?? '',
          fromMe,
          senderName: fromMe ? label : contactName,
          mediaUrl: getPath(body, f.mediaUrl) || null,
          timestamp: toMs(getPath(body, f.timestamp)),
        },
      };
    },

    async send(conversation, text) {
      if (!cfg.baseUrl) throw new Error(`${label}: URL da API não configurada`);
      const res = await httpJson(`${cfg.baseUrl}${cfg.sendPath}`, {
        method: 'POST',
        headers: cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {},
        body: fillTemplate(cfg.sendBody, { chatId: conversation.external_id, text }),
      });
      return { externalId: res?.id != null ? String(res.id) : null };
    },
  };
}
