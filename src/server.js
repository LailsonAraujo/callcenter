import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import { config } from './config.js';
import { openDb } from './db.js';
import { verifyToken, hashPassword } from './auth.js';
import { createConversationService } from './services/conversations.js';
import { startSlaMonitor } from './services/sla.js';
import { apiRoutes } from './routes/api.js';
import { webhookRoutes } from './routes/webhooks.js';
import { enabledChannels } from './connectors/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export function createApp({ db = openDb(), autoAssign = process.env.AUTO_ASSIGN !== 'false', summarize } = {}) {
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server);

  const emit = (event, data, rooms = ['staff']) => {
    let target = io;
    for (const room of rooms) target = target.to(room);
    target.emit(event, data);
  };

  // Primeiro acesso: cria admin e fila padrão
  if (!db.prepare('SELECT 1 FROM users LIMIT 1').get()) {
    db.prepare(`INSERT INTO users (name, email, password_hash, role) VALUES ('Administrador', 'admin@local', ?, 'admin')`).run(hashPassword('admin123'));
    console.log('Usuário inicial criado: admin@local / admin123 (troque a senha)');
  }
  if (!db.prepare('SELECT 1 FROM queues LIMIT 1').get()) db.prepare(`INSERT INTO queues (name) VALUES ('Geral')`).run();

  const service = createConversationService({ db, emit, autoAssign, ...(summarize ? { summarize } : {}) });

  app.use(express.json({ limit: '5mb' }));
  app.use('/webhooks', webhookRoutes({ service }));
  app.use('/api', apiRoutes({ db, service, emit }));
  app.use(express.static(path.join(here, '..', 'public')));

  io.use((socket, next) => {
    const user = verifyToken(socket.handshake.auth?.token);
    if (!user) return next(new Error('unauthorized'));
    socket.data.user = user;
    next();
  });
  io.on('connection', (socket) => {
    const u = socket.data.user;
    socket.join('staff');
    socket.join(`agent:${u.id}`);
    if (u.role !== 'agent') socket.join('supervisors');
    socket.on('disconnect', async () => {
      const still = (await io.in(`agent:${u.id}`).fetchSockets()).length;
      if (!still) {
        db.prepare(`UPDATE users SET status = 'offline' WHERE id = ? AND status != 'offline'`).run(u.id);
        emit('agent:status', { id: u.id, status: 'offline' }, ['supervisors']);
      }
    });
  });

  const stopSla = startSlaMonitor(db, emit);
  return { app, server, io, db, service, stop: () => { stopSla(); io.close(); server.close(); } };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { server } = createApp();
  server.listen(config.port, () => {
    console.log(`Central de atendimento em ${config.publicUrl} (porta ${config.port})`);
    console.log('Canais ativos:', enabledChannels().map((c) => c.label).join(', ') || 'nenhum (configure o .env)');
  });
}
