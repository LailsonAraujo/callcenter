// Front-end da central de atendimento (sem build: JS puro + Socket.IO)
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDur = (sec) => {
  if (sec == null || Number.isNaN(sec)) return '—';
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(s).padStart(2, '0')}`;
};
const fmtTime = (ts) => new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
const CHANNEL = { waha: 'WhatsApp Grupos', opasuite: 'OPA Suite', chatmix: 'Chatmix' };

const state = { token: localStorage.getItem('token'), me: null, sla: null, convs: new Map(), tab: 'waiting', current: null, alerts: [] };

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${state.token}`, ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401 && path !== '/login') { logout(); throw new Error('Sessão expirada'); }
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error(data?.error || `Erro ${res.status}`);
  return data;
}

function toast(html, level = 'warn', onClick) {
  const el = document.createElement('div');
  el.className = `toast ${level}`;
  el.innerHTML = html;
  el.onclick = () => { onClick?.(); el.remove(); };
  $('#toasts').append(el);
  setTimeout(() => el.remove(), 10000);
}
const errToast = (e) => toast(`⚠️ ${esc(e.message)}`, 'critical');

function beep(critical) {
  try {
    const ctx = new AudioContext(); const o = ctx.createOscillator(); const g = ctx.createGain();
    o.frequency.value = critical ? 880 : 520; o.connect(g); g.connect(ctx.destination);
    g.gain.setValueAtTime(0.15, ctx.currentTime); o.start(); o.stop(ctx.currentTime + (critical ? 0.5 : 0.2));
  } catch { /* sem áudio */ }
}

// ---------- SLA ----------
function limitsFor(c) { return state.sla.byQueue[c.queue_id] || state.sla.default; }
function timerInfo(c) {
  if (c.status === 'waiting') return { label: 'TME', start: c.created_at, limit: limitsFor(c).tme };
  if (c.status === 'active') return { label: 'TMA', start: c.assigned_at, limit: limitsFor(c).tma };
  return { label: 'TMA', start: c.assigned_at, end: c.closed_at, limit: limitsFor(c).tma };
}
function timerHtml(c) {
  const t = timerInfo(c);
  return `<span class="timer" data-start="${t.start || ''}" data-end="${t.end || ''}" data-limit="${t.limit}" data-label="${t.label}"></span>`;
}
function tickTimers() {
  const now = Date.now();
  for (const el of $$('.timer')) {
    const start = Number(el.dataset.start); if (!start) { el.textContent = ''; continue; }
    const sec = ((Number(el.dataset.end) || now) - start) / 1000, limit = Number(el.dataset.limit);
    el.textContent = `${el.dataset.label} ${fmtDur(sec)}`;
    el.classList.toggle('crit', !el.dataset.end && sec >= limit);
    el.classList.toggle('warn', !el.dataset.end && sec < limit && sec >= limit * state.sla.warnRatio);
  }
}
setInterval(tickTimers, 1000);

// ---------- Login / sessão ----------
function logout() {
  localStorage.removeItem('token'); state.token = null; state.socket?.disconnect();
  $('#app').classList.add('hidden'); $('#login').classList.remove('hidden');
}
$('#logout').onclick = async () => { try { await api('/me/status', { method: 'POST', body: { status: 'offline' } }); } catch {} logout(); };
$('#loginForm').onsubmit = async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    const { token } = await api('/login', { method: 'POST', body: { email: f.get('email'), password: f.get('password') } });
    state.token = token; localStorage.setItem('token', token); start();
  } catch (err) { $('#loginError').textContent = err.message; }
};

async function start() {
  const me = await api('/me');
  state.me = me.user; state.sla = me.sla;
  $('#login').classList.add('hidden'); $('#app').classList.remove('hidden');
  $('#meName').textContent = state.me.name;
  $$('.sup').forEach((b) => b.classList.toggle('hidden', state.me.role === 'agent'));
  $('#statusSel').value = state.me.status;
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();

  connectSocket();
  await loadConvs();
  await loadAlerts();
}

