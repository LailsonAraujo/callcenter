import { ixc } from './ixc.js';
import { sgp } from './sgp.js';

const providers = [ixc, sgp];

/** Consulta IXC e SGP em paralelo. Erros de um não derrubam o outro. */
export async function lookupCustomer({ document, phone }) {
  const active = providers.filter((p) => p.enabled());
  const results = await Promise.allSettled(active.map((p) => p.search({ document, phone })));
  const customers = [];
  const errors = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') customers.push(...r.value);
    else errors.push({ source: active[i].source, error: r.reason?.message || String(r.reason) });
  });
  return { customers, errors, sources: active.map((p) => p.source) };
}
