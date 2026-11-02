const $ = (id) => document.getElementById(id);
let token = '',
  state = null,
  renderedId = null,
  logs = [],
  saveTimer,
  noteDirty = false,
  saving = null;
const date = (iso) =>
  new Date(iso).toLocaleString('ru-RU', {
    dateStyle: 'short',
    timeStyle: 'short',
  });
const labels = {
  running: 'Проверка адаптера',
  adapter_checked: 'Адаптер проверен · ЭБУ не опрашивались',
  failed: 'Проверка прервана ошибкой',
  stopped: 'Остановлено пользователем',
  interrupted: 'Прервано при закрытии сервера',
};
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function toast(message, error = false) {
  $('toast').textContent = message;
  $('toast').classList.toggle('error', error);
  $('toast').hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(
    () => ($('toast').hidden = true),
    error ? 9000 : 4000,
  );
}
async function request(url, input) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Workbench-Token': token },
    body: JSON.stringify(input),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Запрос не выполнен');
  return data;
}
function switchMode(mode) {
  $('real-mode').classList.toggle('selected', mode === 'adapter');
  $('mock-mode').classList.toggle('selected', mode === 'mock');
  $('host').value = mode === 'mock' ? '127.0.0.1' : '192.168.0.10';
  $('port').value = '35000';
  $('mode-badge').textContent = mode === 'mock' ? 'MOCK' : 'АДАПТЕР';
  $('source-hint').textContent =
    mode === 'mock'
      ? 'Запустите отдельный mock ELM на этом ноутбуке.'
      : 'Mac должен быть подключён к Wi-Fi адаптера.';
}
function setLog(events) {
  logs = events.slice(-1000);
  $('event-count').textContent = `${logs.length} событий`;
  $('log').textContent = logs.length
    ? logs
        .map((event) => {
          const at = new Date(event.time).toLocaleTimeString('ru-RU');
          if (event.type === 'tx') return `${at}  →  ${event.command}`;
          if (event.type === 'rx')
            return `${at}  ←  ${event.lines.join(' | ') || '(пустой ответ)'}  [${event.durationMs} ms]`;
          return `${at}  ·  ${event.message || event.type}`;
        })
        .join('\n')
    : 'Сеанс ещё не начат. Здесь появятся исходные ответы ELM.';
  if ($('follow').checked) $('log').scrollTop = $('log').scrollHeight;
}
function renderSystems(report, systems) {
  const grid = $('systems-grid');
  grid.replaceChildren();
  systems.forEach((system, index) => {
    const saved = report?.systems.find((s) => s.id === system.id);
    const card = element('article', 'panel system-card');
    card.dataset.system = system.id;
    card.append(
      element(
        'span',
        'system-number',
        `${String(index + 1).padStart(2, '0')} / BODY`,
      ),
      element('h3', '', system.title),
      element('p', 'subtitle', system.subtitle),
      element('span', 'system-status', 'ЭБУ НЕ ОПРОШЕН'),
    );
    const details = element('details');
    details.open = index < 2;
    details.append(element('summary', '', 'Записать наблюдения'));
    for (const question of system.questions) {
      const label = element('label', 'question', question);
      const input = element('input');
      input.type = 'text';
      input.placeholder = 'Не проверял / что наблюдаете';
      input.maxLength = 1000;
      input.value = saved?.answers[question] || '';
      input.dataset.question = question;
      input.disabled = !report;
      input.addEventListener('input', scheduleSave);
      label.append(input);
      details.append(label);
    }
    const label = element('label', '', 'Дополнительные детали');
    const textarea = element('textarea');
    textarea.placeholder = 'Точный текст, сторона, звук, время появления';
    textarea.maxLength = 10000;
    textarea.value = saved?.observation || '';
    textarea.disabled = !report;
    textarea.className = 'observation';
    textarea.addEventListener('input', scheduleSave);
    label.append(textarea);
    details.append(label);
    const photoLabel = element('label', 'photo-label', '+ Фото / маркировка');
    const photo = element('input');
    photo.type = 'file';
    photo.accept = 'image/jpeg,image/png,image/webp';
    photo.disabled = !report;
    photo.addEventListener('change', () => uploadPhoto(photo, system.id));
    photoLabel.append(photo);
    details.append(photoLabel);
    const photos = element('div', 'photos');
    photos.dataset.photos = system.id;
    details.append(photos);
    card.append(details);
    grid.append(card);
  });
  renderPhotos(report);
}
function renderPhotos(report) {
  if (!report) return;
  for (const system of report.systems) {
    const area = document.querySelector(`[data-photos="${system.id}"]`);
    if (!area) continue;
    if (area.dataset.count === String(system.evidence.length)) continue;
    area.dataset.count = String(system.evidence.length);
    area.replaceChildren();
    for (const evidence of system.evidence) {
      const link = element('a');
      link.href = `/api/reports/${report.id}/photos/${evidence.filename}`;
      link.target = '_blank';
      link.rel = 'noopener';
      link.title = evidence.name;
      const img = element('img');
      img.src = link.href;
      img.alt = evidence.name;
      link.append(img);
      area.append(link);
    }
  }
}
function render(next) {
  state = next;
  const report = next.report;
  const active = next.running || next.busy;
  $('connection').classList.toggle('connected', next.connected);
  $('connection').lastElementChild.textContent = next.connected
    ? report?.mode === 'mock'
      ? 'Подключён mock ELM'
      : 'ELM подключён'
    : 'ELM не подключён';
  for (const id of [
    'start',
    'host',
    'port',
    'real-mode',
    'mock-mode',
    'environment',
  ])
    $(id).disabled = active;
  $('stop').disabled = !next.running && !next.connected;
  $('measure').disabled = active || !next.connected;
  $('download').disabled = !report;
  $('save').disabled = !report;
  $('vin').disabled = !report;
  $('notes').disabled = !report;
  $('demo-warning').hidden = report?.mode !== 'mock';
  $('session-time').textContent = report
    ? date(report.startedAt)
    : 'Ещё не создан';
  $('session-status').textContent = report
    ? labels[report.status] || report.status
    : 'Все данные сохраняются локально';
  $('step-title').textContent = next.progress.title;
  $('step-count').textContent =
    `${next.progress.current} / ${next.progress.total}`;
  $('progress').max = next.progress.total;
  $('progress').value = next.progress.current;
  $('firmware').textContent = report?.adapter.firmware || 'Ожидание связи';
  $('adapter-description').textContent =
    report?.adapter.description ||
    'Kingbolen · Wi-Fi · PIC18F25K80 по маркировке';
  const voltage = report?.voltageSamples.at(-1)?.value;
  $('voltage').replaceChildren(
    document.createTextNode(
      voltage === undefined ? '— ' : `${voltage.toFixed(1)} `,
    ),
    element('small', '', 'V'),
  );
  $('voltage-note').textContent =
    voltage !== undefined && voltage < 12
      ? 'Менее 12 В · завершите сеанс'
      : 'На входе адаптера';
  const svg = $('sparkline');
  svg.replaceChildren();
  const samples = report?.voltageSamples || [];
  if (samples.length) {
    const values = samples.slice(-50).map((s) => s.value),
      low = Math.min(...values) - 0.3,
      high = Math.max(...values) + 0.3;
    const points = values
      .map(
        (v, i) =>
          `${values.length === 1 ? 140 : (i * 280) / (values.length - 1)},${34 - ((v - low) * 30) / (high - low)}`,
      )
      .join(' ');
    const line = document.createElementNS(
      'http://www.w3.org/2000/svg',
      'polyline',
    );
    line.setAttribute('points', points);
    line.setAttribute('fill', 'none');
    line.setAttribute('stroke', '#849b73');
    line.setAttribute('stroke-width', '2');
    svg.append(line);
  }
  $('capabilities').replaceChildren();
  if (!report?.capabilities.length)
    $('capabilities').append(
      element(
        'span',
        'empty-label',
        'Будет проверено принятие настроек ISO / KWP',
      ),
    );
  for (const capability of report?.capabilities || []) {
    const row = element('div');
    row.append(
      element('span', '', capability.name),
      element(
        'b',
        capability.accepted ? '' : 'missing',
        capability.accepted ? 'ПРИНЯТО' : 'НЕ ПОДТВЕРЖДЕНО',
      ),
    );
    $('capabilities').append(row);
  }
  $('result').hidden = !report || report.status === 'running';
  $('result').classList.toggle(
    'error',
    ['failed', 'stopped', 'interrupted'].includes(report?.status),
  );
  $('result').textContent =
    report?.status === 'adapter_checked'
      ? 'Проверка адаптера завершена. Ошибки кузовных блоков не считывались. Добавьте наблюдения и скачайте пакет.'
      : next.events.findLast((e) => e.type === 'error')?.message ||
        labels[report?.status] ||
        '';
  if (renderedId !== (report?.id || 'empty')) {
    renderedId = report?.id || 'empty';
    noteDirty = false;
    $('vin').value =
      report?.vehicle.vin || localStorage.getItem('r230-vin') || '';
    $('notes').value = report?.notes || '';
    if (report) {
      switchMode(report.mode);
      $('host').value = report.endpoint.host;
      $('port').value = report.endpoint.port;
      $('environment').value = report.environment || 'car';
    }
    updateEnvironment();
    renderSystems(report, next.systems);
    setLog(next.events);
  } else renderPhotos(report);
  if (!noteDirty)
    $('notes-state').textContent = report
      ? 'СОХРАНЯЕТСЯ ЛОКАЛЬНО'
      : 'Сначала создайте сеанс';
  renderArchive(next.sessions, active);
}
function renderArchive(sessions, active) {
  const area = $('sessions');
  area.replaceChildren();
  if (!sessions.length) {
    area.append(element('p', 'muted', 'Сохранённых сеансов пока нет.'));
    return;
  }
  for (const session of sessions) {
    const row = element('div', 'session-row');
    row.append(
      element('strong', '', date(session.startedAt)),
      element('span', '', session.mode === 'mock' ? 'MOCK' : 'АДАПТЕР'),
      element('span', '', labels[session.status] || session.status),
    );
    const button = element('button', '', 'Открыть');
    button.disabled = active;
    button.addEventListener('click', () =>
      guarded(async () => {
        await flushNotes();
        await request('/api/select', { id: session.id });
      }),
    );
    row.append(button);
    area.append(row);
  }
}
function collectNotes() {
  return {
    vin: $('vin').value.trim().toUpperCase(),
    notes: $('notes').value,
    systems: [...document.querySelectorAll('[data-system]')].map((card) => ({
      id: card.dataset.system,
      observation: card.querySelector('.observation').value,
      answers: Object.fromEntries(
        [...card.querySelectorAll('[data-question]')].map((input) => [
          input.dataset.question,
          input.value,
        ]),
      ),
    })),
  };
}
function scheduleSave() {
  noteDirty = true;
  $('notes-state').textContent = 'НЕСОХРАНЁННЫЕ ИЗМЕНЕНИЯ';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => guarded(flushNotes), 900);
}
async function flushNotes() {
  clearTimeout(saveTimer);
  if (saving) await saving;
  if (!state?.report || !noteDirty) return;
  const id = state.report.id,
    notes = collectNotes();
  saving = request(`/api/reports/${id}/notes`, notes);
  try {
    await saving;
    localStorage.setItem('r230-vin', notes.vin);
    // An edit while the request was in flight must not be marked saved.
    noteDirty = JSON.stringify(collectNotes()) !== JSON.stringify(notes);
    $('notes-state').textContent = noteDirty
      ? 'НЕСОХРАНЁННЫЕ ИЗМЕНЕНИЯ'
      : 'СОХРАНЕНО НА ДИСКЕ';
  } finally {
    saving = null;
  }
}
async function uploadPhoto(input, systemId) {
  const file = input.files[0];
  if (!file || !state?.report) return;
  await guarded(async () => {
    if (file.size > 5 * 1024 * 1024) throw new Error('Выберите фото до 5 МБ');
    const data = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = reject;
      reader.onload = () => resolve(reader.result.split(',')[1]);
      reader.readAsDataURL(file);
    });
    await request(`/api/reports/${state.report.id}/photo`, {
      systemId,
      name: file.name,
      type: file.type,
      data,
    });
    toast('Фотография сохранена на диске');
  });
  input.value = '';
}
async function guarded(fn) {
  try {
    return await fn();
  } catch (error) {
    toast(error.message || 'Операция не выполнена', true);
  }
}
function updateEnvironment() {
  $('setup-instructions').textContent =
    $('environment').value === 'bench'
      ? 'На столе: отдельное питание ELM 12 В. Данных автомобиля здесь нет. Подключите Mac к Wi-Fi адаптера.'
      : 'Автомобиль стоит. Зажигание включено, двигатель заглушён. Другие приложения ELM закрыты.';
}
$('environment').addEventListener('change', updateEnvironment);
$('real-mode').onclick = () => switchMode('adapter');
$('mock-mode').onclick = () => switchMode('mock');
$('start').onclick = () =>
  guarded(async () => {
    await flushNotes();
    await request('/api/start', {
      host: $('host').value.trim(),
      port: Number($('port').value),
      environment: $('environment').value,
    });
  });
