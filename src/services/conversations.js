// Núcleo do atendimento: entrada de mensagens de todos os canais, fila, distribuição,
// envio, transferência e encerramento com registro por IA.
import { getConnector } from '../connectors/index.js';
import { config } from '../config.js';
import { summarizeConversation, describeAiError } from './ai.js';

export function createConversationService({ db, emit, autoAssign = true, summarize = summarizeConversation }) {
  const q = {
    contactByKey: db.prepare('SELECT * FROM contacts WHERE external_key = ?'),
    insertContact: db.prepare('INSERT INTO contacts (external_key, name, phone) VALUES (?, ?, ?)'),
    updateContactName: db.prepare('UPDATE contacts SET name = ? WHERE id = ? AND (name IS NULL OR name = phone)'),
    openConv: db.prepare(`SELECT * FROM conversations WHERE channel = ? AND external_id = ? AND status != 'closed' ORDER BY id DESC LIMIT 1`),
    insertConv: db.prepare(`INSERT INTO conversations (channel, external_id, contact_id, is_group, group_name, queue_id, created_at)
                            VALUES (?, ?, ?, ?, ?, ?, ?)`),
    conv: db.prepare(`SELECT c.*, ct.name AS contact_name, ct.phone AS contact_phone, ct.document AS contact_document,
                             ct.erp_source, ct.erp_id, u.name AS agent_name, qu.name AS queue_name
                      FROM conversations c
                      LEFT JOIN contacts ct ON ct.id = c.contact_id
                      LEFT JOIN users u ON u.id = c.agent_id
                      LEFT JOIN queues qu ON qu.id = c.queue_id
                      WHERE c.id = ?`),
    insertMsg: db.prepare(`INSERT OR IGNORE INTO messages (conversation_id, direction, sender_name, body, media_url, external_id, created_at)
                           VALUES (?, ?, ?, ?, ?, ?, ?)`),
    msgs: db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at, id'),
    defaultQueue: db.prepare('SELECT id FROM queues ORDER BY id LIMIT 1'),
    user: db.prepare('SELECT id, name, role, status, max_concurrent FROM users WHERE id = ?'),
    freeAgent: db.prepare(`SELECT u.id, COUNT(c.id) AS load FROM users u
                           LEFT JOIN conversations c ON c.agent_id = u.id AND c.status = 'active'
                           WHERE u.status = 'online' AND u.role IN ('agent','supervisor')
                           GROUP BY u.id HAVING load < u.max_concurrent
                           ORDER BY load ASC, u.id ASC LIMIT 1`),
  };

  const get = (id) => q.conv.get(id);

  /** Devolve o registro ao sistema de origem, se o conector suportar (ex.: observação no OPA). */
  function exportSummary(conv, summary) {
    const connector = getConnector(conv.channel);
    if (!connector.onSummary || (conv.channel === 'opasuite' && !config.opasuite.writeSummary)) return;
    connector.onSummary(conv, summary).catch((e) => console.error(`[${conv.channel}] gravar resumo da conversa ${conv.id}:`, e.message));
  }
  const pushConv = (id) => {
    const c = get(id);
    emit('conversation:updated', c, c.agent_id ? ['supervisors', `agent:${c.agent_id}`, 'staff'] : ['staff']);
    return c;
  };
  const pushMsg = (conv, msg) => emit('message:new', { conversationId: conv.id, message: msg },
    conv.agent_id ? ['supervisors', `agent:${conv.agent_id}`] : ['staff']);

  function insertMessage(convId, m) {
    const info = q.insertMsg.run(convId, m.direction, m.senderName ?? null, m.text ?? '', m.mediaUrl ?? null,
      m.externalId ?? null, m.timestamp ?? Date.now());
    if (!info.changes) return null; // duplicada (mesmo external_id)
    return db.prepare('SELECT * FROM messages WHERE id = ?').get(info.lastInsertRowid);
  }

  function assign(convId, agentId) {
    const c = get(convId);
    if (!c) throw httpError(404, 'Conversa não encontrada');
    if (c.status === 'closed') throw httpError(409, 'Conversa já encerrada');
    const now = Date.now();
    db.prepare(`UPDATE conversations SET agent_id = ?, status = 'active', assigned_at = COALESCE(assigned_at, ?) WHERE id = ?`)
      .run(agentId, now, convId);
    insertMessage(convId, { direction: 'note', senderName: 'Sistema', text: `Atendimento assumido por ${q.user.get(agentId)?.name}`, timestamp: now });
    return pushConv(convId);
  }

  function tryAutoAssign(convId) {
    if (!autoAssign) return null;
    const agent = q.freeAgent.get();
    return agent ? assign(convId, agent.id) : null;
  }

  const api = {
    get,
    messages: (id) => q.msgs.all(id),

    /** Recebe um evento normalizado de qualquer conector. */
    ingest(evt) {
      const key = `${evt.channel}:${evt.chatId}`;
      let contact = q.contactByKey.get(key);
      if (!contact) {
        const r = q.insertContact.run(key, evt.contact.name ?? null, evt.contact.phone ?? null);
        contact = { id: r.lastInsertRowid };
        if (evt.contact.document) db.prepare('UPDATE contacts SET document = ? WHERE id = ?').run(evt.contact.document, contact.id);
      } else if (evt.contact.name) {
        q.updateContactName.run(evt.contact.name, contact.id);
      }

      let conv = q.openConv.get(evt.channel, evt.chatId);
      const m = evt.message;
      if (!conv) {
        if (m.fromMe && !evt.allowOpenFromMe) return null; // enviada por fora sem atendimento aberto: ignora
        const r = q.insertConv.run(evt.channel, evt.chatId, contact.id, evt.isGroup ? 1 : 0, evt.groupName ?? null,
          q.defaultQueue.get()?.id ?? null, evt.openedAt ?? m.timestamp ?? Date.now());
        conv = get(r.lastInsertRowid);
      } else if (evt.groupName && !conv.group_name) {
        db.prepare('UPDATE conversations SET group_name = ? WHERE id = ?').run(evt.groupName, conv.id);
      }

      const msg = insertMessage(conv.id, { ...m, direction: m.fromMe ? 'out' : 'in' });
      if (!msg) return get(conv.id);
      if (m.fromMe) {
        db.prepare('UPDATE conversations SET first_response_at = COALESCE(first_response_at, ?) WHERE id = ?').run(msg.created_at, conv.id);
      } else {
        db.prepare('UPDATE conversations SET unread = unread + 1 WHERE id = ?').run(conv.id);
      }
      conv = get(conv.id);
      pushMsg(conv, msg);
      if (conv.status === 'waiting' && !conv.agent_id) tryAutoAssign(conv.id);
      return pushConv(conv.id);
    },

    assign,
    tryAutoAssign,

    /** Distribui a fila para atendentes livres (chamado quando alguém fica online). */
    drainQueue() {
      const waiting = db.prepare(`SELECT id FROM conversations WHERE status = 'waiting' ORDER BY created_at`).all();
      for (const { id } of waiting) if (!tryAutoAssign(id)) break;
    },

    async send(convId, user, text) {
      const c = get(convId);
      if (!c) throw httpError(404, 'Conversa não encontrada');
      if (c.status === 'closed') throw httpError(409, 'Conversa encerrada');
      if (c.agent_id !== user.id && user.role === 'agent') throw httpError(403, 'Conversa de outro atendente');
      if (!c.agent_id) assign(convId, user.id);

      const { externalId } = await getConnector(c.channel).send(c, text);
      const now = Date.now();
      const msg = insertMessage(convId, { direction: 'out', senderName: user.name, text, externalId, timestamp: now });
      db.prepare('UPDATE conversations SET first_response_at = COALESCE(first_response_at, ?), unread = 0 WHERE id = ?').run(now, convId);
      const conv = get(convId);
      if (msg) pushMsg(conv, msg);
      pushConv(convId);
      return msg;
    },

    addNote(convId, user, text) {
      const conv = get(convId);
      if (!conv) throw httpError(404, 'Conversa não encontrada');
      const msg = insertMessage(convId, { direction: 'note', senderName: user.name, text, timestamp: Date.now() });
      pushMsg(conv, msg);
      return msg;
    },

    markRead(convId) {
      db.prepare('UPDATE conversations SET unread = 0 WHERE id = ?').run(convId);
      return pushConv(convId);
    },

    transfer(convId, user, { agentId, queueId }) {
      const c = get(convId);
      if (!c) throw httpError(404, 'Conversa não encontrada');
      if (agentId) {
        db.prepare('UPDATE conversations SET agent_id = ?, status = ? WHERE id = ?').run(agentId, 'active', convId);
        insertMessage(convId, { direction: 'note', senderName: user.name, text: `Transferido para ${q.user.get(agentId)?.name}`, timestamp: Date.now() });
      } else if (queueId) {
        // Volta para a fila; o TME original é mantido (assigned_at preservado)
        db.prepare(`UPDATE conversations SET agent_id = NULL, status = 'waiting', queue_id = ? WHERE id = ?`).run(queueId, convId);
        insertMessage(convId, { direction: 'note', senderName: user.name, text: 'Transferido para a fila', timestamp: Date.now() });
      }
      const conv = pushConv(convId);
      if (!agentId) tryAutoAssign(convId);
      return conv;
    },

    linkCustomer(convId, { document, erpSource, erpId, name }) {
      const c = get(convId);
      if (!c) throw httpError(404, 'Conversa não encontrada');
      db.prepare('UPDATE contacts SET document = ?, erp_source = ?, erp_id = ?, name = COALESCE(?, name) WHERE id = ?')
        .run(document ?? null, erpSource ?? null, erpId ?? null, name ?? null, c.contact_id);
      return pushConv(convId);
    },

    /** Gera (ou regenera) o resumo por IA sem encerrar. */
    async generateSummary(convId, customer = null) {
      const c = get(convId);
      if (!c) throw httpError(404, 'Conversa não encontrada');
      try {
        const { summaryText, data } = await summarize(c, q.msgs.all(convId), customer);
        db.prepare('UPDATE conversations SET summary = ?, ai_data = ? WHERE id = ?').run(summaryText, JSON.stringify(data), convId);
        if (c.status === 'closed') exportSummary(c, summaryText);
        return pushConv(convId);
      } catch (err) {
        throw httpError(502, `Falha ao gerar resumo: ${describeAiError(err)}`);
      }
    },

    saveSummary(convId, summary) {
      db.prepare('UPDATE conversations SET summary = ? WHERE id = ?').run(summary, convId);
      return pushConv(convId);
    },

    /** Encerra. Se não houver resumo, a IA gera em segundo plano. */
    close(convId, user, { reason, summary } = {}) {
      const c = get(convId);
      if (!c) throw httpError(404, 'Conversa não encontrada');
      if (c.status === 'closed') throw httpError(409, 'Conversa já encerrada');
      const now = Date.now();
      db.prepare(`UPDATE conversations SET status = 'closed', closed_at = ?, close_reason = ?,
                  assigned_at = COALESCE(assigned_at, ?), agent_id = COALESCE(agent_id, ?),
                  summary = COALESCE(?, summary) WHERE id = ?`)
        .run(now, reason ?? null, now, user.id, summary ?? null, convId);
      insertMessage(convId, { direction: 'note', senderName: user.name, text: `Atendimento encerrado${reason ? `: ${reason}` : ''}`, timestamp: now });
      const conv = pushConv(convId);
      if (conv.summary) exportSummary(conv, conv.summary);
      if (!conv.summary) {
        api.generateSummary(convId).catch((e) => {
          console.error(`[IA] conversa ${convId}:`, e.message);
          emit('summary:error', { conversationId: convId, error: e.message }, ['supervisors', `agent:${conv.agent_id}`]);
        });
      }
      return conv;
    },

    list({ user, status, mine }) {
      const where = [];
      const params = [];
      if (status) { where.push('c.status = ?'); params.push(status); }
      if (mine || user.role === 'agent') {
        where.push(`(c.agent_id = ? OR c.status = 'waiting')`);
        params.push(user.id);
      }
      if (!status) where.push(`(c.status != 'closed' OR c.closed_at > ?)`), params.push(Date.now() - 86400000);
      return db.prepare(`SELECT c.*, ct.name AS contact_name, ct.phone AS contact_phone, u.name AS agent_name,
                           (SELECT body FROM messages m WHERE m.conversation_id = c.id AND m.direction != 'note' ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_message
                         FROM conversations c
                         LEFT JOIN contacts ct ON ct.id = c.contact_id
                         LEFT JOIN users u ON u.id = c.agent_id
                         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                         ORDER BY c.status = 'closed', c.created_at DESC LIMIT 300`).all(...params);
    },
  };
  return api;
}

export function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}
