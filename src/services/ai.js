// Registro de atendimento com IA: lê a conversa inteira e devolve um resumo estruturado.
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';

let client;
const getClient = () => (client ??= new Anthropic()); // lê ANTHROPIC_API_KEY do ambiente

const SCHEMA = {
  type: 'object',
  properties: {
    resumo: { type: 'string', description: 'Resumo objetivo do atendimento, 2 a 5 frases.' },
    motivo_contato: { type: 'string' },
    categoria: {
      type: 'string',
      enum: ['suporte_tecnico', 'financeiro', 'comercial', 'cancelamento', 'reclamacao', 'informacao', 'outro'],
    },
    acoes_realizadas: { type: 'array', items: { type: 'string' } },
    pendencias: { type: 'array', items: { type: 'string' } },
    resolvido: { type: 'boolean' },
    sentimento_cliente: { type: 'string', enum: ['positivo', 'neutro', 'negativo'] },
    dados_citados: {
      type: 'object',
      description: 'Dados mencionados na conversa (vazio quando não houver).',
      properties: {
        cpf_cnpj: { type: 'string' },
        protocolo: { type: 'string' },
        endereco: { type: 'string' },
      },
      required: ['cpf_cnpj', 'protocolo', 'endereco'],
      additionalProperties: false,
    },
  },
  required: ['resumo', 'motivo_contato', 'categoria', 'acoes_realizadas', 'pendencias', 'resolvido', 'sentimento_cliente', 'dados_citados'],
  additionalProperties: false,
};

const SYSTEM = `Você registra atendimentos de um call center de provedor de internet.
Recebe a transcrição completa de uma conversa (cliente, atendente, notas internas) e produz o registro do atendimento em português do Brasil.
Seja factual: registre apenas o que está na conversa, sem inventar dados. Campos de dados_citados sem informação ficam como string vazia.
Em conversas de grupo, identifique quem falou o quê quando for relevante.`;

function transcript(conversation, messages, customer) {
  const fmt = (ts) => new Date(ts).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const who = (m) => (m.direction === 'in' ? `CLIENTE (${m.sender_name || 'contato'})`
    : m.direction === 'note' ? `NOTA INTERNA (${m.sender_name})` : `ATENDENTE (${m.sender_name || ''})`);
  const lines = messages.map((m) => `[${fmt(m.created_at)}] ${who(m)}: ${m.body || ''}${m.media_url ? ' [anexo]' : ''}`);
  const header = [
    `Canal: ${conversation.channel}${conversation.is_group ? ` (grupo: ${conversation.group_name || conversation.external_id})` : ''}`,
    customer ? `Cliente no ERP: ${customer.name} — doc ${customer.document} (${customer.source})` : null,
  ].filter(Boolean).join('\n');
  return `${header}\n\n<transcricao>\n${lines.join('\n')}\n</transcricao>`;
}

/** Retorna { summaryText, data } ou lança erro. */
export async function summarizeConversation(conversation, messages, customer = null) {
  if (!config.ai.enabled) throw new Error('IA desabilitada (AI_ENABLED=false)');
  if (!messages.length) throw new Error('Conversa sem mensagens');
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) throw new Error('Configure ANTHROPIC_API_KEY no .env');

  const response = await getClient().beta.messages.create({
    model: config.ai.model,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default', // em recusa por política, reexecuta automaticamente em outro modelo
    output_config: { effort: config.ai.effort, format: { type: 'json_schema', schema: SCHEMA } },
    system: SYSTEM,
    messages: [{ role: 'user', content: transcript(conversation, messages, customer) }],
  });

  if (response.stop_reason === 'refusal') throw new Error('A IA recusou gerar o resumo');
  if (response.stop_reason === 'max_tokens') throw new Error('Resposta da IA truncada');
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const data = JSON.parse(text);
  return { summaryText: formatSummary(data), data };
}

export function formatSummary(d) {
  const list = (arr) => (arr?.length ? arr.map((x) => `- ${x}`).join('\n') : '- nenhuma');
  return [
    `Motivo: ${d.motivo_contato}`,
    `Categoria: ${d.categoria} | Resolvido: ${d.resolvido ? 'sim' : 'não'} | Sentimento: ${d.sentimento_cliente}`,
    '',
    d.resumo,
    '',
    'Ações realizadas:', list(d.acoes_realizadas),
    'Pendências:', list(d.pendencias),
  ].join('\n');
}

export function describeAiError(err) {
  if (err instanceof Anthropic.AuthenticationError) return 'Chave da API Anthropic inválida ou ausente';
  if (err instanceof Anthropic.RateLimitError) return 'Limite de requisições da IA atingido, tente novamente';
  if (err instanceof Anthropic.APIError) return `Erro da API de IA (${err.status}): ${err.message}`;
  return err?.message || String(err);
}
