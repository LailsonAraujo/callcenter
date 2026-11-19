// WAHA (WhatsApp HTTP API) — número separado dedicado a grupos de WhatsApp.
// Webhook: configure no WAHA a URL  {PUBLIC_URL}/webhooks/waha  com o evento "message.any".
import { config } from '../config.js';
import { httpJson, toMs } from './util.js';

const groupNames = new Map();

function headers() {
  return config.waha.apiKey ? { 'X-Api-Key': config.waha.apiKey } : {};
}

async function groupName(groupId) {
  if (groupNames.has(groupId)) return groupNames.get(groupId);
  try {
    const g = await httpJson(
      `${config.waha.baseUrl}/api/${encodeURIComponent(config.waha.session)}/groups/${encodeURIComponent(groupId)}`,
      { headers: headers() },
    );
    const name = g?.subject || g?.name || g?.groupMetadata?.subject || null;
    if (name) groupNames.set(groupId, name);
    return name;
  } catch {
    return null;
  }
}

export const waha = {
  channel: 'waha',
  label: 'WhatsApp (WAHA)',

  /** Converte o webhook do WAHA no evento normalizado, ou null para ignorar. */
  async normalize(body) {
    if (!body || !['message', 'message.any'].includes(body.event)) return null;
    const p = body.payload || {};
    const fromMe = !!p.fromMe;
    const chatId = fromMe ? p.to : p.from;
    if (!chatId || chatId === 'status@broadcast') return null;

    const isGroup = chatId.endsWith('@g.us');
    if (config.waha.groupsOnly && !isGroup) return null;

    const senderId = isGroup ? p.participant || p.author : chatId;
    const senderName = p._data?.notifyName || p._data?.pushName || p.notifyName || senderId?.split('@')[0];
    const phone = isGroup ? null : chatId.split('@')[0];

    const gName = isGroup ? await groupName(chatId) : null;

    return {
      channel: 'waha',
      chatId,
      isGroup,
      groupName: gName,
      contact: isGroup ? { name: gName || chatId, phone: null } : { name: senderName, phone },
      message: {
        externalId: typeof p.id === 'object' ? p.id?._serialized : p.id,
        text: p.body || (p.hasMedia ? '[mídia]' : ''),
        fromMe,
        senderName: fromMe ? 'Atendente (celular)' : senderName,
        mediaUrl: p.media?.url || null,
        timestamp: toMs(p.timestamp),
      },
    };
  },

  async send(conversation, text) {
    const res = await httpJson(`${config.waha.baseUrl}/api/sendText`, {
      method: 'POST',
      headers: headers(),
      body: { session: config.waha.session, chatId: conversation.external_id, text },
    });
    return { externalId: typeof res?.id === 'object' ? res.id?._serialized : res?.id ?? null };
  },
};
