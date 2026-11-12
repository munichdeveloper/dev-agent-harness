// Fail-closed preflight for the loopback profile. Without arguments it runs on the host and starts the
// same file inside the Codex command sandbox, which must have working loopback and no path to the host.
import { spawnSync } from 'node:child_process';
import { readlinkSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const namespace = () => readlinkSync('/proc/self/ns/net');
const listen = () => new Promise((resolve, reject) => {
  const server = createServer().once('error', reject).listen(0, '127.0.0.1', () => resolve(server));
});
const reaches = (port, host) => new Promise(resolve => {
  const socket = connect({ port, host, timeout: 2000 }, () => { socket.destroy(); resolve(true); });
  socket.on('error', () => resolve(false)).on('timeout', () => { socket.destroy(); resolve(false); });
});
const [hostNamespace, canaryPort] = process.argv.slice(2);
const server = await listen();
if (hostNamespace === undefined) {
  // The kernel completes connections to this canary even while spawnSync blocks the event loop.
  const { status } = spawnSync('sudo', ['-u', 'codex-worker', 'env', 'HOME=/home/codex-worker', 'CODEX_HOME=/home/codex-worker/.codex',
    `PATH=${process.env.PATH}`, 'codex', 'sandbox', '-P', 'harness-loopback', '-C', process.env.TARGET, '--',
    process.execPath, fileURLToPath(import.meta.url), namespace(), String(server.address().port)], { stdio: 'inherit' });
  if (status !== 0) throw new Error('Loopback isolation could not be verified');
} else {
  if (namespace() === hostNamespace) throw new Error('Commands share the host network namespace');
  if (!await reaches(server.address().port, '127.0.0.1')) throw new Error('Loopback is unavailable');
  if (await reaches(Number(canaryPort), '127.0.0.1') || await reaches(53, '127.0.0.53')) throw new Error('Host loopback is reachable');
}
server.close();
