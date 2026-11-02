import http from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { ReportStore } from './src/report-store.mjs';
import { Workbench } from './src/workbench.mjs';
import { zip } from './src/zip.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);

function json(response, status, data) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(data));
}
async function body(request) {
  if (
    !String(request.headers['content-type'] || '').startsWith(
      'application/json',
    )
  )
    throw new Error('Нужен JSON');
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 8 * 1024 * 1024) throw new Error('Слишком большой запрос');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function createWorkbenchServer({
  dataDir = path.join(directory, 'data'),
  workbenchOptions,
} = {}) {
  const store = new ReportStore(dataDir),
    workbench = new Workbench(store, workbenchOptions);
  const token = randomBytes(24).toString('hex'),
    streams = new Set();
  const broadcast = (type, data) => {
    const message = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const stream of streams) if (!stream.write(message)) stream.destroy();
  };
  workbench.on('state', (data) => broadcast('state', data));
  workbench.on('event', (data) => broadcast('log', data));
  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    );
    const port = server.address()?.port;
    const origins = new Set([
      `http://127.0.0.1:${port}`,
      `http://localhost:${port}`,
    ]);
    if (
      !origins.has(`http://${request.headers.host}`) ||
      (request.headers.origin && !origins.has(request.headers.origin)) ||
      request.headers['sec-fetch-site'] === 'cross-site'
    ) {
      return json(response, 403, {
        error: 'Доступ разрешён только из локального интерфейса',
      });
    }
    const url = new URL(request.url, `http://127.0.0.1:${port}`);
    try {
      if (request.method === 'GET' && assets.has(url.pathname)) {
        const [file, contentType] = assets.get(url.pathname);
        response.writeHead(200, { 'Content-Type': contentType });
        return response.end(readFileSync(path.join(directory, 'public', file)));
      }
      if (request.method === 'GET' && url.pathname === '/api/state')
        return json(response, 200, { ...workbench.state(), token });
      if (request.method === 'GET' && url.pathname === '/api/events') {
        if (streams.size >= 8)
          return json(response, 429, {
            error: 'Слишком много открытых вкладок',
          });
        response.writeHead(200, {
          'Content-Type': 'text/event-stream',
          Connection: 'keep-alive',
        });
        response.write(
          `event: state\ndata: ${JSON.stringify(workbench.state())}\n\n`,
        );
        streams.add(response);
        const timer = setInterval(
          () => response.write(': keepalive\n\n'),
          15000,
        );
        request.on('close', () => {
          clearInterval(timer);
          streams.delete(response);
        });
        return;
      }
      const photoMatch = url.pathname.match(
        /^\/api\/reports\/([a-f0-9-]{36})\/photos\/([a-f0-9-]{36}\.(?:jpg|png|webp))$/,
      );
      if (request.method === 'GET' && photoMatch) {
        const [, id, filename] = photoMatch;
        const evidence = store
          .read(id)
          .systems.flatMap((s) => s.evidence)
          .find((e) => e.filename === filename);
        if (!evidence) return json(response, 404, { error: 'Фото не найдено' });
        response.writeHead(200, { 'Content-Type': evidence.type });
        return response.end(
          readFileSync(path.join(store.folder(id), filename)),
        );
      }
      const exportMatch = url.pathname.match(
        /^\/api\/reports\/([a-f0-9-]{36})\/(zip|json|text)$/,
      );
      if (request.method === 'GET' && exportMatch) {
        const [, id, format] = exportMatch;
        const report = store.read(id);
        if (format === 'zip') {
          response.writeHead(200, {
            'Content-Type': 'application/zip',
            'Content-Disposition': `attachment; filename="r230-${report.mode}-${id.slice(0, 8)}.zip"`,
          });
          return response.end(zip(store.files(id)));
        }
        if (format === 'text') {
          response.writeHead(200, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Content-Disposition': 'attachment; filename="r230-report.txt"',
          });
          return response.end(
            store.files(id).find(([name]) => name === 'README.txt')[1],
          );
        }
        response.setHeader(
          'Content-Disposition',
          'attachment; filename="r230-report.json"',
        );
        return json(response, 200, { ...report, events: store.events(id) });
      }
      if (request.method !== 'POST')
        return json(response, 404, { error: 'Не найдено' });
      const provided = Buffer.from(
        String(request.headers['x-workbench-token'] || ''),
      );
      const expected = Buffer.from(token);
      if (
        provided.length !== expected.length ||
        !timingSafeEqual(provided, expected)
      )
        return json(response, 403, {
          error: 'Обновите страницу локального интерфейса',
        });
      const input = await body(request);
      if (!input || typeof input !== 'object' || Array.isArray(input))
        throw new Error('Нужен объект JSON');
      if (url.pathname === '/api/start') {
        workbench.start(input);
        return json(response, 202, { started: true });
      }
      if (url.pathname === '/api/stop') {
        workbench.stop();
        return json(response, 200, { stopped: true });
      }
      if (url.pathname === '/api/voltage') {
        await workbench.voltage();
        return json(response, 200, { measured: true });
      }
      if (url.pathname === '/api/select') {
        workbench.select(String(input.id));
        return json(response, 200, { selected: true });
      }
      const noteMatch = url.pathname.match(
        /^\/api\/reports\/([a-f0-9-]{36})\/(notes|photo)$/,
      );
      if (noteMatch) {
        const [, id, action] = noteMatch;
        if (action === 'notes') workbench.saveNotes(id, input);
        else {
          const report =
            workbench.report?.id === id ? workbench.report : store.read(id);
          store.attach(report, input.systemId, input);
          workbench.publish();
        }
        return json(response, 200, { saved: true });
      }
      return json(response, 404, { error: 'Такой операции нет' });
    } catch (error) {
      return json(response, 400, { error: error.message });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.on('close', () => workbench.stop());
  return {
    server,
    workbench,
    store,
    close: async () => {
      workbench.stop();
      if (workbench.task) await workbench.task;
      for (const stream of streams) stream.end();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const port = Number(process.env.PORT || 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('Неверный PORT');
  const app = createWorkbenchServer();
  app.server.on('error', (error) => {
    console.error(`Не удалось запустить UI: ${error.message}`);
    process.exitCode = 1;
  });
  app.server.listen(port, '127.0.0.1', () => {
    console.log(`R230 Workbench: http://localhost:${port}`);
    console.log(
      'Локальный режим. Интернета и npm install не требуется. Выберите адаптер или mock в UI.',
    );
    console.log(
      'В этой версии нет запросов к ЭБУ. Отчёт содержит проверку адаптера и ваши наблюдения.',
    );
  });
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(signal, () => app.close().then(() => process.exit(0)));
}
