export const VEHICLE = {
  title: 'Mercedes-Benz SL500',
  chassis: '230.475 / R230',
  year: 2002,
  adapter: 'Kingbolen ELM327 v1.5 Wi-Fi · заявлен PIC18F25K80',
};

export const SYSTEMS = [
  {
    id: 'pse',
    title: 'Пневматика PSE',
    subtitle: 'Общее питание пневматических функций',
    questions: [
      'Центральный замок работает?',
      'Доводчик багажника работает?',
      'Слышно ли насос при запросе регулировки сиденья?',
    ],
  },
  {
    id: 'mkl-left',
    title: 'Мультиконтур · слева',
    subtitle: 'Спинка, поясница и PULSE водителя',
    questions: [
      'Загорается ли PULSE и гаснет ли сам?',
      'Слышны ли щелчки при нажатии?',
      'Есть ли накачивание, шипение или движение подушек?',
    ],
  },
  {
    id: 'mkl-right',
    title: 'Мультиконтур · справа',
    subtitle: 'Спинка, поясница и PULSE пассажира',
    questions: [
      'Загорается ли PULSE и гаснет ли сам?',
      'Слышны ли щелчки при нажатии?',
      'Поведение отличается от водительского сиденья?',
    ],
  },
  {
    id: 'esa',
    title: 'Электрические регулировки',
    subtitle: 'Оба сиденья, память и дверные кнопки',
    questions: [
      'Какие конкретно регулировки не работают?',
      'Работает ли память положений?',
      'Слева и справа одинаковое поведение?',
    ],
  },
  {
    id: 'audio',
    title: 'COMAND / CD-чейнджер',
    subtitle: 'Головное устройство и сеть D2B',
    questions: [
      'Точный текст ошибки на экране COMAND?',
      'Работают ли радио и звук?',
      'Принимает ли чейнджер магазин, есть ли индикация?',
    ],
  },
  {
    id: 'abc',
    title: 'Подвеска ABC',
    subtitle: 'Сообщения приборной панели',
    questions: [
      'Точный текст и цвет предупреждения?',
      'Как стоит машина после стоянки?',
      'Есть ли видимые следы утечки? Ничего не разбирать.',
    ],
  },
];

export const SOURCES = [
  {
    title: 'ELM327 — документация производителя, команды и электрическая схема',
    url: 'https://www.elmelectronics.com/wp-content/uploads/2020/05/ELM327DSL.pdf',
  },
  {
    title:
      'Mercedes-Benz USA — Networking and System Diagnosis, R230 (копия учебного материала)',
    url: 'https://pdfcoffee.com/318-ho-syst-diag-gcjljm-01-09-03-pdf-free.html',
  },
  {
    title: 'iCarsoft — таблица функций, SL 230 до 08/2003, PSE и OSB-FL/FR',
    url: 'https://www.icarsoft.com/Uploads/download/MB%20V1.0%26M900%20V1.0_Benz_V01.05%20Fuction%20List.pdf',
  },
];

export const LIMITATION =
  'Этот прогон проверяет ELM и сохраняет наблюдения. Ошибки кузовных блоков НЕ считываются: физический маршрут и команды Mercedes для этого автомобиля ещё не подтверждены. Принятая AT-команда не доказывает связь с блоком или исправность оборудования.';

export const STEPS = [
  { command: 'ATPC', title: 'Закрытие прежней сессии адаптера' },
  {
    command: 'ATZ',
    title: 'Перезапуск адаптера ELM',
    timeout: 6000,
    settle: 1500,
  },
  { command: 'ATE0', title: 'Отключение эха' },
  { command: 'ATL0', title: 'Формат ответов' },
  { command: 'ATPC', title: 'Закрытие протокола после перезапуска' },
  { command: 'ATI', title: 'Заявленная версия ELM', field: 'firmware' },
  { command: 'AT@1', title: 'Описание адаптера', field: 'description' },
  { command: 'AT@2', title: 'Заявленный идентификатор', field: 'identifier' },
  { command: 'ATRV', title: 'Напряжение на входе адаптера', field: 'voltage' },
  {
    command: 'ATDP',
    title: 'Настроенный протокол (не доказательство связи)',
    field: 'protocol',
  },
  {
    command: 'ATDPN',
    title: 'Номер настроенного протокола',
    field: 'protocolNumber',
  },
  {
    command: 'ATPPS',
    title: 'Чтение параметров адаптера',
    field: 'parameters',
  },
  {
    command: 'ATKW',
    title: 'Сохранённые ключевые слова (могут отсутствовать)',
    field: 'keywords',
  },
  {
    command: 'ATTP3',
    title: 'Принимает ли настройку ISO 9141-2',
    capability: 'ISO 9141-2',
  },
  { command: 'ATPC', title: 'Закрытие выбранного протокола' },
  {
    command: 'ATTP4',
    title: 'Принимает ли настройку KWP с медленной инициализацией',
    capability: 'KWP / slow init',
  },
  { command: 'ATPC', title: 'Закрытие выбранного протокола' },
  {
    command: 'ATTP5',
    title: 'Принимает ли настройку KWP с быстрой инициализацией',
    capability: 'KWP / fast init',
  },
  { command: 'ATPC', title: 'Закрытие выбранного протокола' },
  {
    command: 'ATTP0',
    title: 'Возврат автоматического выбора (без поиска на машине)',
  },
  { command: 'ATPC', title: 'Закрытие протокола' },
  {
    command: 'ATRV',
    title: 'Повторное измерение напряжения',
    field: 'voltage',
  },
];