function connectSocket() {
  const s = io({ auth: { token: state.token } });
  state.socket = s;
  s.on('connect_error', () => {});
  s.on('conversation:updated', (c) => {
    if (state.me.role === 'agent' && c.agent_id && c.agent_id !== state.me.id) state.convs.delete(c.id);
    else state.convs.set(c.id, { ...state.convs.get(c.id), ...c });
    if (state.current?.conversation.id === c.id) { state.current.conversation = c; renderHead(); if (c.summary && document.activeElement !== $('#summary')) $('#summary').value = c.summary; }
    renderList();
  });
  s.on('message:new', ({ conversationId, message }) => {
    const c = state.convs.get(conversationId);
    if (c && message.direction !== 'note') c.last_message = message.body;
    if (state.current?.conversation.id === conversationId) {
      if (!state.current.messages.some((m) => m.id === message.id)) { state.current.messages.push(message); renderMessages(); }
      if (message.direction === 'in' && document.hasFocus()) api(`/conversations/${conversationId}/read`, { method: 'POST' }).catch(() => {});
    }
    renderList();
  });
  s.on('sla:alert', (a) => {
    state.alerts.unshift(a); $('#alertCount').textContent = state.alerts.length;
    const msg = `${a.level === 'critical' ? '🚨' : '⏱️'} <b>${a.type} ${a.level === 'critical' ? 'estourado' : 'próximo do limite'}</b><br>${esc(a.contact)} — ${fmtDur(a.elapsedSec)} (limite ${fmtDur(a.limitSec)})${a.agentName ? `<br>Atendente: ${esc(a.agentName)}` : ''}`;
    toast(msg, a.level, () => openConv(a.conversationId));
    beep(a.level === 'critical');
    if (document.hidden && Notification.permission === 'granted') new Notification(`${a.type} ${a.level === 'critical' ? 'estourado' : 'em alerta'}`, { body: a.contact });
    if (!$('#view-dashboard').classList.contains('hidden')) loadDashboard();
  });
  s.on('summary:error', ({ conversationId, error }) => toast(`Resumo IA do atendimento #${conversationId} falhou: ${esc(error)}`, 'critical'));
  s.on('agent:status', () => { if (!$('#view-dashboard').classList.contains('hidden')) loadDashboard(); });
}

$('#statusSel').onchange = (e) => api('/me/status', { method: 'POST', body: { status: e.target.value } }).catch(errToast);

// ---------- Navegação ----------
$$('.topbar nav button').forEach((b) => (b.onclick = () => {
  $$('.topbar nav button').forEach((x) => x.classList.toggle('active', x === b));
  $$('.view').forEach((v) => v.classList.toggle('hidden', v.id !== `view-${b.dataset.view}`));
  if (b.dataset.view === 'dashboard') loadDashboard();
  if (b.dataset.view === 'reports') loadReport();
}));
$('#alertsBtn').onclick = () => (state.me.role === 'agent' ? showAlertsInline() : $('[data-view=dashboard]').click());

