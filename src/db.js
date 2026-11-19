import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

export function openDb(file = config.dbPath) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'agent',          -- agent | supervisor | admin
      status TEXT NOT NULL DEFAULT 'offline',      -- online | paused | offline
      max_concurrent INTEGER NOT NULL DEFAULT 5
    );
    CREATE TABLE IF NOT EXISTS queues (
      id INTEGER PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      tme_alert_sec INTEGER,                       -- NULL = usa padrão global
      tma_alert_sec INTEGER
    );
    CREATE TABLE IF NOT EXISTS contacts (
      id INTEGER PRIMARY KEY,
      external_key TEXT UNIQUE NOT NULL,           -- "canal:chatId"
      name TEXT,
      phone TEXT,
      document TEXT,                               -- CPF/CNPJ
      erp_source TEXT,                             -- ixc | sgp
      erp_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_contacts_phone ON contacts(phone);
    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY,
      channel TEXT NOT NULL,                       -- waha | opasuite | chatmix
      external_id TEXT NOT NULL,                   -- id do chat no sistema de origem
      contact_id INTEGER REFERENCES contacts(id),
      is_group INTEGER NOT NULL DEFAULT 0,
      group_name TEXT,
      queue_id INTEGER REFERENCES queues(id),
      agent_id INTEGER REFERENCES users(id),
      status TEXT NOT NULL DEFAULT 'waiting',      -- waiting | active | closed
      created_at INTEGER NOT NULL,                 -- epoch ms: entrada na fila
      assigned_at INTEGER,                         -- atendente assumiu (fim do TME)
      first_response_at INTEGER,
      closed_at INTEGER,                           -- fim do TMA
      unread INTEGER NOT NULL DEFAULT 0,
      summary TEXT,                                -- resumo da IA (editável)
      ai_data TEXT,                                -- JSON completo retornado pela IA
      close_reason TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_conv_open ON conversations(channel, external_id, status);
    CREATE INDEX IF NOT EXISTS idx_conv_closed ON conversations(closed_at);
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id),
      direction TEXT NOT NULL,                     -- in | out | note
      sender_name TEXT,
      body TEXT,
      media_url TEXT,
      external_id TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE(conversation_id, external_id)
    );
    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id),
      type TEXT NOT NULL,                          -- TME | TMA
      level TEXT NOT NULL,                         -- warn | critical
      elapsed_sec INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      acked_by INTEGER REFERENCES users(id),
      UNIQUE(conversation_id, type, level)
    );
  `);
  return db;
}
