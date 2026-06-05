import * as http from 'http';
import { promises as fs } from 'fs';
import type { MeetingService } from './meeting';
import type { NudgeService } from './nudge';
import { fetchDashboardData } from './dashboard';

interface DashboardServerConfig {
  filePath: string;
  port: number;
  token: string | null;
  meetingService: MeetingService;
  nudgeService: NudgeService;
}

export function startDashboardServer(config: DashboardServerConfig): http.Server {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }

    if (req.method !== 'GET' || (url.pathname !== '/dashboard' && url.pathname !== '/dashboard.json')) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }

    if (config.token) {
      const provided = url.searchParams.get('token');
      if (provided !== config.token) {
        res.writeHead(401, { 'Content-Type': 'text/plain' });
        res.end('Unauthorized');
        return;
      }
    }

    if (url.pathname === '/dashboard.json') {
      try {
        const meetings = await fetchDashboardData(config.meetingService, config.nudgeService);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ generated_at: new Date().toISOString(), meetings }, null, 2));
      } catch (err: any) {
        console.error('[dashboard-server] json failed:', err?.message ?? err);
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal error');
      }
      return;
    }

    try {
      const html = await fs.readFile(config.filePath, 'utf8');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(html);
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Dashboard not generated yet. Run /ma set-action or wait for the scheduler.');
        return;
      }
      console.error('[dashboard-server] read failed:', err?.message ?? err);
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal error');
    }
  });

  server.listen(config.port, () => {
    console.log(`[dashboard-server] listening on :${config.port}`);
  });

  return server;
}
