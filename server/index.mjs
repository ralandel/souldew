#!/usr/bin/env node
// Development entry point: `npm start` runs the server and opens the browser.
// The desktop app (electron/main.mjs) embeds the same server.
import { spawn } from 'node:child_process';
import { startServer } from './app.mjs';

const port = Number(process.env.PORT || 7373);
try {
  const { url, goOffline } = await startServer({ port });
  console.log(`\n  souldew is running at ${url}\n  (Ctrl+C stops the server)\n`);
  // Ctrl+C / kill: the souldew account says "offline" first (bounded), so friends don't see this computer for 3 minutes
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.once(sig, () => {
      const t = setTimeout(() => process.exit(0), 2000);
      goOffline().catch(() => {}).finally(() => {
        clearTimeout(t);
        process.exit(0);
      });
    });
  }
  if (!process.env.NO_OPEN) {
    const opener = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
    try {
      spawn(opener[0], opener[1], { detached: true, stdio: 'ignore' }).unref();
    } catch {
      // no browser opener
    }
  }
} catch (e) {
  if (e.code === 'EADDRINUSE') {
    console.log(`Port ${port} is taken – is souldew already running? Open http://localhost:${port}`);
    process.exit(1);
  }
  throw e;
}
