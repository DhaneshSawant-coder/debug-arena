// Piston API Integration Module
// Executes code via Piston execution engine (emkc.org) for zero-dependency multi-language support.

const PISTON_ENDPOINT = process.env.PISTON_ENDPOINT || 'https://emkc.org/api/v2/piston/execute';

const LANGUAGE_CONFIG = {
  javascript: { pistonLang: 'javascript', defaultFile: 'main.js' },
  js: { pistonLang: 'javascript', defaultFile: 'main.js' },
  python: { pistonLang: 'python', defaultFile: 'main.py' },
  py: { pistonLang: 'python', defaultFile: 'main.py' },
  c: { pistonLang: 'c', defaultFile: 'main.c' },
  cpp: { pistonLang: 'c++', defaultFile: 'main.cpp' },
  'c++': { pistonLang: 'c++', defaultFile: 'main.cpp' },
  java: { pistonLang: 'java', defaultFile: 'Main.java' },
  csharp: { pistonLang: 'csharp', defaultFile: 'Program.cs' },
  'c#': { pistonLang: 'csharp', defaultFile: 'Program.cs' },
  cs: { pistonLang: 'csharp', defaultFile: 'Program.cs' }
};

/**
 * Executes source code via the Piston API
 * @param {string} code - The source code to run
 * @param {string} language - Programming language
 * @returns {Promise<{ ok: boolean, output?: string, line?: number|null, message?: string }>}
 */
async function runPiston(code, language = 'javascript') {
  const normLang = String(language || 'javascript').toLowerCase().trim();
  const cfg = LANGUAGE_CONFIG[normLang] || LANGUAGE_CONFIG.javascript;

  let fileName = cfg.defaultFile;
  if (cfg.pistonLang === 'java') {
    const match = String(code || '').match(/public\s+class\s+([A-Za-z0-9_]+)/);
    if (match) fileName = `${match[1]}.java`;
  }

  const payload = {
    language: cfg.pistonLang,
    version: '*',
    files: [
      {
        name: fileName,
        content: String(code || '')
      }
    ],
    stdin: '',
    args: [],
    compile_timeout: 10000,
    run_timeout: 4000
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 12000);

  try {
    const response = await fetch(PISTON_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'DebugArena-Hackathon/1.0'
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      return {
        ok: false,
        line: null,
        message: `Execution service returned HTTP ${response.status}: ${errText || response.statusText}`
      };
    }

    const data = await response.json();

    // 1. Check for compilation errors
    if (data.compile && data.compile.code !== 0) {
      const compileOutput = (data.compile.output || data.compile.stderr || '').trim();
      const lineMatch = compileOutput.match(/(?::|\()(\d+)(?::|\)|,)/);
      const line = lineMatch ? Number(lineMatch[1]) : null;
      return {
        ok: false,
        line,
        message: `Compilation Error:\n${compileOutput}`
      };
    }

    // 2. Check for runtime errors
    const run = data.run || {};
    if (run.code !== 0) {
      const runErr = (run.stderr || run.output || '').trim();
      const lineMatch = runErr.match(/(?:line\s*|:|\()(\d+)/i);
      const line = lineMatch ? Number(lineMatch[1]) : null;
      return {
        ok: false,
        line,
        message: runErr ? `Runtime Error:\n${runErr}` : `Execution failed with exit code ${run.code}`
      };
    }

    // 3. Successful run
    const stdout = (run.stdout !== undefined ? run.stdout : run.output) || '';
    return {
      ok: true,
      output: String(stdout).slice(0, 10000)
    };
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      return { ok: false, line: null, message: 'Execution timed out (12s network/service limit)' };
    }
    return {
      ok: false,
      line: null,
      message: `Failed to connect to execution engine: ${err.message}`
    };
  }
}

module.exports = { runPiston, LANGUAGE_CONFIG };

