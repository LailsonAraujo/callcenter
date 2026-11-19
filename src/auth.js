import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { config } from './config.js';

export const hashPassword = (p) => bcrypt.hashSync(p, 10);

export function login(db, email, password) {
  const u = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').toLowerCase());
  if (!u || !bcrypt.compareSync(password || '', u.password_hash)) return null;
  const user = { id: u.id, name: u.name, email: u.email, role: u.role };
  return { token: jwt.sign(user, config.jwtSecret, { expiresIn: '12h' }), user };
}

export function verifyToken(token) {
  try { return jwt.verify(token, config.jwtSecret); } catch { return null; }
}

export function requireAuth(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '') || req.query.access_token;
  const user = verifyToken(token);
  if (!user) return res.status(401).json({ error: 'Não autenticado' });
  req.user = user;
  next();
}

export const requireRole = (...roles) => (req, res, next) =>
  roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'Sem permissão' });
