// IXC Soft — API webservice/v1. Autenticação Basic com "id_usuario:token"
// (gerado em Configurações > Usuários > Token). Cabeçalho "ixcsoft: listar" para consultas.
import { config } from '../config.js';
import { httpJson } from '../connectors/util.js';

function formatDoc(doc) {
  const d = doc.replace(/\D/g, '');
  if (d.length === 11) return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  if (d.length === 14) return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
  return doc;
}

async function list(table, qtype, query, oper = '=', rp = 20) {
  const { baseUrl, token } = config.ixc;
  const data = await httpJson(`${baseUrl.replace(/\/$/, '')}/webservice/v1/${table}`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(token).toString('base64')}`,
      ixcsoft: 'listar',
    },
    body: { qtype, query: String(query), oper, page: '1', rp: String(rp), sortname: `${table}.id`, sortorder: 'desc' },
  });
  return data?.registros || [];
}

export const ixc = {
  source: 'ixc',
  enabled: () => config.ixc.enabled && !!config.ixc.baseUrl,

  /** Busca por CPF/CNPJ ou telefone. Retorna lista de clientes normalizados. */
  async search({ document, phone }) {
    let clientes = [];
    if (document) clientes = await list('cliente', 'cliente.cnpj_cpf', formatDoc(document));
    else if (phone) {
      const p = phone.replace(/\D/g, '').slice(-8); // últimos 8 dígitos (tolera DDD/9º dígito)
      clientes = await list('cliente', 'cliente.telefone_celular', p, 'L');
      if (!clientes.length) clientes = await list('cliente', 'cliente.whatsapp', p, 'L');
    }
    return Promise.all(clientes.slice(0, 5).map((c) => this.details(c)));
  },

  async details(c) {
    const [contratos, titulos] = await Promise.all([
      list('cliente_contrato', 'cliente_contrato.id_cliente', c.id).catch(() => []),
      list('fn_areceber', 'fn_areceber.id_cliente', c.id, '=', 50).catch(() => []),
    ]);
    return {
      source: 'ixc',
      id: String(c.id),
      name: c.razao || c.fantasia,
      document: c.cnpj_cpf,
      phones: [c.telefone_celular, c.whatsapp, c.fone].filter(Boolean),
      email: c.email || null,
      address: [c.endereco, c.numero, c.bairro, c.complemento].filter(Boolean).join(', '),
      active: c.ativo === 'S',
      contracts: contratos.map((k) => ({
        id: String(k.id),
        plan: k.contrato || k.id_vd_contrato,
        status: k.status,
        internetStatus: k.status_internet,
      })),
      openInvoices: titulos
        .filter((t) => t.status === 'A')
        .map((t) => ({ id: String(t.id), dueDate: t.data_vencimento, amount: Number(t.valor), barcode: t.linha_digitavel || null })),
    };
  },
};
