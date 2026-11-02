import { createMockElm } from './mock-elm.mjs';
import { createWorkbenchServer } from './server.mjs';

const mock = createMockElm();
const app = createWorkbenchServer();
const listen = (server, port) =>
  new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await app.close();
  await mock.close();
}
try {
  await listen(mock.server, 35000);
  await listen(app.server, 8787);
  console.log('R230 Workbench + MOCK: http://localhost:8787/?source=mock');
  console.log(
    'Mock ELM: 127.0.0.1:35000. Нажмите «Подключить и проверить» в UI.',
  );
  console.log(
    'Это синтетические ответы адаптера, не данные машины. Ctrl+C остановит оба сервера.',
  );
} catch (error) {
  console.error(
    `Не удалось запустить demo: ${error.message}. Проверьте, свободны ли порты 8787 и 35000.`,
  );
  await close();
  process.exitCode = 1;
}
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => close().then(() => process.exit(0)));
