import { config } from '../config.js';
import { waha } from './waha.js';
import { createGenericConnector } from './generic.js';

const opasuite = createGenericConnector({ channel: 'opasuite', label: 'OPA Suite', cfg: config.opasuite });
const chatmix = createGenericConnector({ channel: 'chatmix', label: 'Chatmix', cfg: config.chatmix });

export const connectors = { waha, opasuite, chatmix };

export function getConnector(channel) {
  const c = connectors[channel];
  if (!c) throw new Error(`Canal desconhecido: ${channel}`);
  return c;
}

export function enabledChannels() {
  return Object.entries(connectors)
    .filter(([k]) => config[k]?.enabled)
    .map(([k, c]) => ({ channel: k, label: c.label }));
}
