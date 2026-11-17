import process from 'node:process';

const port = Number(process.env.PORT || 3000);
const publicPort = Number(process.env.PUBLIC_PORT || 5173);
const adminPort = Number(process.env.ADMIN_PORT || 5174);
const ports = [port, publicPort, adminPort];
if (ports.some(value => !Number.isInteger(value) || value < 1 || value > 65535) || new Set(ports).size !== 3) {
  console.error('PORT, PUBLIC_PORT, and ADMIN_PORT must be distinct port numbers between 1 and 65535.');
  process.exit(1);
}
if (!process.env.ADMIN_PASSWORD) {
  console.error('Create .env from .env.example and set ADMIN_PASSWORD before starting.'); process.exit(1);
}
const publicUrl = `http://127.0.0.1:${publicPort}`;
const adminUrl = `http://127.0.0.1:${adminPort}`;
const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', PUBLIC_PORT: String(publicPort), ADMIN_PORT: String(adminPort), ADMIN_ORIGIN: adminUrl, COOKIE_SECURE: 'false', VITE_API_URL: '', PUBLIC_BASE_PATH: '/', DEV_API_TARGET: `http://127.0.0.1:${port}` };
const children = [
  Bun.spawn([process.execPath, '--watch', 'server/index.ts'], { env, stdout: 'inherit', stderr: 'inherit' }),
  Bun.spawn([process.execPath, 'run', 'dev:public'], { env, stdout: 'inherit', stderr: 'inherit' }),
  Bun.spawn([process.execPath, 'run', 'dev:admin'], { env, stdout: 'inherit', stderr: 'inherit' }),
];
let stopping = false;
function stop(code: number) {
  if (stopping) return;
  stopping = true; children.forEach(child => child.kill()); process.exit(code);
}
process.on('SIGINT', () => stop(0)); process.on('SIGTERM', () => stop(0));
console.log(`\nPublic signup: ${publicUrl}\nAdmin portal:  ${adminUrl}/admin/\nBackend API:   http://127.0.0.1:${port}/api/form\n`);
const firstExit = await Promise.race(children.map(async child => child.exited));
stop(firstExit || 1);
