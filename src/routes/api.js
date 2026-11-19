import { Router } from 'express';
import { login, requireAuth, requireRole, hashPassword } from '../auth.js';
import { enabledChannels } from '../connectors/index.js';
import { lookupCustomer } from '../integrations/index.js';
import { slaLimits } from '../services/sla.js';
import { slaReport, conversationsExport, toCsv } from '../services/reports.js';

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => {
    if (!e.status) console.error(e);
    res.status(e.status || 500).json({ error: e.message });
  });

function period(q) {
  const day = 86400000;
  const to = q.to ? Date.parse(`${q.to}T23:59:59-03:00`) : Date.now();
  const from = q.from ? Date.parse(`${q.from}T00:00:00-03:00`) : to - 7 * day;
  return { from, to, groupBy: q.groupBy, agentId: q.agentId ? Number(q.agentId) : null, channel: q.channel || null, queueId: q.queueId ? Number(q.queueId) : null };
}

export function apiRoutes({ db, service, emit }) {
  const r = Router();

  r.post('/login', wrap((req, res) => {
    const out = login(db, req.body.email, req.body.password);
    if (!out) return res.status(401).json({ error: 'E-mail ou senha inválidos' });
    res.json(out);
  }));

  r.use(requireAuth);

  r.get('/me', wrap((req, res) => {
    res.json({
      user: db.prepare('SELECT id, name, email, role, status, max_concurrent FROM users WHERE id = ?').get(req.user.id),
      channels: enabledChannels(),
      sla: slaLimits(db),
    });
  }));

  r.post('/me/status', wrap((req, res) => {
    const status = ['online', 'paused', 'offline'].includes(req.body.status) ? req.body.status : 'offline';
    db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, req.user.id);
    emit('agent:status', { id: req.user.id, status }, ['supervisors']);
    if (status === 'online') service.drainQueue();
    res.json({ status });
  }));

  // ---------- Atendimentos ----------
  r.get('/conversations', wrap((req, res) => {
    res.json(service.list({ user: req.user, status: req.query.status, mine: req.query.mine === '1' }));
  }));

  r.get('/conversations/:id', wrap((req, res) => {
    const c = service.get(Number(req.params.id));
    if (!c) return res.status(404).json({ error: 'Não encontrada' });
    if (req.user.role === 'agent' && c.agent_id && c.agent_id !== req.user.id) return res.status(403).json({ error: 'Conversa de outro atendente' });
    res.json({ conversation: c, messages: service.messages(c.id), ai: c.ai_data ? JSON.parse(c.ai_data) : null });
  }));

  r.post('/conversations/:id/assign', wrap((req, res) => {
    const agentId = req.user.role === 'agent' ? req.user.id : Number(req.body.agentId || req.user.id);
    res.json(service.assign(Number(req.params.id), agentId));
  }));
  r.post('/conversations/:id/messages', wrap(async (req, res) => {
    const text = String(req.body.text || '').trim();
    if (!text) return res.status(400).json({ error: 'Mensagem vazia' });
    res.json(await service.send(Number(req.params.id), req.user, text));
  }));
  r.post('/conversations/:id/notes', wrap((req, res) => res.json(service.addNote(Number(req.params.id), req.user, String(req.body.text || '')))));
  r.post('/conversations/:id/read', wrap((req, res) => res.json(service.markRead(Number(req.params.id)))));
  r.post('/conversations/:id/transfer', wrap((req, res) => res.json(service.transfer(Number(req.params.id), req.user, req.body))));
  r.post('/conversations/:id/link-customer', wrap((req, res) => res.json(service.linkCustomer(Number(req.params.id), req.body))));
  r.post('/conversations/:id/summary', wrap(async (req, res) => res.json(await service.generateSummary(Number(req.params.id), req.body.customer || null))));
  r.put('/conversations/:id/summary', wrap((req, res) => res.json(service.saveSummary(Number(req.params.id), String(req.body.summary || '')))));
  r.post('/conversations/:id/close', wrap((req, res) => res.json(service.close(Number(req.params.id), req.user, req.body))));

  // ---------- Consulta IXC / SGP ----------
  r.get('/customers/lookup', wrap(async (req, res) => {
    const { document, phone } = req.query;
    if (!document && !phone) return res.status(400).json({ error: 'Informe document ou phone' });
    res.json(await lookupCustomer({ document, phone }));
  }));

  // ---------- Alertas ----------
  r.get('/alerts', wrap((req, res) => {
    res.json(db.prepare(`SELECT a.*, c.status AS conversation_status, COALESCE(c.group_name, ct.name) AS contact, u.name AS agent_name
                         FROM alerts a JOIN conversations c ON c.id = a.conversation_id
                         LEFT JOIN contacts ct ON ct.id = c.contact_id LEFT JOIN users u ON u.id = c.agent_id
                         WHERE a.acked_by IS NULL
                           AND ((a.type = 'TME' AND c.status = 'waiting') OR (a.type = 'TMA' AND c.status = 'active'))
                           AND NOT (a.level = 'warn' AND EXISTS (SELECT 1 FROM alerts a2 WHERE a2.conversation_id = a.conversation_id AND a2.type = a.type AND a2.level = 'critical'))
                           ${req.user.role === 'agent' ? 'AND c.agent_id = ?' : ''}
                         ORDER BY a.created_at DESC LIMIT 100`).all(...(req.user.role === 'agent' ? [req.user.id] : [])));
  }));
  r.post('/alerts/:id/ack', wrap((req, res) => {
    db.prepare('UPDATE alerts SET acked_by = ? WHERE id = ?').run(req.user.id, Number(req.params.id));
    res.json({ ok: true });
  }));

  // ---------- Painel do supervisor ----------
  r.get('/dashboard', requireRole('supervisor', 'admin'), wrap((req, res) => {
    const now = Date.now();
    const startOfDay = Date.parse(new Date(now - 3 * 3600000).toISOString().slice(0, 10) + 'T00:00:00-03:00');
    res.json({
      agents: db.prepare(`SELECT u.id, u.name, u.status, u.max_concurrent,
                            (SELECT COUNT(*) FROM conversations c WHERE c.agent_id = u.id AND c.status = 'active') AS active,
                            (SELECT COUNT(*) FROM conversations c WHERE c.agent_id = u.id AND c.status = 'closed' AND c.closed_at >= ?) AS closed_today
                          FROM users u ORDER BY u.name`).all(startOfDay),
      waiting: db.prepare(`SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM conversations WHERE status = 'waiting'`).get(),
      active: db.prepare(`SELECT COUNT(*) AS n FROM conversations WHERE status = 'active'`).get().n,
      today: slaReport(db, { from: startOfDay, to: now }).totals,
      byChannel: db.prepare(`SELECT channel, status, COUNT(*) AS n FROM conversations WHERE status != 'closed' GROUP BY channel, status`).all(),
    });
  }));

  // ---------- Relatórios ----------
  r.get('/reports/sla', requireRole('supervisor', 'admin'), wrap((req, res) => res.json(slaReport(db, period(req.query)))));
  r.get('/reports/conversations.csv', requireRole('supervisor', 'admin'), wrap((req, res) => {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="atendimentos.csv"');
    res.send(toCsv(conversationsExport(db, period(req.query))));
  }));

  // ---------- Cadastros (admin) ----------
  r.get('/users', wrap((req, res) => res.json(db.prepare('SELECT id, name, email, role, status, max_concurrent FROM users ORDER BY name').all())));
  r.post('/users', requireRole('admin'), wrap((req, res) => {
    const { name, email, password, role = 'agent', max_concurrent = 5 } = req.body;
    const info = db.prepare('INSERT INTO users (name, email, password_hash, role, max_concurrent) VALUES (?, ?, ?, ?, ?)')
      .run(name, String(email).toLowerCase(), hashPassword(password), role, max_concurrent);
    res.json({ id: info.lastInsertRowid });
  }));
  r.get('/queues', wrap((req, res) => res.json(db.prepare('SELECT * FROM queues ORDER BY id').all())));
  r.post('/queues', requireRole('admin'), wrap((req, res) => {
    const { name, tme_alert_sec = null, tma_alert_sec = null } = req.body;
    res.json({ id: db.prepare('INSERT INTO queues (name, tme_alert_sec, tma_alert_sec) VALUES (?, ?, ?)').run(name, tme_alert_sec, tma_alert_sec).lastInsertRowid });
  }));
  r.put('/queues/:id', requireRole('admin'), wrap((req, res) => {
    const { name, tme_alert_sec = null, tma_alert_sec = null } = req.body;
    db.prepare('UPDATE queues SET name = COALESCE(?, name), tme_alert_sec = ?, tma_alert_sec = ? WHERE id = ?').run(name ?? null, tme_alert_sec, tma_alert_sec, Number(req.params.id));
    res.json({ ok: true });
  }));

  return r;
}
