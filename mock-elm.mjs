import net from 'node:net';
import { pathToFileURL } from 'node:url';

// ELM wire format reused from the Dart emulator: CR-terminated requests,
// echo before ATE0, CR-separated ASCII lines, > prompt. No simulated ECU
// replies: this profile inspects the adapter only, not a Mercedes ECU.
export function createMockElm({
  scenario = 'normal',
  delayMs = 35,
  fragment = true,
  dropAfter = 8,
} = {}) {
  const sockets = new Set(),
    received = [];
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setNoDelay(true);
    let input = '',
      echo = true,
      linefeeds = true,
      protocol = '0',
      count = 0;
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    socket.on('data', (chunk) => {
      input += chunk.toString('ascii');
      if (input.length > 4096) return socket.destroy();
      while (input.includes('\r')) {
        const position = input.indexOf('\r');
        const raw = input.slice(0, position).trim().toUpperCase();
        input = input.slice(position + 1);
        if (!raw) {
          received.push('<BARE CR>');
          continue;
        }
        const cmd = raw.replace(/ /g, '');
        count += 1;
        received.push(cmd);
        if (scenario === 'disconnect' && count >= dropAfter) {
          socket.destroy();
          return;
        }
        let lines = ['?'];
        const wasEcho = echo;
        if (cmd === 'ATZ') {
          echo = true;
          linefeeds = true;
          protocol = '0';
          lines = ['ELM327 v1.5'];
        } else if (cmd === 'ATE0') {
          echo = false;
          lines = ['OK'];
        } else if (cmd === 'ATL0') {
          linefeeds = false;
          lines = ['OK'];
        } else if (cmd === 'ATI') lines = ['ELM327 v1.5'];
        else if (cmd === 'AT@1') lines = ['OBDII to RS232 Interpreter'];
        else if (cmd === 'AT@2') lines = ['?'];
        else if (cmd === 'ATRV')
          lines = [scenario === 'low-voltage' ? '11.5V' : '12.6V'];
        else if (cmd === 'ATDP')
          lines = [
            protocol === '0'
              ? 'AUTO'
              : `ISO ${protocol === '3' ? '9141-2' : '14230-4'}`,
          ];
        else if (cmd === 'ATDPN') lines = [protocol === '0' ? 'A0' : protocol];
        else if (cmd === 'ATPPS')
          lines = [
            '00:FF F  01:FF F  02:FF F  03:32 F',
            '04:01 F  05:FF F  06:F1 F  07:09 F',
          ];
        else if (cmd === 'ATKW') lines = ['00 00'];
        else if (cmd === 'ATPC') lines = ['OK'];
        else if (/^ATTP[0345]$/.test(cmd)) {
          protocol = cmd.at(-1);
          lines = ['OK'];
        }
        if (scenario === 'clone' && ['ATPPS', 'ATTP4', 'ATKW'].includes(cmd))
          lines = ['?'];
        const separator = linefeeds ? '\r\n' : '\r';
        const output =
          (wasEcho ? `${raw}${separator}` : '') +
          lines.join(separator) +
          separator +
          separator +
          (scenario === 'no-prompt' && cmd === 'ATI' ? '' : '>');
        const send = () => {
          if (socket.destroyed) return;
          if (!fragment) {
            socket.write(output);
            return;
          }
          const split = Math.max(1, Math.floor(output.length / 2));
          socket.write(output.slice(0, split));
          setTimeout(() => {
            if (!socket.destroyed) socket.write(output.slice(split));
          }, 8);
        };
        setTimeout(
          send,
          scenario === 'slow' ? Math.max(delayMs, 300) : delayMs,
        );
      }
    });
  });
  return {
    server,
    received,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  const args = process.argv.slice(2);
  const option = (name, fallback) => {
    const i = args.indexOf(name);
    return i < 0 ? fallback : args[i + 1];
  };
  const scenario = option('--scenario', 'normal');
  if (
    ![
      'normal',
      'clone',
      'no-prompt',
      'disconnect',
      'low-voltage',
      'slow',
    ].includes(scenario)
  )
    throw new Error('Неизвестный сценарий mock');
  const port = Number(option('--port', '35000'));
  const mock = createMockElm({ scenario });
  mock.server.on('error', (error) => {
    console.error(`Mock ELM: ${error.message}`);
    process.exitCode = 1;
  });
  mock.server.listen(port, '127.0.0.1', () => {
    console.log(`MOCK ELM: 127.0.0.1:${port} · ${scenario}`);
    console.log(
      'TCP / ASCII / CR / >. Синтетические ответы адаптера, не автомобиль.',
    );
  });
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(signal, () => mock.close().then(() => process.exit(0)));
}
