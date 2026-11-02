import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  readdirSync,
  existsSync,
  appendFileSync,
} from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { VEHICLE, SYSTEMS, SOURCES, LIMITATION } from './profile.mjs';

export class ReportStore {
  constructor(directory) {
    this.directory = directory;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  vehicleProfile() {
    try {
      const saved = JSON.parse(
        readFileSync(path.join(this.directory, 'vehicle.json'), 'utf8'),
      );
      return {
        ...VEHICLE,
        vin:
          typeof saved.vin === 'string' &&
          /^[A-HJ-NPR-Z0-9]{17}$/.test(saved.vin)
            ? saved.vin
            : '',
      };
    } catch {
      return { ...VEHICLE, vin: '' };
    }
  }
  create({ mode, endpoint, environment = 'car' }) {
    const report = {
      schemaVersion: 1,
      id: randomUUID(),
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      mode,
      endpoint,
      environment,
      vehicle: this.vehicleProfile(),
      status: 'running',
      limitation: LIMITATION,
      ecuRequestsSent: 0,
      adapter: {},
      capabilities: [],
      checks: [],
      voltageSamples: [],
      systems: SYSTEMS.map((system) => ({
        ...system,
        diagnosticStatus: 'not_tested',
        observation: '',
        answers: {},
        evidence: [],
      })),
      notes: '',
      sources: SOURCES,
    };
    mkdirSync(this.folder(report.id), { recursive: true, mode: 0o700 });
    this.save(report);
    return report;
  }
  folder(id) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Неверный номер сеанса');
    return path.join(this.directory, id);
  }
  save(report) {
    report.updatedAt = new Date().toISOString();
    const file = path.join(this.folder(report.id), 'report.json');
    writeFileSync(`${file}.tmp`, JSON.stringify(report, null, 2), {
      mode: 0o600,
    });
    renameSync(`${file}.tmp`, file);
  }
  log(report, event) {
    appendFileSync(
      path.join(this.folder(report.id), 'events.jsonl'),
      `${JSON.stringify(event)}\n`,
      { mode: 0o600 },
    );
  }
  read(id) {
    return JSON.parse(
      readFileSync(path.join(this.folder(id), 'report.json'), 'utf8'),
    );
  }
  list() {
    return readdirSync(this.directory)
      .filter((id) => /^[a-f0-9-]{36}$/.test(id))
      .map((id) => {
        try {
          const r = this.read(id);
          return { id, startedAt: r.startedAt, status: r.status, mode: r.mode };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }
  events(id) {
    const file = path.join(this.folder(id), 'events.jsonl');
    return existsSync(file)
      ? readFileSync(file, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  }
  attach(report, systemId, { name, type, data }) {
    const system = report.systems.find((entry) => entry.id === systemId);
    const extensions = {
      'image/jpeg': 'jpg',
      'image/png': 'png',
      'image/webp': 'webp',
    };
    if (
      !system ||
      !extensions[type] ||
      typeof data !== 'string' ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(data)
    )
      throw new Error('Нужна фотография JPEG, PNG или WebP');
    const count = report.systems.reduce((sum, s) => sum + s.evidence.length, 0);
    if (count >= 12) throw new Error('Не больше 12 фотографий на сеанс');
    const bytes = Buffer.from(data, 'base64');
    const validSignature =
      type === 'image/jpeg'
        ? bytes[0] === 0xff && bytes[1] === 0xd8
        : type === 'image/png'
          ? bytes
              .subarray(0, 8)
              .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          : bytes.toString('ascii', 0, 4) === 'RIFF' &&
            bytes.toString('ascii', 8, 12) === 'WEBP';
    if (!validSignature || bytes.length < 12 || bytes.length > 5 * 1024 * 1024)
      throw new Error('Неверный файл или фотография больше 5 МБ');
    const filename = `${randomUUID()}.${extensions[type]}`;
    writeFileSync(path.join(this.folder(report.id), filename), bytes, {
      mode: 0o600,
    });
    system.evidence.push({
      filename,
      name: String(name || 'Фото').slice(0, 120),
      type,
      size: bytes.length,
    });
    this.save(report);
  }
  files(id) {
    const report = this.read(id);
    const entries = [
      ['report.json', Buffer.from(JSON.stringify(report, null, 2))],
      [
        'events.jsonl',
        Buffer.from(
          this.events(id)
            .map((event) => JSON.stringify(event))
            .join('\n'),
        ),
      ],
      ['README.txt', Buffer.from(summary(report))],
    ];
    for (const system of report.systems) {
      for (const evidence of system.evidence)
        entries.push([
          `photos/${evidence.filename}`,
          readFileSync(path.join(this.folder(id), evidence.filename)),
        ]);
    }
    return entries;
  }
}

export function summary(r) {
  return [
    'R230 / ПАКЕТ ДЛЯ КУЗОВНОЙ ДИАГНОСТИКИ',
    `Режим: ${r.mode === 'mock' ? 'MOCK — СИНТЕТИЧЕСКИЕ ДАННЫЕ, НЕ АВТОМОБИЛЬ' : 'Подключение к адаптеру'}`,
    `Дата: ${r.startedAt}`,
    `Место: ${r.mode === 'mock' ? 'программный mock' : r.environment === 'bench' ? 'стол, внешнее питание' : 'в автомобиле (по выбору пользователя)'}`,
    `Статус прогона: ${r.status}`,
    `Автомобиль: ${r.vehicle.title}, ${r.vehicle.year}, VIN: ${r.vehicle.vin || 'не указан'}`,
    '',
    'ВАЖНО',
    r.limitation,
    `Запросов к ЭБУ: ${r.ecuRequestsSent}`,
    '',
    'АДАПТЕР',
    JSON.stringify(r.adapter, null, 2),
    '',
    'ПРИНЯТИЕ НАСТРОЕК (НЕ ПРОВЕРКА ФИЗИЧЕСКОГО ИНТЕРФЕЙСА)',
    ...r.capabilities.map(
      (c) =>
        `${c.name}: ${c.accepted ? 'принято' : 'не подтверждено'}; ${c.response}`,
    ),
    '',
    ...r.systems.flatMap((s) => [
      s.title,
      'Ошибки ЭБУ: НЕ СЧИТЫВАЛИСЬ',
      ...Object.entries(s.answers).map(([q, a]) => `${q}: ${a}`),
      s.observation || 'Наблюдения не заполнены',
      ...s.evidence.map((e) => `Фото: photos/${e.filename} (${e.name})`),
      '',
    ]),
    'ПРИМЕЧАНИЯ',
    r.notes || 'Нет',
    '',
    'ЧТО ЕЩЁ НУЖНО ДЛЯ ЧТЕНИЯ КУЗОВНЫХ БЛОКОВ',
    'Проверенная заводская распиновка по VIN, физическая разводка/маршрутизация конкретного адаптера, подтверждённый read-only профиль нужного блока Mercedes. Из ответов AT это не устанавливается.',
    'Неудача TCP или ответ ? не доказывают неисправность автомобильного блока. Отсутствие кодов в этом пакете не означает отсутствие неисправностей.',
    '',
    'ИСТОЧНИКИ (интернет нужен только для открытия оригиналов)',
    ...r.sources.map((s) => `${s.title}\n${s.url}`),
  ].join('\n');
}
