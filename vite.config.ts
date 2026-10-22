import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, loadEnv, type Plugin } from 'vite';

const MAX_TRACE_BYTES = 64 * 2 ** 20;

/**
 * Dev-only sink for debug traces: the game POSTs to /__trace (F9) and the file
 * lands in traces/, where tools/trace-report.mjs and an agent can read it.
 */
function traceSink(key: string | undefined): Plugin {
  return {
    name: 'drift-trace-sink',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__trace', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end();
          return;
        }
        // Same-origin JSON only: requiring the JSON content type forces a CORS
        // preflight, so other sites can't post here while the dev server runs.
        const origin = req.headers.origin;
        if (!String(req.headers['content-type']).startsWith('application/json') || (origin && new URL(origin).host !== req.headers.host)) {
          res.statusCode = 403;
          res.end();
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        req.on('data', (c: Buffer) => {
          size += c.length;
          if (size > MAX_TRACE_BYTES) req.destroy();
          else chunks.push(c);
        });
        req.on('end', () => {
          try {
            let body = Buffer.concat(chunks).toString('utf8');
            JSON.parse(body);
            // Belt and braces: the client already redacts.
            if (key) body = body.split(key).join('REDACTED');
            body = body.replace(/AIza[0-9A-Za-z_-]{20,}/g, 'AIza…REDACTED');
            const url = new URL(req.url ?? '', 'http://x');
            const name = (url.searchParams.get('name') ?? '').replace(/[^\w.-]/g, '') || `drift-${Date.now()}`;
            const dir = resolve(server.config.root, 'traces');
            mkdirSync(dir, { recursive: true });
            // Never overwrite an earlier trace.
            let file = `${name}.json`;
            for (let i = 2; existsSync(resolve(dir, file)); i++) file = `${name}-${i}.json`;
            writeFileSync(resolve(dir, file), body, { flag: 'wx' });
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ file: `traces/${file}` }));
          } catch (err) {
            res.statusCode = 400;
            res.end(String(err));
          }
        });
      });
    },
  };
}

/**
 * Public path the build is served from. GitHub Pages serves a project site
 * under /<repo>/, so the deploy workflow passes configure-pages' base_path as
 * BASE_PATH ("/drift.earth", or "" for a custom domain). Vite wants leading
 * and trailing slashes; unset means the site root.
 */
function basePath(): string {
  const path = (process.env.BASE_PATH ?? '').replace(/^\/+|\/+$/g, '');
  return path ? `/${path}/` : '/';
}

// `.env` holds the key as MAPS_API_KEY; expose that prefix to client code
// alongside Vite's default VITE_ prefix. Whatever it holds is inlined into a
// production build, so CI builds without one (tools/check-no-key.mjs).
export default defineConfig(({ mode }) => ({
  base: basePath(),
  envPrefix: ['VITE_', 'MAPS_'],
  plugins: [traceSink(loadEnv(mode, process.cwd(), '').MAPS_API_KEY)],
  server: { watch: { ignored: ['**/traces/**'] } },
}));
