// OPA Suite — https://api.opasuite.com.br (coleção Postman oficial)
// A API do OPA não oferece webhook: as mensagens são buscadas por polling.
//   GET  {OPA_URL}/api/v1/atendimento                 (filtros no corpo, mesmo sendo GET)
//   GET  {OPA_URL}/api/v1/atendimento/:id             (atendimento "populado": nome/CPF do cliente)
//   GET  {OPA_URL}/api/v1/atendimento/mensagem        (filter.id_rota = id do atendimento)
//   POST {OPA_URL}/api/v1/atendimento/mensagem/send   { customerServiceId, content: { type: 'text', text } }
//   POST {OPA_URL}/api/v1/atendimento/:id/observacao  { message }
// Autenticação: Authorization: Bearer <token> (usuário com perfil de permissões do tipo API).
import http from 'node:http';
import https from 'node:https';
import { config } from '../config.js';
import { toMs } from './util.js';

/** O OPA usa GET com corpo JSON, que o fetch nativo não permite. */
export function opaRequest(method, path, body) {
  const url = new URL(path, config.opasuite.baseUrl.replace(/\/?$/, '/'));
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const lib = url.protocol === 'http:' ? http : https;
  return new Promise((resolve, reject) => {
    const req = lib.request(url, {
      method,
      timeout: 15000,
      headers: {
        Authorization: `Bearer ${config.opasuite.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        let data;
        try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
        if (res.statusCode >= 400 || data?.status === 'error') {
          const e = new Error(`OPA HTTP ${res.statusCode} em ${url.pathname}: ${data?.message || data?.error || ''}`.trim());
          e.status = res.statusCode;
          return reject(e);
        }
        resolve(data?.data ?? data);
      });
    });
    req.on('timeout', () => req.destroy(new Error(`OPA: tempo esgotado em ${url.pathname}`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function messageText(m) {
  const v = m.mensagem;
  if (v == null) return m.objeto ? '[anexo]' : '';
  if (typeof v === 'string') return v;
  if (v.titulo || v.opcoes) return [v.titulo, ...(v.opcoes || []).map((o) => `${o.id}) ${o.texto}`)].filter(Boolean).join('\n');
  return v.texto || v.text || JSON.stringify(v);
}

/** Mensagem do atendente/bot: tem id_atend ou é destinada ao cliente. */
const isFromAgent = (m) => !!m.id_atend || m.tipoDestinatario === 'clientes_users';

export const opasuite = {
  channel: 'opasuite',
  label: 'OPA Suite',

  async send(conversation, text) {
    const id = await opaRequest('POST', 'api/v1/atendimento/mensagem/send', {
      customerServiceId: conversation.external_id,
      content: { type: 'text', text },
    });
    return { externalId: typeof id === 'string' ? id : id?._id ?? null };
  },

  /** Grava o registro da IA como observação no atendimento do OPA. */
  async onSummary(conversation, summary) {
    await opaRequest('POST', `api/v1/atendimento/${conversation.external_id}/observacao`, { message: summary });
  },
};

/**
 * Busca atendimentos abertos e mensagens novas do OPA e entrega ao serviço.
 * `request` é injetável para testes.
 */
export function createOpaPoller({ service, request = opaRequest, intervalSec = config.opasuite.pollSec, log = console }) {
  const known = new Map(); // id do atendimento -> { name, phone, document, openedAt, lastCount }
  let running = false;

  async function details(atd) {
    if (known.has(atd._id)) return known.get(atd._id);
    let full = atd;
    try { full = await request('GET', `api/v1/atendimento/${atd._id}`); } catch (e) { log.warn?.(`[OPA] detalhe ${atd._id}: ${e.message}`); }
    const cliente = typeof full.id_cliente === 'object' ? full.id_cliente : null;
    const user = typeof full.id_user === 'object' ? full.id_user : null;
    const info = {
      name: cliente?.nome || user?.nome || full.protocolo || atd._id,
      phone: (user?.telefone || user?.celular || '').replace(/\D/g, '') || null,
      document: cliente?.cpf_cnpj || null,
      protocol: full.protocolo,
      openedAt: toMs(full.date || atd.date),
      lastCount: 0,
    };
    known.set(atd._id, info);
    return info;
  }

  async function tick() {
    if (running) return; // evita sobreposição se o OPA estiver lento
    running = true;
    try {
      const since = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
      const list = await request('GET', 'api/v1/atendimento', { filter: { dataInicialAbertura: since }, options: { limit: 500 } });
      const open = (list || []).filter((a) => a.status !== 'F');
      for (const atd of open) {
        const info = await details(atd);
        const msgs = await request('GET', 'api/v1/atendimento/mensagem', { filter: { id_rota: atd._id }, options: { limit: 1000 } });
        if (!msgs?.length || msgs.length === info.lastCount) continue;
        info.lastCount = msgs.length;
        msgs.sort((a, b) => toMs(a.data || a.createdAt) - toMs(b.data || b.createdAt));
        for (const m of msgs) {
          const fromMe = isFromAgent(m);
          service.ingest({
            channel: 'opasuite',
            chatId: atd._id,
            isGroup: false,
            groupName: null,
            openedAt: info.openedAt,
            allowOpenFromMe: true, // mensagens do bot (ex.: protocolo) também entram no histórico
            contact: { name: info.name, phone: info.phone, document: info.document },
            message: {
              externalId: m._id,
              text: messageText(m),
              fromMe,
              senderName: fromMe ? 'OPA Suite' : info.name,
              mediaUrl: m.objeto?.url || null,
              timestamp: toMs(m.data || m.createdAt),
            },
          });
        }
      }
      // Esquece atendimentos que saíram da lista de abertos
      const openIds = new Set(open.map((a) => a._id));
      for (const id of known.keys()) if (!openIds.has(id)) known.delete(id);
    } catch (e) {
      log.error?.(`[OPA] polling: ${e.message}`);
    } finally {
      running = false;
    }
  }

  const t = setInterval(tick, intervalSec * 1000);
  t.unref?.();
  return { tick, stop: () => clearInterval(t) };
}
