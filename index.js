import { config, assertConfig } from './config.js';
import { loadSettings } from './settings.js';
import { createApp } from './app.js';
import { maintain } from './maintenance.js';

assertConfig();
await loadSettings();
const { server, world } = createApp();
server.listen(config.port, () => console.log(`API + sky listening on :${config.port} (${config.isProd ? 'production' : 'development'})`));

maintain();
setInterval(maintain, 24 * 3_600_000).unref();
setInterval(() => loadSettings().catch(() => {}), 60_000).unref(); // pick up admin changes made on another instance

const stop = () => { world.close(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e?.message || e));
