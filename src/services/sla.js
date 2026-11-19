// Monitor de TME (tempo de espera na fila) e TMA (tempo de atendimento).
//   TME = assigned_at - created_at   (entrou na fila -> atendente assumiu)
//   TMA = closed_at  - assigned_at   (atendente assumiu -> encerrou)
// Gera alertas "warn" ao atingir SLA_WARN_RATIO do limite e "critical" ao estourar.
import { config } from '../config.js';

export function slaLimits(db) {
  const queues = db.prepare('SELECT id, name, tme_alert_sec, tma_alert_sec FROM queues').all();
  const byQueue = Object.fromEntries(queues.map((q) => [q.id, {
    tme: q.tme_alert_sec ?? config.sla.tmeAlertSec,
    tma: q.tma_alert_sec ?? config.sla.tmaAlertSec,
  }]));
  return { default: { tme: config.sla.tmeAlertSec, tma: config.sla.tmaAlertSec }, warnRatio: config.sla.warnRatio, byQueue };
}

export function checkSla(db, emit, now = Date.now()) {
  const limits = slaLimits(db);
  const lim = (qid) => limits.byQueue[qid] || limits.default;
  const insert = db.prepare(`INSERT OR IGNORE INTO alerts (conversation_id, type, level, elapsed_sec, created_at) VALUES (?, ?, ?, ?, ?)`);
  const open = db.prepare(`SELECT c.id, c.status, c.queue_id, c.agent_id, c.created_at, c.assigned_at,
                                  ct.name AS contact_name, c.group_name, c.channel, u.name AS agent_name
                           FROM conversations c
                           LEFT JOIN contacts ct ON ct.id = c.contact_id
                           LEFT JOIN users u ON u.id = c.agent_id
                           WHERE c.status IN ('waiting','active')`).all();
  const fired = [];

  for (const c of open) {
    const isWait = c.status === 'waiting';
    const type = isWait ? 'TME' : 'TMA';
    const start = isWait ? c.created_at : c.assigned_at;
    if (!start) continue;
    const elapsed = Math.floor((now - start) / 1000);
    const limit = isWait ? lim(c.queue_id).tme : lim(c.queue_id).tma;
    const level = elapsed >= limit ? 'critical' : elapsed >= limit * limits.warnRatio ? 'warn' : null;
    if (!level) continue;

    const levels = level === 'critical' ? ['warn', 'critical'] : ['warn'];
    for (const lv of levels) {
      if (insert.run(c.id, type, lv, elapsed, now).changes && lv === level) {
        const alert = {
          conversationId: c.id, type, level, elapsedSec: elapsed, limitSec: limit,
          contact: c.group_name || c.contact_name, channel: c.channel, agentName: c.agent_name, at: now,
        };
        fired.push(alert);
        emit('sla:alert', alert, c.agent_id ? ['supervisors', `agent:${c.agent_id}`] : ['staff']);
      }
    }
  }
  return fired;
}

export function startSlaMonitor(db, emit) {
  const t = setInterval(() => {
    try { checkSla(db, emit); } catch (e) { console.error('[SLA]', e); }
  }, config.sla.checkIntervalSec * 1000);
  t.unref();
  return () => clearInterval(t);
}