// ---------- Lista de atendimentos ----------
async function loadConvs() {
  const list = await api('/conversations');
  state.convs = new Map(list.map((c) => [c.id, c]));
  renderList();
}
$$('.tabs button').forEach((b) => (b.onclick = async () => {
  state.tab = b.dataset.tab; $$('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
  if (state.tab === 'closed') {
    const closed = await api('/conversations?status=closed');
    closed.forEach((c) => state.convs.set(c.id, c));
  }
  renderList();
}));
$('#search').oninput = renderList;

function convName(c) { return c.is_group ? `👥 ${c.group_name || c.external_id}` : c.contact_name || c.contact_phone || c.external_id; }

function renderList() {
  const term = $('#search').value.toLowerCase();
  const all = [...state.convs.values()];
  const mine = (c) => state.me.role === 'agent' ? c.agent_id === state.me.id : true;
  $('#cWaiting').textContent = all.filter((c) => c.status === 'waiting').length;
  $('#cActive').textContent = all.filter((c) => c.status === 'active' && mine(c)).length;
  const items = all
    .filter((c) => c.status === state.tab && (state.tab !== 'active' || mine(c)))
    .filter((c) => !term || convName(c).toLowerCase().includes(term))
    .sort((a, b) => state.tab === 'closed' ? b.closed_at - a.closed_at : a.created_at - b.created_at);
  $('#convList').innerHTML = items.map((c) => `
    <li data-id="${c.id}" class="${state.current?.conversation.id === c.id ? 'sel' : ''}">
      <span class="name">${esc(convName(c))}</span>${timerHtml(c)}
      <span class="last">${esc(c.last_message || '')}</span>
      <span>${c.unread ? `<span class="badge unread">${c.unread}</span>` : ''}</span>
      <span class="meta"><span class="badge">${CHANNEL[c.channel] || c.channel}</span> ${c.agent_name ? esc(c.agent_name) : ''}</span>
    </li>`).join('') || '<li class="meta">Nada por aqui</li>';
  $$('#convList li[data-id]').forEach((li) => (li.onclick = () => openConv(Number(li.dataset.id))));
  tickTimers();
}

// ---------- Conversa ----------
async function openConv(id) {
  $('[data-view=chat]').click();
  try {
    state.current = await api(`/conversations/${id}`);
  } catch (e) { return errToast(e); }
  const c = state.current.conversation;
  state.convs.set(c.id, { ...state.convs.get(c.id), ...c });
  $('#view-chat').classList.add('open');
  $('#conversation').innerHTML = `
    <div class="conv-head" id="convHead"></div>
    <div class="messages" id="messages"></div>
    <form class="composer" id="composer">
      <textarea rows="2" name="text" placeholder="Mensagem para o cliente (Enter envia, Shift+Enter quebra linha)"></textarea>
      <div style="display:grid;gap:4px">
        <button class="primary">Enviar</button>
        <button type="button" id="noteBtn" class="ghost" title="Nota interna (não vai ao cliente)">Nota</button>
      </div>
    </form>`;
  $('#side').classList.remove('hidden');
  $('#summary').value = c.summary || '';
  $('#customer').innerHTML = '';
  $('#lookupForm').q.value = c.contact_document || c.contact_phone || '';
  renderAiTags(state.current.ai);
  renderHead(); renderMessages(); renderList();
  if (c.unread) api(`/conversations/${id}/read`, { method: 'POST' }).catch(() => {});

  const form = $('#composer');
  form.text.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } };
  form.onsubmit = async (e) => {
    e.preventDefault(); const text = form.text.value.trim(); if (!text) return;
    form.text.value = '';
    try { await api(`/conversations/${id}/messages`, { method: 'POST', body: { text } }); } catch (err) { form.text.value = text; errToast(err); }
  };
  $('#noteBtn').onclick = async () => {
    const text = form.text.value.trim(); if (!text) return;
    form.text.value = '';
    await api(`/conversations/${id}/notes`, { method: 'POST', body: { text } }).catch(errToast);
  };
  if (c.contact_document || c.contact_phone) lookup(c.contact_document ? { document: c.contact_document } : { phone: c.contact_phone }, true);
}

function renderHead() {
  const c = state.current.conversation;
  const closed = c.status === 'closed';
  $('#convHead').innerHTML = `
    <button class="ghost" id="backBtn" title="Voltar">←</button>
    <div><div class="title">${esc(convName(c))}</div>
      <div class="meta">${CHANNEL[c.channel] || c.channel} · ${c.contact_phone ? esc(c.contact_phone) + ' · ' : ''}${c.agent_name ? 'Atendente: ' + esc(c.agent_name) : 'Na fila'}</div></div>
    ${timerHtml(c)}
    <div class="actions">
      ${c.status === 'waiting' ? '<button class="primary" id="assignBtn">Assumir</button>' : ''}
      ${!closed ? '<button id="transferBtn">Transferir</button><button class="danger" id="closeBtn">Encerrar</button>' : '<span class="badge">Encerrado</span>'}
    </div>`;
  $('#backBtn').onclick = () => $('#view-chat').classList.remove('open');
  $('#assignBtn') && ($('#assignBtn').onclick = () => api(`/conversations/${c.id}/assign`, { method: 'POST', body: {} }).catch(errToast));
  $('#transferBtn') && ($('#transferBtn').onclick = () => transfer(c));
  $('#closeBtn') && ($('#closeBtn').onclick = async () => {
    const reason = prompt('Motivo do encerramento (opcional):', '');
    if (reason === null) return;
    const summary = $('#summary').value.trim() || undefined;
    await api(`/conversations/${c.id}/close`, { method: 'POST', body: { reason, summary } })
      .then(() => toast(summary ? 'Atendimento encerrado.' : 'Atendimento encerrado. A IA está gerando o registro…', 'warn'))
      .catch(errToast);
  });
  tickTimers();
}

