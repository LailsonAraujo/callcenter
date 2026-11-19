// Relatórios de TME / TMA. Considera atendimentos ENCERRADOS no período (closed_at).
import { slaLimits } from './sla.js';

const GROUPS = {
  agent: { key: 'c.agent_id', label: "COALESCE(u.name, 'Sem atendente')" },
  channel: { key: 'c.channel', label: 'c.channel' },
  queue: { key: 'c.queue_id', label: "COALESCE(q.name, 'Sem fila')" },
  day: { key: "date(c.closed_at/1000, 'unixepoch', '-3 hours')", label: "date(c.closed_at/1000, 'unixepoch', '-3 hours')" },
  hour: { key: "strftime('%H', c.closed_at/1000, 'unixepoch', '-3 hours')", label: "strftime('%H', c.closed_at/1000, 'unixepoch', '-3 hours') || 'h'" },
};

function filters({ from, to, agentId, channel, queueId }) {
  const where = ["c.status = 'closed'", 'c.closed_at BETWEEN ? AND ?'];
  const params = [from, to];
  if (agentId) where.push('c.agent_id = ?'), params.push(agentId);
  if (channel) where.push('c.channel = ?'), params.push(channel);
  if (queueId) where.push('c.queue_id = ?'), params.push(queueId);
  return { where: where.join(' AND '), params };
}

export function slaReport(db, opts) {
  const group = GROUPS[opts.groupBy] || GROUPS.agent;
  const { where, params } = filters(opts);
  const lim = slaLimits(db).default;

  const metrics = `
    COUNT(*) AS total,
    ROUND(AVG((c.assigned_at - c.created_at) / 1000.0)) AS tme_avg_sec,
    ROUND(MAX(c.assigned_at - c.created_at) / 1000.0) AS tme_max_sec,
    ROUND(AVG((c.closed_at - c.assigned_at) / 1000.0)) AS tma_avg_sec,
    ROUND(MAX(c.closed_at - c.assigned_at) / 1000.0) AS tma_max_sec,
    ROUND(AVG(CASE WHEN c.first_response_at IS NOT NULL THEN (c.first_response_at - c.created_at) / 1000.0 END)) AS first_response_avg_sec,
    ROUND(100.0 * SUM(CASE WHEN (c.assigned_at - c.created_at) / 1000 <= COALESCE(q.tme_alert_sec, ${lim.tme}) THEN 1 ELSE 0 END) / COUNT(*), 1) AS tme_within_sla_pct,
    ROUND(100.0 * SUM(CASE WHEN (c.closed_at - c.assigned_at) / 1000 <= COALESCE(q.tma_alert_sec, ${lim.tma}) THEN 1 ELSE 0 END) / COUNT(*), 1) AS tma_within_sla_pct`;
  const from = `FROM conversations c LEFT JOIN users u ON u.id = c.agent_id LEFT JOIN queues q ON q.id = c.queue_id WHERE ${where}`;

  const totals = db.prepare(`SELECT ${metrics} ${from}`).get(...params);
  const rows = db.prepare(`SELECT ${group.label} AS grupo, ${metrics} ${from} GROUP BY ${group.key} ORDER BY grupo`).all(...params);
  const alerts = db.prepare(`SELECT a.type, a.level, COUNT(*) AS n FROM alerts a JOIN conversations c ON c.id = a.conversation_id
                             LEFT JOIN queues q ON q.id = c.queue_id WHERE ${where} GROUP BY a.type, a.level`).all(...params);
  return { period: { from: opts.from, to: opts.to }, groupBy: opts.groupBy || 'agent', limits: lim, totals, rows, alerts };
}

export function conversationsExport(db, opts) {
  const { where, params } = filters(opts);
  return db.prepare(`SELECT c.id, c.channel, CASE c.is_group WHEN 1 THEN 'sim' ELSE 'não' END AS grupo,
                        COALESCE(c.group_name, ct.name) AS contato, ct.phone AS telefone, ct.document AS documento,
                        u.name AS atendente, q.name AS fila,
                        datetime(c.created_at/1000, 'unixepoch', '-3 hours') AS entrada,
                        datetime(c.closed_at/1000, 'unixepoch', '-3 hours') AS encerramento,
                        (c.assigned_at - c.created_at) / 1000 AS tme_seg,
                        (c.closed_at - c.assigned_at) / 1000 AS tma_seg,
                        c.close_reason AS motivo_encerramento, c.summary AS resumo
                     FROM conversations c LEFT JOIN contacts ct ON ct.id = c.contact_id
                     LEFT JOIN users u ON u.id = c.agent_id LEFT JOIN queues q ON q.id = c.queue_id
                     WHERE ${where} ORDER BY c.closed_at`).all(...params);
}

export function toCsv(rows) {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const esc = (v) => (v == null ? '' : /[";\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  // ";" como separador: abre direto no Excel em pt-BR
  return '﻿' + [cols.join(';'), ...rows.map((r) => cols.map((c) => esc(r[c])).join(';'))].join('\n');
}
