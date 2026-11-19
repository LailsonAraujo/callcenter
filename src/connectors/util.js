/** Lê um valor por caminho "a.b.c" (aceita índices: "itens.0.id"). */
export function getPath(obj, path) {
  if (!path) return undefined;
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/** Substitui {{var}} recursivamente num template de objeto JSON. */
export function fillTemplate(tpl, vars) {
  if (typeof tpl === 'string') {
    const whole = tpl.match(/^\{\{(\w+)\}\}$/);
    if (whole) return vars[whole[1]] ?? '';
    return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');
  }
  if (Array.isArray(tpl)) return tpl.map((v) => fillTemplate(v, vars));
  if (tpl && typeof tpl === 'object') {
    return Object.fromEntries(Object.entries(tpl).map(([k, v]) => [k, fillTemplate(v, vars)]));
  }
  return tpl;
}

export function toMs(ts) {
  if (ts == null || ts === '') return Date.now();
  if (typeof ts === 'number') return ts < 1e12 ? ts * 1000 : ts;
  if (/^\d+$/.test(String(ts))) return toMs(Number(ts));
  const d = Date.parse(ts);
  return Number.isNaN(d) ? Date.now() : d;
}

export function truthy(v) {
  return v === true || v === 1 || v === '1' || v === 'true' || v === 'S' || v === 's';
}

export async function httpJson(url, { method = 'GET', headers = {}, body, timeoutMs = 15000 } = {}) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} em ${url}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}
