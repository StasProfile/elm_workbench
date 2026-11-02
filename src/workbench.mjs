import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { ElmClient } from './elm-client.mjs';
import { STEPS, SYSTEMS, VEHICLE, SOURCES, LIMITATION } from './profile.mjs';

export function validateEndpoint(host, port) {
  if (
    typeof host !== 'string' ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  )
    throw new Error('Укажите IP и порт адаптера');
  const parts = host.split('.').map(Number);
  if (
    !/^\d{1,3}(\.\d{1,3}){3}$/.test(host) ||
    parts.some((p) => p < 0 || p > 255)
  )
    throw new Error('Нужен IPv4-адрес адаптера');
  const local = parts[0] === 127;
  const privateIp =
    parts[0] === 10 ||
    (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31);
  if (!local && !privateIp)
    throw new Error('Разрешены только локальные и частные IP-адреса');
  return { host, port, mode: local ? 'mock' : 'adapter' };
}

export class Workbench extends EventEmitter {
  constructor(store, { settleMs, gapMs = 100, client = new ElmClient() } = {}) {
    super();
    this.store = store;
    this.client = client;
    this.settleMs = settleMs;
    this.gapMs = gapMs;
    this.report = null;
    this.running = false;
    this.busy = false;
    this.stopped = false;
    this.events = [];
    this.progress = {
      current: 0,
      total: STEPS.length,
      title: 'Готов к подключению',
    };
    for (const type of ['tx', 'rx', 'note'])
      client.on(type, (data) =>
        this.record(type, typeof data === 'string' ? { message: data } : data),
      );
    client.on('disconnected', (message) => {
      this.record('connection', { message });
      this.publish();
    });
    // An interrupted previous run must never look like a completed car scan.
    for (const entry of store.list()) {
      if (entry.status === 'running') {
        const report = store.read(entry.id);
        report.status = 'interrupted';
        store.save(report);
      }
    }
  }
  state() {
    return {
      running: this.running,
      busy: this.busy,
      connected: this.client.connected,
      progress: this.progress,
      report: this.report,
      sessions: this.store.list(),
      vehicle: VEHICLE,
      systems: SYSTEMS,
      sources: SOURCES,
      limitation: LIMITATION,
      events: this.events.slice(-1000),
    };
  }
  publish() {
    this.emit('state', this.state());
  }
  record(type, data) {
    const event = { time: new Date().toISOString(), type, ...data };
    this.events.push(event);
    if (this.events.length > 1000) this.events.shift();
    if (this.report) this.store.log(this.report, event);
    this.emit('event', event);
  }
  start(input) {
    if (this.running || this.busy)
      throw new Error('Сначала остановите текущую операцию');
    const endpoint = validateEndpoint(input.host, Number(input.port));
    const environment = input.environment ?? 'car';
    if (!['car', 'bench'].includes(environment))
      throw new Error('Выберите машину или стол');
    this.client.close();
    this.events = [];
    this.stopped = false;
    this.report = this.store.create({
      mode: endpoint.mode,
      endpoint,
      environment,
    });
    this.running = true;
    this.progress = {
      current: 0,
      total: STEPS.length,
      title: 'Подключение к ELM',
    };
    this.publish();
    this.task = this.run(endpoint)
      .catch((error) => {
        this.record('error', { message: error.message });
        if (this.report)
          this.report.status = this.stopped ? 'stopped' : 'failed';
        this.client.close();
      })
      .finally(() => {
        this.running = false;
        this.store.save(this.report);
        this.publish();
      });
  }
  async run(endpoint) {
    this.record('note', {
      message:
        endpoint.mode === 'mock'
          ? 'MOCK: ответы синтетические, к машине не подключаемся'
          : 'Проверка адаптера. Запросов к ЭБУ в этом профиле нет.',
    });
    await this.client.connect(endpoint.host, endpoint.port);
    for (let index = 0; index < STEPS.length; index++) {
      if (this.stopped) throw new Error('Остановлено пользователем');
      const step = STEPS[index];
      this.progress = {
        current: index,
        total: STEPS.length,
        title: step.title,
      };
      this.publish();
      const result = await this.client.send(step.command, {
        timeout: step.timeout,
      });
      const text = result.lines.join(' | ');
      const accepted =
        result.lines.length > 0 &&
        !result.lines.some((line) =>
          /^(\?|ERROR|UNABLE TO CONNECT|BUS ERROR|DATA ERROR|STOPPED|NO DATA)/i.test(
            line,
          ),
        );
      const check = {
        command: step.command,
        title: step.title,
        response: text,
        durationMs: result.durationMs,
        accepted,
      };
      this.report.checks.push(check);
      if (
        step.command === 'ATZ' &&
        !result.lines.some((line) => /ELM|STN|OBD/i.test(line))
      )
        throw new Error(
          'Нет ожидаемого приветствия ELM. Нельзя подтвердить тип устройства.',
        );
      if (step.field && accepted) this.report.adapter[step.field] = text;
      if (step.field === 'voltage') this.addVoltage(result);
      if (step.capability)
        this.report.capabilities.push({
          name: step.capability,
          accepted: result.lines.includes('OK'),
          response: text || 'Пустой ответ',
          vehicleTested: false,
        });
      this.store.save(this.report);
      await sleep(step.settle ? this.settleMs ?? step.settle : this.gapMs);
    }
    if (this.stopped) throw new Error('Остановлено пользователем');
    this.report.status = 'adapter_checked';
    this.progress = {
      current: STEPS.length,
      total: STEPS.length,
      title: 'Адаптер проверен. Заполните наблюдения по системам.',
    };
    this.record('note', {
      message:
        'Готово: адаптер проверен. Коды кузовных блоков НЕ считывались. Наблюдения и фото можно добавить ниже.',
    });
  }
  addVoltage(result) {
    const match = result.lines.join(' ').match(/\b(\d{1,2}(?:\.\d+)?)V\b/i);
    if (!match) return;
    const value = Number(match[1]);
    this.report.voltageSamples.push({ time: new Date().toISOString(), value });
    this.report.adapter.voltage = `${value.toFixed(1)}V`;
    if (value < 12)
      this.record('warning', {
        message:
          'Адаптер сообщает менее 12 В. Это приблизительное измерение, не проверка аккумулятора. Завершите наблюдения без длительного включения зажигания.',
      });
  }
  async voltage() {
    if (this.running || this.busy || !this.client.connected || !this.report)
      throw new Error('Сначала завершите проверку адаптера');
    this.busy = true;
    this.publish();
    try {
      this.addVoltage(await this.client.send('ATRV'));
      this.store.save(this.report);
    } finally {
      this.busy = false;
      this.publish();
    }
  }
  stop() {
    this.stopped = true;
    this.client.close('Остановлено пользователем');
    if (this.report && !this.running && this.report.status === 'running') {
      this.report.status = 'stopped';
      this.store.save(this.report);
    }
    this.publish();
  }
  select(id) {
    if (this.running || this.busy)
      throw new Error('Сначала остановите текущую операцию');
    this.client.close();
    this.report = this.store.read(id);
    this.events = this.store.events(id).slice(-1000);
    this.progress = {
      current: 0,
      total: STEPS.length,
      title: 'Открыт сохранённый сеанс',
    };
    this.publish();
  }
  saveNotes(id, input) {
    const report = this.report?.id === id ? this.report : this.store.read(id);
    if (typeof input.notes === 'string')
      report.notes = input.notes.slice(0, 20000);
    if (input.vin !== undefined) {
      const vin = String(input.vin).trim().toUpperCase();
      if (vin && !/^[A-HJ-NPR-Z0-9]{17}$/.test(vin))
        throw new Error('VIN должен состоять из 17 символов');
      report.vehicle.vin = vin;
    }
    if (input.systems !== undefined) {
      if (!Array.isArray(input.systems))
        throw new Error('Неверный формат наблюдений');
      for (const note of input.systems) {
        const target = report.systems.find((s) => s.id === note.id);
        if (!target) continue;
        if (typeof note.observation === 'string')
          target.observation = note.observation.slice(0, 10000);
        if (note.answers && typeof note.answers === 'object') {
          for (const question of target.questions) {
            if (typeof note.answers[question] === 'string')
              target.answers[question] = note.answers[question].slice(0, 1000);
          }
        }
      }
    }
    this.store.save(report);
    this.publish();
  }
}