$('stop').onclick = () => guarded(() => request('/api/stop', {}));
$('measure').onclick = () => guarded(() => request('/api/voltage', {}));
$('notes').addEventListener('input', scheduleSave);
$('vin').addEventListener('input', scheduleSave);
$('save').onclick = () =>
  guarded(async () => {
    noteDirty = true;
    await flushNotes();
    toast('Наблюдения сохранены');
  });
$('download').onclick = () =>
  guarded(async () => {
    noteDirty = true;
    await flushNotes();
    const link = element('a');
    link.href = `/api/reports/${state.report.id}/zip`;
    link.download = '';
    document.body.append(link);
    link.click();
    link.remove();
  });
window.addEventListener('beforeunload', (event) => {
  if (noteDirty) {
    event.preventDefault();
    event.returnValue = '';
  }
});
for (const link of document.querySelectorAll('.nav-link'))
  link.onclick = () => {
    for (const nav of document.querySelectorAll('.nav-link'))
      nav.classList.toggle('active', nav === link);
  };
async function boot() {
  const response = await fetch('/api/state');
  if (!response.ok) throw new Error('Локальный сервер недоступен');
  const initial = await response.json();
  token = initial.token;
  render(initial);
  if (
    !initial.report &&
    new URLSearchParams(location.search).get('source') === 'mock'
  )
    switchMode('mock');
  const events = new EventSource('/api/events');
  events.onopen = () =>
    guarded(async () => {
      const response = await fetch('/api/state');
      if (!response.ok)
        throw new Error('Не удалось обновить состояние локального сервера');
      const current = await response.json();
      token = current.token;
      render(current);
    });
  events.addEventListener('state', (event) => render(JSON.parse(event.data)));
  events.addEventListener('log', (event) =>
    setLog([...logs, JSON.parse(event.data)]),
  );
  events.onerror = () => {
    $('connection').classList.remove('connected');
    $('connection').lastElementChild.textContent =
      'Нет связи с локальным сервером';
    $('start').disabled = true;
    $('measure').disabled = true;
  };
}
guarded(boot);
