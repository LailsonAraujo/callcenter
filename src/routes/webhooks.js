import { Router } from 'express';
import { config } from '../config.js';
import { connectors } from '../connectors/index.js';

export function webhookRoutes({ service }) {
  const r = Router();

  r.post('/:channel', async (req, res) => {
    if (config.webhookToken && req.query.token !== config.webhookToken) return res.status(401).end();
    const connector = connectors[req.params.channel];
    if (!connector?.normalize || !config[req.params.channel]?.enabled) return res.status(404).json({ error: 'Canal não habilitado' });

    // Responde rápido para o sistema de origem não reenviar; processa em seguida.
    res.status(200).json({ ok: true });
    try {
      const events = Array.isArray(req.body) ? req.body : [req.body];
      for (const body of events) {
        const evt = await connector.normalize(body);
        if (evt) service.ingest(evt);
      }
    } catch (e) {
      console.error(`[webhook ${req.params.channel}]`, e);
    }
  });

  return r;
}
