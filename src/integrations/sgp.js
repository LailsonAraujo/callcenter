// SGP — API de URA (/api/ura/...). Autenticação por token + nome do app
// cadastrados no SGP (Sistema > Ferramentas > Painel Admin > Tokens).
// Os nomes dos campos de retorno variam entre versões do SGP: a normalização
// abaixo tenta as variações mais comuns e o objeto original segue em `raw`.
import { config } from '../config.js';

async function post(path, params) {
  const { baseUrl, token, app } = config.sgp;
  const form = new URLSearchParams({ token, app, ...params });
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}${path}`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`SGP HTTP ${res.status} em ${path}`);
  return res.json();
}

const pick = (o, ...keys) => keys.map((k) => o?.[k]).find((v) => v != null && v !== '');

export const sgp = {
  source: 'sgp',
  enabled: () => config.sgp.enabled && !!config.sgp.baseUrl,

  async search({ document, phone }) {
    const params = document
      ? { cpfcnpj: document.replace(/\D/g, '') }
      : { telefone: (phone || '').replace(/\D/g, '') };
    const data = await post('/api/ura/consultacliente/', params);
    const contratos = data?.contratos || [];
    if (!contratos.length) return [];

    // Agrupa contratos por cliente
    const byClient = new Map();
    for (const k of contratos) {
      const id = String(pick(k, 'clienteId', 'cliente_id', 'cpfCnpj') ?? 'sgp');
      if (!byClient.has(id)) byClient.set(id, { k, contratos: [] });
      byClient.get(id).contratos.push(k);
    }

    const titulos = await post('/api/ura/titulos/', params).then((d) => d?.titulos || []).catch(() => []);

    return [...byClient.entries()].map(([id, { k, contratos: ks }]) => ({
      source: 'sgp',
      id,
      name: pick(k, 'razaoSocial', 'nome', 'cliente'),
      document: pick(k, 'cpfCnpj', 'cpfcnpj'),
      phones: [pick(k, 'telefone', 'celular')].filter(Boolean),
      email: pick(k, 'email') || null,
      address: pick(k, 'endereco_logradouro', 'endereco', 'logradouro') || '',
      active: ks.some((c) => /ativo/i.test(pick(c, 'contratoStatusDisplay', 'status') || '')),
      contracts: ks.map((c) => ({
        id: String(pick(c, 'contratoId', 'contrato', 'id')),
        plan: pick(c, 'planointernet', 'plano', 'servico_plano'),
        status: pick(c, 'contratoStatusDisplay', 'status'),
        internetStatus: pick(c, 'conexaoStatus', 'status_conexao') || null,
      })),
      openInvoices: titulos.map((t) => ({
        id: String(pick(t, 'id', 'titulo')),
        dueDate: pick(t, 'dataVencimento', 'vencimento'),
        amount: Number(pick(t, 'valorCorrigido', 'valor') || 0),
        barcode: pick(t, 'linhaDigitavel', 'codigoBarras') || null,
      })),
      raw: k,
    }));
  },
};
