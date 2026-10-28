// Runs participant code in an isolated child process. Reads code from stdin, prints one JSON line.
const vm = require('vm');
const util = require('util');
let code = '';
process.stdin.on('data', d => (code += d)).on('end', () => {
  const out = [];
  const push = (...a) => out.push(a.map(x => (typeof x === 'string' ? x : util.inspect(x))).join(' '));
  const con = { log: push, info: push, warn: push, error: push };
  let result;
  try {
    const script = new vm.Script(code, { filename: 'user.js' });
    script.runInNewContext({ console: con }, { timeout: 2000 });
    result = { ok: true, output: out.join('\n').slice(0, 5000) };
  } catch (e) {
    const m = String((e && e.stack) || '').match(/user\.js:(\d+)/);
    result = { ok: false, line: m ? Number(m[1]) : null };
  }
  process.stdout.write(JSON.stringify(result));
});
