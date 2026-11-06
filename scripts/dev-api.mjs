// Runs the sync code API locally with in-memory storage. Data is lost when it stops.
import { createServer } from 'node:http';
import { createApi, createMemoryStorage } from '../server/lib/api.js';

const PORT = 4174;
const api = createApi({ storage: createMemoryStorage(), allowedOrigins: ['http://localhost:4173'] });

createServer(async (req, res) => {
  const name = new URL(req.url, `http://localhost:${PORT}`).pathname.replace(/^\/api\//, '');
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const response = await api.handle(new Request(`http://localhost:${PORT}${req.url}`, { method: req.method, headers: req.headers, body }), name);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(PORT, () => console.log(`Sync code API on http://localhost:${PORT}`));
