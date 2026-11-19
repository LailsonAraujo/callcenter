// SGP — https://api.sgp.net.br (coleção Postman oficial), endpoints de URA.
//   POST {SGP_URL}/api/ura/consultacliente/  form-data: token, app, cpfcnpj | telefone | contrato ...
//   POST {SGP_URL}/api/ura/titulos/          form-data: token, app, cpfcnpj | cliente_id, status=abertos
// Autenticação: token + app (Sistema → Ferramentas → Painel Admin → Tokens)
// ou Basic Auth com usuário/senha do SGP (SGP_USER / SGP_PASSWORD).
import { config } from '../config.js';

async function post(path, params) {
  const { baseUrl, token, app, user, password } = config.sgp;
  const form = new FormData();
  if (token) { form.append('token', token); form.append('app', app); }
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') form.append(k, String(v));
  const headers = !token && user ? { Authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}` } : {};
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}${path}`, {
    method: 'POST', body: form, headers, signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`SGP HTTP ${res.status} em ${path}`);
  return res.json();
}

export const sgp = {
  source: 'sgp',
  enabled: () => config.sgp.enabled && !!config.sgp.baseUrl,

  async search({ document, phone }) {
    const params = document
      ? { cpfcnpj: document.replace(/\D/g, '') }
      : { telefone: (phone || '').replace(/\D/g, '').replace(/^55(?=\d{10,11}$)/, '') }; // tira o DDI do WhatsApp
    const data = await post('/api/ura/consultacliente/', params);
    const contratos = data?.contratos || [];
    if (!contratos.length) return [];

    // Um cliente pode ter vários contratos
    const byClient = new Map();
    for (const k of contratos) {
      const id = String(k.clienteId ?? k.cpfCnpj);
      if (!byClient.has(id)) byClient.set(id, []);
      byClient.get(id).push(k);
    }

    return Promise.all([...byClient.entries()].map(async ([id, ks]) => {
      const k = ks[0];
      const titulos = await post('/api/ura/titulos/', { cliente_id: k.clienteId, status: 'abertos' })
        .then((d) => d?.titulos || []).catch(() => []);
      return {
        source: 'sgp',
        id,
        name: k.razaoSocial,
        document: k.cpfCnpj,
        phones: [...new Set(ks.flatMap((c) => c.telefones || []))],
        email: (k.emails || [])[0] || null,
        address: [k.endereco_logradouro, k.endereco_numero, k.endereco_complemento, k.endereco_bairro, k.endereco_cidade].filter(Boolean).join(', '),
        active: ks.some((c) => /ativo/i.test(c.contratoStatusDisplay || '')),
        contracts: ks.map((c) => ({
          id: String(c.contratoId),
          plan: c.planointernet || c.servico_plano,
          status: (c.contratoStatusDisplay || '').trim(),
          internetStatus: [c.servico_tipo_conexao, c.servico_login && `login ${c.servico_login}`, c.popNome].filter(Boolean).join(' · '),
          openAmount: c.contratoValorAberto,
        })),
        openInvoices: titulos.map((t) => ({
          id: String(t.id),
          dueDate: t.dataVencimento,
          amount: Number(t.valorCorrigido ?? t.valor ?? 0),
          barcode: t.linhaDigitavel || t.codigoBarras || null,
          link: t.link || null,
          pix: t.codigoPix || null,
        })),
      };
    }));
  },
};