function renderMessages() {
  const box = $('#messages');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  box.innerHTML = state.current.messages.map((m) => `<div class="msg ${m.direction}">`
    + `<span class="who">${esc(m.sender_name || '')} · ${fmtTime(m.created_at)}</span><span class="body">${esc(m.body)}</span>`
    + (m.media_url ? `<a href="${esc(m.media_url)}" target="_blank" rel="noopener">📎 anexo</a>` : '') + '</div>').join('');
  if (atBottom || box.dataset.init !== '1') box.scrollTop = box.scrollHeight;
  box.dataset.init = '1';
}

async function transfer(c) {
  const [users, queues] = await Promise.all([api('/users'), api('/queues')]);
  const opts = [...users.filter((u) => u.id !== state.me.id).map((u) => `a${u.id}: ${u.name} (${u.status})`), ...queues.map((q) => `q${q.id}: Fila ${q.name}`)];
  const pick = prompt(`Transferir para (digite o código):\n${opts.join('\n')}`);
  if (!pick) return;
  const m = pick.trim().match(/^([aq])(\d+)/i);
  if (!m) return errToast(new Error('Código inválido'));
  await api(`/conversations/${c.id}/transfer`, { method: 'POST', body: m[1].toLowerCase() === 'a' ? { agentId: Number(m[2]) } : { queueId: Number(m[2]) } }).catch(errToast);
}

// ---------- Consulta IXC / SGP ----------
$('#lookupForm').onsubmit = (e) => {
  e.preventDefault();
  const v = e.target.q.value.replace(/\D/g, '');
  if (!v) return;
  lookup(v.length === 11 || v.length === 14 ? { document: v } : { phone: v });
};
async function lookup(params, silent = false) {
  $('#customer').innerHTML = '<p class="meta">Consultando…</p>';
  try {
    const r = await api(`/customers/lookup?${new URLSearchParams(params)}`);
    state.customers = r.customers;
    const errs = r.errors.map((x) => `<p class="error">${x.source.toUpperCase()}: ${esc(x.error)}</p>`).join('');
    if (!r.sources.length) return ($('#customer').innerHTML = '<p class="meta">IXC/SGP não configurados no .env</p>');
    $('#customer').innerHTML = errs + (r.customers.map((c, i) => `
      <div class="cust">
        <b>${esc(c.name)} <span class="badge">${c.source.toUpperCase()}</span> ${c.active ? '' : '<span class="badge">inativo</span>'}</b>
        ${esc(c.document || '')}<br>${esc(c.phones.join(' / '))}<br>${esc(c.address || '')}
        ${c.contracts.length ? `<ul>${c.contracts.map((k) => `<li>${esc(k.plan || 'Contrato ' + k.id)} — ${esc(k.status || '')}${k.internetStatus ? ' / ' + esc(k.internetStatus) : ''}</li>`).join('')}</ul>` : ''}
        ${c.openInvoices.length ? `<div class="error">${c.openInvoices.length} título(s) em aberto: ${c.openInvoices.map((t) => `${esc(t.dueDate)} R$ ${t.amount.toFixed(2)}${t.link ? ` <a href="${esc(t.link)}" target="_blank" rel="noopener">boleto</a>` : ''}`).join(', ')}</div>` : '<div class="meta">Sem títulos em aberto</div>'}
        <button data-link="${i}" class="ghost">Vincular ao atendimento</button>
      </div>`).join('') || (silent ? '' : '<p class="meta">Nenhum cliente encontrado</p>'));
    $$('[data-link]').forEach((b) => (b.onclick = () => {
      const c = state.customers[Number(b.dataset.link)];
      api(`/conversations/${state.current.conversation.id}/link-customer`, { method: 'POST', body: { document: c.document, erpSource: c.source, erpId: c.id, name: c.name } })
        .then(() => toast('Cliente vinculado', 'warn')).catch(errToast);
    }));
  } catch (e) { $('#customer').innerHTML = `<p class="error">${esc(e.message)}</p>`; }
}

