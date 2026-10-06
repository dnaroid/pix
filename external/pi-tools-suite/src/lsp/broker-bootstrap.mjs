// This file ships with the suite. Never create executable files in a project.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const sdkRequire = createRequire(import.meta.resolve('@earendil-works/pi-coding-agent'));
const { createJiti } = sdkRequire('jiti');
createJiti(import.meta.url, { interopDefault: true }).import(fileURLToPath(new URL('./broker-server.ts', import.meta.url)))
  .then(({ runLspBroker }) => runLspBroker(process.argv[2], process.argv[3]))
  .catch((error) => { console.error('LSP broker startup:', error?.message ?? error); process.exit(1); });
