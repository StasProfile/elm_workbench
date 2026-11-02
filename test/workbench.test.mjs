import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { ElmClient, ALLOWED_COMMANDS } from '../src/elm-client.mjs';
import { ReportStore } from '../src/report-store.mjs';
import { Workbench, validateEndpoint } from '../src/workbench.mjs';
import { createMockElm } from '../mock-elm.mjs';
import { createWorkbenchServer } from '../server.mjs';
import { zip } from '../src/zip.mjs';

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}
function temporary(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'r230-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
async function setup(t, scenario = 'normal') {
  const dir = mkdtempSync(path.join(tmpdir(), 'r230-test-')),
    mock = createMockElm({ scenario, delayMs: 1 }),
    port = await listen(mock.server);
  const store = new ReportStore(dir),
    bench = new Workbench(store, {
      settleMs: 1,
      gapMs: 0,
      client: new ElmClient({ timeout: 100 }),
    });
  t.after(async () => {
    bench.stop();
    if (bench.task) await bench.task;
    await mock.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { bench, store, mock, port, dir };
}

test('transport handles echo, fragmented CR/LF replies, unsupported commands and queue order', async (t) => {
  const { mock, port, bench } = await setup(t);
  const client = bench.client;
  await client.connect('127.0.0.1', port);
  const results = await Promise.all([
    client.send('ATI'),
    client.send('ATE0'),
    client.send('ATRV'),
    client.send('AT@2'),
  ]);
  assert.deepEqual(
    results.map((r) => r.lines),
    [['ELM327 v1.5'], ['OK'], ['12.6V'], ['?']],
  );
  assert.deepEqual(mock.received, ['ATI', 'ATE0', 'ATRV', 'AT@2']);
});

test('all ECU payloads, dangerous AT commands and newline injection are rejected before reaching the socket', async (t) => {
  const { mock, port, bench } = await setup(t);
  await bench.client.connect('127.0.0.1', port);
  for (const command of [
    '04',
    '14',
    '1101',
    '2E123400',
    '3101',
    '27',
    'A1',
    '22F190',
    '0100',
    'ATSH8122F2',
    'ATSP5',
    'ATPP00SVFF',
    'ATMA',
    'ATI\r04',
    'ATI\n04',
    '',
    '\r',
    'AT@3TEST',
  ]) {
    assert.throws(() => bench.client.send(command), /запрещена/);
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(mock.received, []);
});

test('timeout closes socket and does not repeat with bare CR or consume a late prompt', async (t) => {
  const { mock, port, bench } = await setup(t, 'no-prompt');
  await bench.client.connect('127.0.0.1', port);
  const first = bench.client.send('ATI', { timeout: 40 });
  const second = bench.client.send('ATRV');
  await assert.rejects(first, /Нет приглашения/);
  await assert.rejects(second, /не подключён/);
  assert.equal(bench.client.connected, false);
  assert.ok(
    bench.events.some(
      (e) => e.type === 'rx' && e.partial && e.raw.includes('ELM327'),
    ),
  );
  assert.deepEqual(mock.received, ['ATI']);
});

test('oversized adapter response closes transport', async (t) => {
  const server = net.createServer((socket) => {
    socket.on('error', () => {});
    socket.on('data', () => socket.write('X'.repeat(33000)));
  });
  const port = await listen(server),
    client = new ElmClient();
  t.after(() => {
    client.close();
    server.close();
  });
  await client.connect('127.0.0.1', port);
  await assert.rejects(client.send('ATI'), /длинный ответ/);
  assert.equal(client.connected, false);
});

test('complete adapter inspection persists truthful demo report and only allow-listed AT commands', async (t) => {
  const { bench, store, mock, port } = await setup(t);
  bench.start({ host: '127.0.0.1', port });
  await bench.task;
  const report = store.read(bench.report.id);
  assert.equal(report.status, 'adapter_checked');
  assert.equal(report.mode, 'mock');
  assert.equal(report.adapter.firmware, 'ELM327 v1.5');
  assert.equal(report.voltageSamples.length, 2);
  assert.equal(report.ecuRequestsSent, 0);
  assert.equal(report.capabilities.length, 3);
  assert.ok(
    report.capabilities.every((c) => c.accepted && c.vehicleTested === false),
  );
  assert.ok(report.systems.every((s) => s.diagnosticStatus === 'not_tested'));
  assert.ok(mock.received.every((c) => ALLOWED_COMMANDS.has(c)));
  assert.match(report.limitation, /НЕ считываются/);
  assert.ok(store.events(report.id).some((e) => e.type === 'rx' && e.raw));
  const before = mock.received.length;
  await bench.voltage();
  assert.equal(mock.received.length, before + 1);
  assert.equal(mock.received.at(-1), 'ATRV');
});

test('clones missing commands are recorded as unconfirmed, not vehicle faults', async (t) => {
  const { bench, store, port } = await setup(t, 'clone');
  bench.start({ host: '127.0.0.1', port });
  await bench.task;
  const report = store.read(bench.report.id);
  assert.equal(report.status, 'adapter_checked');
  assert.equal(
    report.capabilities.find((c) => c.name.includes('slow')).accepted,
    false,
  );
  assert.ok(report.systems.every((s) => s.diagnosticStatus === 'not_tested'));
});

test('connection loss produces a partial report and stops the command sequence', async (t) => {
  const { bench, store, port, mock } = await setup(t, 'disconnect');
  bench.start({ host: '127.0.0.1', port });
  await bench.task;
  assert.equal(store.read(bench.report.id).status, 'failed');
  assert.equal(mock.received.length, 8);
  assert.equal(bench.client.connected, false);
});

test('stop closes TCP and queued work; concurrent starts are rejected', async (t) => {
  const { bench, store, port } = await setup(t, 'slow');
  bench.start({ host: '127.0.0.1', port });
  assert.throws(() => bench.start({ host: '127.0.0.1', port }), /остановите/);
  await new Promise((resolve) => setTimeout(resolve, 20));
  bench.stop();
  await bench.task;
  assert.equal(store.read(bench.report.id).status, 'stopped');
  assert.equal(bench.client.connected, false);
});

test('endpoint validation refuses public IP, hostname, injection and invalid ports', () => {
  for (const [host, port] of [
    ['8.8.8.8', 35000],
    ['evil.example', 35000],
    ['127.0.0.1\rATI', 35000],
    ['192.168.1.999', 35000],
    ['192.168.0.10', 0],
    ['192.168.0.10', 1.2],
  ])
    assert.throws(() => validateEndpoint(host, port));
  assert.equal(validateEndpoint('192.168.0.10', 35000).mode, 'adapter');
  assert.equal(validateEndpoint('127.0.0.1', 35000).mode, 'mock');
});

test('notes and images persist across restart, and ZIP contains report, raw log and photos', async (t) => {
  const { bench, store, port, dir } = await setup(t);
  bench.start({ host: '127.0.0.1', port });
  await bench.task;
  const id = bench.report.id;
  bench.saveNotes(id, {
    vin: 'WDB2304751F000003',
    notes: 'Оба сиденья',
    systems: [
      {
        id: 'pse',
        observation: 'Замки работают',
        answers: { 'Центральный замок работает?': 'Да' },
        diagnosticStatus: 'healthy',
      },
    ],
  });
  const png =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII=';
  store.attach(bench.report, 'pse', {
    name: 'Фото.png',
    type: 'image/png',
    data: png,
  });
  const reopened = new ReportStore(dir).read(id);
  assert.equal(reopened.systems[0].observation, 'Замки работают');
  assert.equal(reopened.systems[0].diagnosticStatus, 'not_tested');
  assert.equal(reopened.vehicle.vin, 'WDB2304751F000003');
  assert.equal(reopened.systems[0].evidence.length, 1);
  const archive = zip(store.files(id));
  assert.equal(archive.readUInt32LE(0), 0x04034b50);
  assert.ok(archive.includes(Buffer.from('report.json')));
  assert.ok(archive.includes(Buffer.from('events.jsonl')));
  assert.ok(
    archive.includes(
      Buffer.from(`photos/${reopened.systems[0].evidence[0].filename}`),
    ),
  );
  assert.match(
    store
      .files(id)
      .find(([name]) => name === 'README.txt')[1]
      .toString(),
    /НЕ СЧИТЫВАЛИСЬ/,
  );
  assert.throws(() =>
    store.attach(bench.report, 'pse', {
      type: 'image/svg+xml',
      data: 'PHN2Zz4=',
    }),
  );
  assert.throws(() =>
    store.attach(bench.report, 'pse', {
      type: 'image/png',
      data: Buffer.from('not an image at all').toString('base64'),
    }),
  );
});

test('restart marks unfinished sessions interrupted without opening any adapter', (t) => {
  const store = new ReportStore(temporary(t));
  const report = store.create({
    mode: 'mock',
    endpoint: { host: '127.0.0.1', port: 35000 },
  });
  const bench = new Workbench(store);
  assert.equal(store.read(report.id).status, 'interrupted');
  assert.equal(bench.client.connected, false);
});

test('HTTP app serves local assets, rejects cross-origin and arbitrary commands, exports sessions', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'r230-test-')),
    mock = createMockElm({ delayMs: 1 }),
    mockPort = await listen(mock.server);
  const app = createWorkbenchServer({
    dataDir: dir,
    workbenchOptions: { gapMs: 0, settleMs: 1 },
  });
  const port = await listen(app.server),
    base = `http://127.0.0.1:${port}`;
  t.after(async () => {
    await app.close();
    await mock.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const initial = await (await fetch(`${base}/api/state`)).json();
  assert.ok(initial.token);
  assert.match(
    await (await fetch(base)).text(),
    /Кузовные блоки пока не опрашиваются/,
  );
  for (const asset of ['/app.js', '/style.css'])
    assert.equal((await fetch(base + asset)).status, 200);
  const post = (route, input = {}, headers = {}) =>
    fetch(base + route, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Workbench-Token': initial.token,
        ...headers,
      },
      body: JSON.stringify(input),
    });
  assert.equal(
    (
      await post(
        '/api/start',
        { host: '127.0.0.1', port: mockPort },
        { Origin: 'https://evil.example' },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(base + '/api/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
    ).status,
    403,
  );
  assert.equal((await post('/api/command', { command: '04' })).status, 404);
  assert.equal(
    (await post('/api/start', { host: '127.0.0.1', port: mockPort })).status,
    202,
  );
  await app.workbench.task;
  const report = app.workbench.report;
  assert.equal(
    (await post(`/api/reports/${report.id}/notes`, { notes: 'Проверка HTTP' }))
      .status,
    200,
  );
  const response = await fetch(`${base}/api/reports/${report.id}/zip`);
  assert.equal(response.headers.get('content-type'), 'application/zip');
  assert.ok(
    Buffer.from(await response.arrayBuffer()).includes(
      Buffer.from('Проверка HTTP'),
    ),
  );
  assert.match(
    readFileSync(path.join(dir, report.id, 'report.json'), 'utf8'),
    /Проверка HTTP/,
  );
});

test('bench context and private VIN default are preserved independently of synthetic adapter data', async (t) => {
  const { bench, store, dir, port } = await setup(t);
  writeFileSync(
    path.join(dir, 'vehicle.json'),
    JSON.stringify({ vin: 'WDB2304751F000003' }),
  );
  bench.start({ host: '127.0.0.1', port, environment: 'bench' });
  await bench.task;
  const report = store.read(bench.report.id);
  assert.equal(report.environment, 'bench');
  assert.equal(report.vehicle.vin, 'WDB2304751F000003');
  assert.equal(report.mode, 'mock');
  assert.equal(report.ecuRequestsSent, 0);
});