// ---------- Resumo IA ----------
function renderAiTags(ai) {
  $('#aiTags').innerHTML = ai ? [ai.categoria, ai.resolvido ? 'resolvido' : 'não resolvido', `sentimento: ${ai.sentimento_cliente}`]
    .map((t) => `<span class="badge">${esc(t)}</span>`).join('') : '';
}
$('#genSummary').onclick = async () => {
  const b = $('#genSummary'); b.disabled = true; b.textContent = 'Gerando…';
  try {
    const customer = state.customers?.[0] || null;
    const c = await api(`/conversations/${state.current.conversation.id}/summary`, { method: 'POST', body: { customer } });
    $('#summary').value = c.summary || '';
    renderAiTags(c.ai_data ? JSON.parse(c.ai_data) : null);
  } catch (e) { errToast(e); } finally { b.disabled = false; b.textContent = 'Gerar resumo'; }
};
$('#saveSummary').onclick = () => api(`/conversations/${state.current.conversation.id}/summary`, { method: 'PUT', body: { summary: $('#summary').value } })
  .then(() => toast('Registro salvo', 'warn')).catch(errToast);

// ---------- Alertas ----------
async function loadAlerts() {
  state.alerts = await api('/alerts').catch(() => []);
  $('#alertCount').textContent = state.alerts.length;
}
function showAlertsInline() {
  if (!state.alerts.length) return toast('Nenhum alerta aberto');
  state.alerts.slice(0, 5).forEach((a) => toast(`${a.type} ${a.level} — ${esc(a.contact)}`, a.level, () => openConv(a.conversation_id || a.conversationId)));
}

// ---------- Painel ----------
const kpi = (v, l) => `<div class="kpi"><div class="v">${v}</div><div class="l">${l}</div></div>`;
async function loadDashboard() {
  const [d, alerts] = await Promise.all([api('/dashboard'), api('/alerts')]);
  state.alerts = alerts; $('#alertCount').textContent = alerts.length;
  const t = d.today;
  $('#kpis').innerHTML = [
    kpi(d.waiting.n, 'Na fila agora'),
    kpi(d.waiting.oldest ? fmtDur((Date.now() - d.waiting.oldest) / 1000) : '—', 'Maior espera atual'),
    kpi(d.active, 'Em atendimento'),
    kpi(t.total, 'Encerrados hoje'),
    kpi(fmtDur(t.tme_avg_sec), `TME hoje (meta ${fmtDur(state.sla.default.tme)})`),
    kpi(fmtDur(t.tma_avg_sec), `TMA hoje (meta ${fmtDur(state.sla.default.tma)})`),
    kpi(t.tme_within_sla_pct != null ? t.tme_within_sla_pct + '%' : '—', 'TME dentro do SLA'),
    kpi(t.tma_within_sla_pct != null ? t.tma_within_sla_pct + '%' : '—', 'TMA dentro do SLA'),
  ].join('');
  const st = { online: '🟢 Disponível', paused: '🟡 Pausa', offline: '⚪ Offline' };
  $('#agentsTable').innerHTML = '<tr><th>Atendente</th><th>Status</th><th class="num">Em atendimento</th><th class="num">Encerrados hoje</th></tr>' +
    d.agents.map((a) => `<tr><td>${esc(a.name)}</td><td>${st[a.status]}</td><td class="num">${a.active}/${a.max_concurrent}</td><td class="num">${a.closed_today}</td></tr>`).join('');
  $('#alertsList').innerHTML = alerts.map((a) => `<li class="${a.level}" data-id="${a.conversation_id}" data-alert="${a.id}">
      <b>${a.type} ${a.level === 'critical' ? 'estourado' : 'em alerta'}</b> — ${esc(a.contact)}<br>
      <span class="meta">${a.agent_name ? esc(a.agent_name) + ' · ' : 'fila · '}${fmtDur(a.elapsed_sec)} · ${fmtTime(a.created_at)}</span>
    </li>`).join('') || '<li>Nenhum alerta aberto</li>';
  $$('#alertsList li[data-id]').forEach((li) => (li.onclick = async () => {
    await api(`/alerts/${li.dataset.alert}/ack`, { method: 'POST' }).catch(() => {});
    openConv(Number(li.dataset.id));
  }));
}

