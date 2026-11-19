import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { hashPassword } from '../src/auth.js';
import { waha } from '../src/connectors/waha.js';
import { createGenericConnector } from '../src/connectors/generic.js';
import { createConversationService } from '../src/services/conversations.js';
import { checkSla } from '../src/services/sla.js';
import { slaReport, conversationsExport, toCsv } from '../src/services/reports.js';
import { config } from '../src/config.js';

// Simula as APIs externas (WAHA etc.)
const sent = [];
before(() => {
  globalThis.fetch = async (url, opts = {}) => {
    sent.push({ url: String(url), body: opts.body ? JSON.parse(opts.body) : null });
    const body = String(url).includes('/groups/') ? { subject: 'Grupo Suporte Condomínio' } : { id: `out-${sent.length}` };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
});

function setup() {
  const db = openDb(':memory:');
  db.prepare(`INSERT INTO queues (name, tme_alert_sec, tma_alert_sec) VALUES ('Geral', 60, 300)`).run();
  db.prepare(`INSERT INTO users (name, email, password_hash, role, status) VALUES ('Ana', 'ana@x', ?, 'agent', 'online')`).run(hashPassword('x'));
  const events = [];
  const service = createConversationService({
    db,
    emit: (e, d) => events.push({ e, d }),
    summarize: async (conv, msgs) => ({ summaryText: `Resumo de ${msgs.length} mensagens`, data: { categoria: 'suporte_tecnico' } }),
  });
  return { db, service, events, ana: { id: 1, name: 'Ana', role: 'agent' } };
}

const wahaGroupMsg = (id, body, ts = Math.floor(Date.now() / 1000)) => ({
  event: 'message',
  session: 'default',
  payload: { id, timestamp: ts, from: '120363000000000000@g.us', participant: '5511999990000@c.us', fromMe: false, body, _data: { notifyName: 'João' } },
});

test('WAHA: normaliza mensagem de grupo e ignora conversa individual quando groupsOnly', async () => {
  const evt = await waha.normalize(wahaGroupMsg('m1', 'Internet caiu'));
  assert.equal(evt.isGroup, true);
  assert.equal(evt.groupName, 'Grupo Suporte Condomínio');
  assert.equal(evt.message.senderName, 'João');
  assert.equal(evt.message.text, 'Internet caiu');

  config.waha.groupsOnly = true;
  const priv = await waha.normalize({ event: 'message', payload: { id: 'p', from: '5511888887777@c.us', body: 'oi' } });
  assert.equal(priv, null);
});

test('Conector genérico (Chatmix): usa o mapeamento de campos', async () => {
  const c = createGenericConnector({
    channel: 'opasuite', label: 'OPA Suite',
    cfg: { fields: { chatId: 'atd.id', messageId: 'msg.id', text: 'msg.txt', contactName: 'cli.nome', contactPhone: 'cli.fone', fromMe: 'msg.minha' } },
  });
  const evt = await c.normalize({ atd: { id: 77 }, msg: { id: 5, txt: 'Boleto', minha: false }, cli: { nome: 'Maria', fone: '(11) 98888-7777' } });
  assert.equal(evt.chatId, '77');
  assert.equal(evt.contact.phone, '11988887777');
  assert.equal(evt.message.fromMe, false);
});

test('Fluxo completo: entrada → distribuição automática → resposta → encerramento com resumo IA', async () => {
  const { db, service, ana } = setup();
  const evt = await waha.normalize(wahaGroupMsg('m1', 'Sem sinal no bloco B'));
  let conv = service.ingest(evt);
  assert.equal(conv.status, 'active', 'atribuída automaticamente à atendente online');
  assert.equal(conv.agent_id, 1);
  assert.equal(conv.is_group, 1);

  // Mensagem duplicada (reenvio do webhook) não duplica
  service.ingest(evt);
  assert.equal(service.messages(conv.id).filter((m) => m.direction === 'in').length, 1);

  await service.send(conv.id, ana, 'Verificando, um instante');
  assert.equal(sent.at(-1).body.chatId, '120363000000000000@g.us');
  conv = service.get(conv.id);
  assert.ok(conv.first_response_at);

  service.close(conv.id, ana, { reason: 'resolvido' });
  await new Promise((r) => setTimeout(r, 10)); // resumo em segundo plano
  conv = service.get(conv.id);
  assert.equal(conv.status, 'closed');
  assert.match(conv.summary, /Resumo de \d+ mensagens/);

  // Nova mensagem do mesmo grupo abre um novo atendimento
  const again = service.ingest(await waha.normalize(wahaGroupMsg('m9', 'Voltou a cair')));
  assert.notEqual(again.id, conv.id);
  db.close();
});

test('SLA: alerta de TME (aviso e estouro) e de TMA', () => {
  const { db, service, events } = setup();
  db.prepare(`UPDATE users SET status = 'offline'`).run(); // ninguém online -> fica na fila
  const now = Date.now();
  const conv = service.ingest({
    channel: 'chatmix', chatId: 'c1', isGroup: false, contact: { name: 'Pedro', phone: '1199' },
    message: { externalId: 'x1', text: 'oi', fromMe: false, timestamp: now - 50_000 },
  });
  assert.equal(conv.status, 'waiting');

  let fired = checkSla(db, () => {}, now); // 50s de 60s => aviso (>= 80%)
  assert.deepEqual(fired.map((a) => [a.type, a.level]), [['TME', 'warn']]);
  fired = checkSla(db, () => {}, now + 15_000); // 65s => estouro
  assert.deepEqual(fired.map((a) => [a.type, a.level]), [['TME', 'critical']]);
  assert.equal(checkSla(db, () => {}, now + 20_000).length, 0, 'não repete alerta');

  service.assign(conv.id, 1);
  db.prepare('UPDATE conversations SET assigned_at = ? WHERE id = ?').run(now - 400_000, conv.id);
  fired = checkSla(db, () => {}, now);
  assert.deepEqual(fired.map((a) => [a.type, a.level]), [['TMA', 'critical']]);
  db.close();
});

test('Relatório TME/TMA e exportação CSV', () => {
  const { db } = setup();
  const t0 = Date.now() - 3600_000;
  const ins = db.prepare(`INSERT INTO conversations (channel, external_id, agent_id, queue_id, status, created_at, assigned_at, first_response_at, closed_at, summary)
                          VALUES (?, ?, 1, 1, 'closed', ?, ?, ?, ?, ?)`);
  ins.run('waha', 'g1', t0, t0 + 30_000, t0 + 40_000, t0 + 230_000, 'Cliente sem sinal; resolvido');  // TME 30s, TMA 200s
  ins.run('opasuite', 'o1', t0, t0 + 90_000, t0 + 95_000, t0 + 490_000, 'Segunda via; ok');           // TME 90s, TMA 400s
  const r = slaReport(db, { from: t0 - 1, to: Date.now(), groupBy: 'channel' });
  assert.equal(r.totals.total, 2);
  assert.equal(r.totals.tme_avg_sec, 60);
  assert.equal(r.totals.tma_avg_sec, 300);
  assert.equal(r.totals.tme_within_sla_pct, 50); // limite da fila = 60s
  assert.equal(r.totals.tma_within_sla_pct, 50); // limite da fila = 300s
  assert.equal(r.rows.length, 2);

  const csv = toCsv(conversationsExport(db, { from: t0 - 1, to: Date.now() }));
  assert.match(csv, /tme_seg;tma_seg/);
  assert.match(csv, /Cliente sem sinal; resolvido/);
  db.close();
});

test('OPA Suite: polling cria o atendimento com mensagens do bot e do cliente, sem duplicar', async () => {
  const { createOpaPoller } = await import('../src/connectors/opasuite.js');
  const { db, service } = setup();
  db.prepare(`UPDATE users SET status = 'offline'`).run();
  const atd = { _id: 'atd1', status: 'EA', date: '2026-11-19T12:00:00.000Z', protocolo: 'OPA2026001' };
  // Formatos copiados dos exemplos da documentação oficial
  const msgs = [
    { _id: 'm1', id_rota: 'atd1', id_atend: 'bot', mensagem: 'Protocolo OPA2026001', tipoDestinatario: 'clientes_users', data: '2026-11-19T12:00:01.000Z' },
    { _id: 'm2', id_rota: 'atd1', id_user: 'u1', mensagem: 'Minha internet está lenta', tipo: 'texto', tipoDestinatario: 'usuarios', data: '2026-11-19T12:00:05.000Z' },
    { _id: 'm3', id_rota: 'atd1', id_atend: 'bot', mensagem: { titulo: 'Menu', opcoes: [{ id: '1', texto: 'Suporte' }] }, data: '2026-11-19T12:00:06.000Z' },
  ];
  const calls = [];
  const request = async (method, path, body) => {
    calls.push([method, path, body]);
    if (path === 'api/v1/atendimento') return [atd, { _id: 'velho', status: 'F' }];
    if (path === 'api/v1/atendimento/atd1') return { ...atd, id_cliente: { nome: 'João Santos', cpf_cnpj: '56982161005' }, id_user: { nome: 'João' } };
    if (path === 'api/v1/atendimento/mensagem') return msgs;
    throw new Error('rota inesperada ' + path);
  };
  const poller = createOpaPoller({ service, request, intervalSec: 3600, log: { error() {}, warn() {} } });
  await poller.tick();
  await poller.tick(); // sem mensagens novas: não reprocessa
  poller.stop();

  const conv = service.list({ user: { id: 1, role: 'admin' } })[0];
  assert.equal(conv.channel, 'opasuite');
  assert.equal(conv.external_id, 'atd1');
  assert.equal(conv.contact_name, 'João Santos');
  assert.equal(conv.created_at, Date.parse('2026-11-19T12:00:00.000Z'), 'TME conta da abertura no OPA');
  const ms = service.messages(conv.id);
  assert.deepEqual(ms.map((m) => m.direction), ['out', 'in', 'out']);
  assert.match(ms[2].body, /1\) Suporte/);
  assert.equal(calls.filter((c) => c[1] === 'api/v1/atendimento/mensagem').length, 2);
  assert.equal(calls.find((c) => c[1] === 'api/v1/atendimento/mensagem')[2].filter.id_rota, 'atd1');
  assert.ok(!calls.some((c) => c[1].includes('velho')), 'ignora atendimentos finalizados');
  assert.equal(db.prepare('SELECT document FROM contacts').get().document, '56982161005');
  db.close();
});

