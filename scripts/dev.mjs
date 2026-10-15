// Runs the API server (tsx watch, PORT, default 8080) and the Vite dev server (port 5173,
// proxying /api to that same PORT, see web/devProxy.ts) together. Both get this process's
// environment, so `PORT=9000 npm run dev` moves the API and the proxy together; set
// LYREN_API_URL to proxy to an API elsewhere. Ctrl+C stops both. Works on Windows too: npm is
// started without a shell where possible, and stopping ends each npm's whole process tree
// (scripts/lib/npm-run.mjs).

import { spawn } from 'node:child_process';
import { killTree, npmRunInvocation } from './lib/npm-run.mjs';

function npmRun(script, env = process.env) {
  const { command, args, shell } = npmRunInvocation(script);
  const child = spawn(command, args, { stdio: 'inherit', env, shell });
  child.on('error', (err) => {
    console.error(`dev: could not start npm run ${script}: ${err.message}`);
    stopAll(1);
  });
  return child;
}

let exiting = false;
const procs = [];
function stopAll(code = 0) {
  if (exiting) return;
  exiting = true;
  for (const p of procs) killTree(p);
  setTimeout(() => process.exit(code), 500);
}

procs.push(npmRun('dev:server', { ...process.env, WEB_DIR: '' }), npmRun('dev:web'));
for (const p of procs) p.on('exit', (code) => stopAll(code ?? 0));
process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));