// ---------- Relatórios ----------
const today = new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
$('#reportForm').from.value = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
$('#reportForm').to.value = today;
$('#reportForm').onsubmit = (e) => { e.preventDefault(); loadReport(); };
const reportQuery = () => new URLSearchParams(Object.fromEntries(new FormData($('#reportForm'))));
$('#csvBtn').onclick = async () => {
  const res = await fetch(`/api/reports/conversations.csv?${reportQuery()}`, { headers: { Authorization: `Bearer ${state.token}` } });
  const url = URL.createObjectURL(await res.blob());
  Object.assign(document.createElement('a'), { href: url, download: `atendimentos_${today}.csv` }).click();
  URL.revokeObjectURL(url);
};
async function loadReport() {
  const r = await api(`/reports/sla?${reportQuery()}`).catch(errToast);
  if (!r) return;
  const t = r.totals;
  const alertN = (type, lvl) => r.alerts.find((a) => a.type === type && a.level === lvl)?.n || 0;
  $('#reportKpis').innerHTML = [
    kpi(t.total, 'Atendimentos encerrados'),
    kpi(fmtDur(t.tme_avg_sec), 'TME médio'), kpi(fmtDur(t.tme_max_sec), 'TME máximo'),
    kpi(fmtDur(t.tma_avg_sec), 'TMA médio'), kpi(fmtDur(t.tma_max_sec), 'TMA máximo'),
    kpi(fmtDur(t.first_response_avg_sec), '1ª resposta média'),
    kpi((t.tme_within_sla_pct ?? '—') + '%', 'TME no SLA'), kpi((t.tma_within_sla_pct ?? '—') + '%', 'TMA no SLA'),
    kpi(alertN('TME', 'critical'), 'Estouros de TME'), kpi(alertN('TMA', 'critical'), 'Estouros de TMA'),
  ].join('');
  const head = { agent: 'Atendente', channel: 'Canal', queue: 'Fila', day: 'Dia', hour: 'Hora' }[r.groupBy];
  $('#reportTable').innerHTML = `<tr><th>${head}</th><th class="num">Atendimentos</th><th class="num">TME médio</th><th class="num">TME máx</th><th class="num">TME no SLA</th>
      <th class="num">TMA médio</th><th class="num">TMA máx</th><th class="num">TMA no SLA</th><th class="num">1ª resposta</th></tr>` +
    r.rows.map((x) => `<tr><td>${esc(r.groupBy === 'channel' ? CHANNEL[x.grupo] || x.grupo : x.grupo)}</td><td class="num">${x.total}</td>
      <td class="num">${fmtDur(x.tme_avg_sec)}</td><td class="num">${fmtDur(x.tme_max_sec)}</td><td class="num">${x.tme_within_sla_pct}%</td>
      <td class="num">${fmtDur(x.tma_avg_sec)}</td><td class="num">${fmtDur(x.tma_max_sec)}</td><td class="num">${x.tma_within_sla_pct}%</td>
      <td class="num">${fmtDur(x.first_response_avg_sec)}</td></tr>`).join('');
}

// ---------- Boot ----------
if (state.token) start().catch(logout); else logout();
