const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server.js'], {
      cwd: __dirname,
      env: { ...process.env, PORT: '4109' },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let output = '';
    child.stdout.on('data', chunk => { output += String(chunk); });
    child.stderr.on('data', chunk => { output += String(chunk); });

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Server did not start: ${output}`));
    }, 15000);

    child.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });

    child.on('spawn', () => {
      const check = async () => {
        try {
          const response = await fetch('http://localhost:4109/api/health');
          if (response.ok) {
            clearTimeout(timer);
            resolve(child);
            return;
          }
        } catch {}
        setTimeout(check, 200);
      };
      check();
    });
  });
}

test('server exposes a health endpoint', async () => {
  const child = await startServer();
  try {
    const response = await fetch('http://localhost:4109/api/health');
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.ok, true);
    assert.equal(data.service, 'easyread');
    assert.ok(Array.isArray(data.routes));
  } finally {
    child.kill();
  }
});
