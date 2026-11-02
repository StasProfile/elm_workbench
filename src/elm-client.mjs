import net from 'node:net';
import { EventEmitter } from 'node:events';

// Port of the existing Dart transport's single-in-flight / prompt framing.
// This narrower profile deliberately permits NO vehicle diagnostic payloads.
export const ALLOWED_COMMANDS = new Set([
  'ATZ',
  'ATE0',
  'ATL0',
  'ATI',
  'AT@1',
  'AT@2',
  'ATRV',
  'ATDP',
  'ATDPN',
  'ATPPS',
  'ATKW',
  'ATPC',
  'ATTP0',
  'ATTP3',
  'ATTP4',
  'ATTP5',
]);

export function normalizeCommand(raw) {
  if (typeof raw !== 'string' || /[\r\n]/.test(raw))
    throw new Error('Команда запрещена');
  const cmd = raw.trim().toUpperCase().replace(/ /g, '');
  if (!ALLOWED_COMMANDS.has(cmd)) throw new Error('Команда запрещена');
  return cmd;
}

export class ElmClient extends EventEmitter {
  constructor({ timeout = 2500 } = {}) {
    super();
    this.timeout = timeout;
    this.socket = null;
    this.pending = null;
    this.buffer = '';
    this.tail = Promise.resolve();
    this.generation = 0;
  }

  get connected() {
    return Boolean(
      this.socket && !this.socket.destroyed && !this.socket.connecting,
    );
  }

  async connect(host, port, timeout = 4500) {
    this.close();
    const generation = this.generation;
    const socket = net.createConnection({ host, port });
    this.socket = socket;
    socket.setNoDelay(true);
    socket.on('data', (chunk) => {
      if (this.socket === socket) this.consume(chunk);
    });
    socket.on('error', (error) => {
      if (this.socket === socket) this.close(`Ошибка TCP: ${error.message}`);
    });
    socket.on('close', () => {
      if (this.socket === socket) this.close('Адаптер закрыл соединение');
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.socket === socket)
          this.close('Адаптер не принял TCP-соединение вовремя');
        reject(
          new Error('Нет TCP-соединения. Проверьте Wi-Fi, адрес и порт ELM.'),
        );
      }, timeout);
      const cleanup = () => {
        clearTimeout(timer);
        socket.off('connect', onConnect);
        socket.off('error', onError);
        socket.off('close', onClose);
      };
      const onConnect = () => {
        cleanup();
        resolve();
      };
      const onError = (error) => {
        cleanup();
        reject(error);
      };
      const onClose = () => {
        cleanup();
        reject(new Error('Подключение прервано'));
      };
      socket.once('connect', onConnect);
      socket.once('error', onError);
      socket.once('close', onClose);
    });
    if (generation !== this.generation || this.socket !== socket)
      throw new Error('Подключение отменено');
    this.emit('note', `TCP подключён: ${host}:${port}`);
  }

  send(raw, { timeout = this.timeout } = {}) {
    const command = normalizeCommand(raw); // Before queueing or touching socket.
    const generation = this.generation;
    const run = this.tail.then(() => {
      if (generation !== this.generation || !this.connected)
        throw new Error('ELM не подключён');
      return this.exchange(command, timeout);
    });
    this.tail = run.catch(() => {});
    return run;
  }

  exchange(command, timeout) {
    const socket = this.socket;
    this.buffer = '';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // Reconnect is mandatory. No bare CR that might repeat a command,
        // no late prompt can complete a subsequent exchange on this stream.
        this.close(`Нет приглашения > после ${command}. Соединение закрыто.`);
      }, timeout);
      this.pending = { command, resolve, reject, timer, started: Date.now() };
      this.emit('tx', { command });
      socket.write(`${command}\r`, 'ascii');
    });
  }

  consume(chunk) {
    for (const byte of chunk) {
      if (byte === 62) {
        const raw = this.buffer;
        this.buffer = '';
        const pending = this.pending;
        if (!pending) {
          if (raw.trim())
            this.emit('note', `Вне запроса: ${raw.trim().slice(0, 300)}`);
          continue;
        }
        this.pending = null;
        clearTimeout(pending.timer);
        const lines = raw
          .split(/[\r\n]+/)
          .map((line) => line.trim())
          .filter(Boolean)
          .filter(
            (line) => line.replace(/ /g, '').toUpperCase() !== pending.command,
          );
        const result = {
          command: pending.command,
          lines,
          raw,
          durationMs: Date.now() - pending.started,
        };
        this.emit('rx', result);
        pending.resolve(result);
      } else if ((byte >= 32 && byte < 127) || byte === 13 || byte === 10) {
        this.buffer += String.fromCharCode(byte);
        if (this.buffer.length > 32768) {
          this.close('Слишком длинный ответ ELM');
          return;
        }
      }
    }
  }

  close(reason = 'Соединение закрыто') {
    this.generation += 1;
    const socket = this.socket;
    this.socket = null;
    const partial = this.buffer;
    this.buffer = '';
    if (this.pending) {
      const pending = this.pending;
      if (partial)
        this.emit('rx', {
          command: pending.command,
          raw: partial,
          lines: partial.split(/[\r\n]+/).filter(Boolean),
          partial: true,
          durationMs: Date.now() - pending.started,
        });
      this.pending = null;
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    if (socket) {
      socket.destroy();
      this.emit('disconnected', reason);
    }
  }
}
