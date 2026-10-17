import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { repoRoot } from '@askdb/shared';
import { authenticate } from './auth';
import type { ApiDeps } from './deps';
import { errorHandler } from './http';
import { authRouter } from './routes/auth';
import { conversationsRouter } from './routes/conversations';
import { glossaryRouter } from './routes/glossary';
import { metaRouter } from './routes/meta';
import { runsRouter } from './routes/runs';

export function createApp(d: ApiDeps): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(
    pinoHttp({
      logger: d.log,
      autoLogging: { ignore: (req) => req.url === '/api/health' || req.url?.includes('/stream') === true },
      serializers: { req: (req) => ({ method: req.method, url: String(req.url).split('?')[0] }), res: (res) => ({ status: res.statusCode }) },
    }),
  );
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
          fontSrc: ["'self'", 'https://fonts.gstatic.com'],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
    }),
  );
  app.use(cors({ origin: d.cfg.CLIENT_ORIGIN, credentials: true }));
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());
  app.use(authenticate(d.db, d.cfg.JWT_SECRET));

  app.use('/api/auth', authRouter(d));
  app.use('/api', metaRouter(d));
  app.use('/api', conversationsRouter(d));
  app.use('/api', runsRouter(d));
  app.use('/api', glossaryRouter(d));
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // In production the API also serves the built web app (one deployable service).
  const dist = resolve(repoRoot, 'apps/web/dist');
  if (existsSync(dist)) {
    app.use(express.static(dist, { index: false, maxAge: '1h' }));
    app.get('/{*splat}', (_req, res) => {
      res.sendFile(resolve(dist, 'index.html'));
    });
  }

  app.use(errorHandler(d.log));
  return app;
}
