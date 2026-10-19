import http from 'node:http';
import express from 'express';
import helmet from 'helmet';
import compression from 'compression';
import { config } from './config.js';
import { createWorld } from './world.js';
import { buildApi } from './api.js';
import { buildAdmin } from './admin.js';

// One tiny CORS gate per surface. The user app and the admin app are different origins, and each API only answers its own.
export const cors = (allowed) => (req, res, next) => {
  const o = req.headers.origin;
  if (o) {
    if (!allowed.includes(o)) return res.status(403).json({ error: 'forbidden_origin' });
    res.set({
      'Access-Control-Allow-Origin': o, Vary: 'Origin',
      'Access-Control-Allow-Headers': 'authorization,content-type',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
      'Access-Control-Max-Age': '600',
    });
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
};

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  const server = http.createServer(app);
  const world = createWorld(server);

  // This server only returns JSON, so the CSP is as strict as it gets.
  app.use(helmet({
    contentSecurityPolicy: { useDefaults: false, directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"], formAction: ["'none'"] } },
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    referrerPolicy: { policy: 'no-referrer' },
    hsts: config.isProd ? { maxAge: 31_536_000, includeSubDomains: true, preload: true } : false,
  }));
  app.use(compression());

  app.get('/healthz', (req, res) => res.type('text').send('ok'));
  app.use('/api', cors(config.webOrigins), buildApi(world));
  app.use('/admin-api', cors(config.adminOrigin ? [config.adminOrigin] : []), buildAdmin(world));
  app.use((req, res) => res.status(404).json({ error: 'not_found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error('[error]', req.method, req.path, err.message);
    if (res.headersSent) return;
    res.status(status >= 400 && status < 600 ? status : 500).json({ error: status === 413 ? 'too_large' : status < 500 ? 'bad_request' : 'server_error' });
  });
  return { app, server, world };
}