test('SGP: consulta por telefone (sem DDI) e normaliza contratos e títulos em aberto', async () => {
  const { sgp } = await import('../src/integrations/sgp.js');
  Object.assign(config.sgp, { enabled: true, baseUrl: 'https://sgp.exemplo', token: 'tk', app: 'central' });
  const forms = [];
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    forms.push([String(url), Object.fromEntries(opts.body.entries())]);
    const body = String(url).includes('consultacliente')
      ? { contratos: [{ clienteId: 2827, razaoSocial: 'RAZAO', cpfCnpj: '999.999.999-99', telefones: ['(42) 99999-9999'], emails: ['a@b.c'],
          contratoId: 10269, planointernet: 'Plano 150 Mega', contratoStatusDisplay: ' Ativo ', servico_tipo_conexao: 'PPPoE', endereco_logradouro: 'Rua X', endereco_numero: 1 }] }
      : { titulos: [{ id: 16085, status: 'aberto', valorCorrigido: 15, dataVencimento: '2026-02-16', codigoBarras: '9999', link: 'https://sgp/boleto/1' }] };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  try {
    const [c] = await sgp.search({ phone: '5542999999999' });
    assert.equal(forms[0][1].telefone, '42999999999');
    assert.equal(forms[0][1].token, 'tk');
    assert.deepEqual([forms[1][1].cliente_id, forms[1][1].status], ['2827', 'abertos']);
    assert.equal(c.name, 'RAZAO');
    assert.equal(c.active, true);
    assert.equal(c.contracts[0].plan, 'Plano 150 Mega');
    assert.equal(c.openInvoices[0].amount, 15);
    assert.equal(c.openInvoices[0].link, 'https://sgp/boleto/1');
  } finally {
    globalThis.fetch = prev;
  }
});
