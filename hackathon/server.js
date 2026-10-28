const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { runPiston } = require('./piston');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const SLOT_MS = (Number(process.env.SLOT_MINUTES) || 20) * 60 * 1000; // 20 minutes per code
const DB_FILE = path.join(__dirname, 'data.json');

let db = { groups: [], participants: [], problems: [], solves: [], settings: { geminiApiKey: '', aiEnabled: true } };
if (fs.existsSync(DB_FILE)) { try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) {} }
if (!db.settings) db.settings = { geminiApiKey: '', aiEnabled: true };
const save = () => fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
const uid = () => crypto.randomBytes(6).toString('hex');
const genCode = () => String(Math.floor(100000 + Math.random() * 900000));
const adminTokens = new Set();

// Ensure all groups have an access code and participants in groups inherit group code
let dirty = false;
db.groups.forEach(g => {
  if (!g.code) {
    const existing = db.participants.find(p => p.groupId === g.id && p.code);
    g.code = existing ? existing.code : genCode();
    dirty = true;
  }
});
db.participants.forEach(p => {
  if (p.groupId) {
    const g = db.groups.find(gr => gr.id === p.groupId);
    if (g && p.code !== g.code) {
      p.code = g.code;
      dirty = true;
    }
  }
});
if (dirty) save();

const app = express();
app.use(express.json({ limit: '200kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- helpers ----------
function who(req) {
  const t = req.headers['x-token'];
  if (!t) return null;
  if (adminTokens.has(t)) return { role: 'admin' };
  const p = db.participants.find(p => p.token === t);
  return p ? { role: 'participant', p } : null;
}
const adminOnly = (req, res, next) => (who(req)?.role === 'admin' ? next() : res.status(403).json({ error: 'Admin only' }));
const partOnly = (req, res, next) => { const w = who(req); if (w?.role === 'participant') { req.p = w.p; next(); } else res.status(403).json({ error: 'Login required' }); };

function score(pid) {
  return db.solves.filter(s => s.pid === pid).reduce((a, s) => a + (db.problems.find(p => p.id === s.problemId)?.points || 0), 0);
}
function slotInfo(group) {
  if (!group || !group.startedAt) return { status: 'waiting' };
  const elapsed = Date.now() - group.startedAt;
  const idx = Math.floor(elapsed / SLOT_MS);
  if (idx >= db.problems.length) return { status: 'finished' };
  return { status: 'running', idx, msLeft: SLOT_MS - (elapsed % SLOT_MS) };
}
// ---------- Multi-language Code Runners ----------
const TEMP_RUN_DIR = path.join(__dirname, 'temp_runs');
if (!fs.existsSync(TEMP_RUN_DIR)) { try { fs.mkdirSync(TEMP_RUN_DIR, { recursive: true }); } catch (e) {} }

const CSC_PATH = fs.existsSync('C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe')
  ? 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe'
  : 'csc';

function runJS(code) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(__dirname, 'runner.js')], { stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '', done = false;
    const finish = r => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish({ ok: false, line: null, message: 'Execution timed out (4s)' }); }, 4000);
    child.stdout.on('data', d => { out += d; if (out.length > 20000) { child.kill('SIGKILL'); finish({ ok: false, line: null, message: 'Output limit exceeded' }); } });
    child.on('close', () => { try { finish(JSON.parse(out)); } catch (e) { finish({ ok: false, line: null, message: 'Execution failed' }); } });
    child.stdin.on('error', () => {});
    child.stdin.end(String(code || ''));
  });
}

function runPython(code) {
  return new Promise(resolve => {
    const filePath = path.join(TEMP_RUN_DIR, `run_${uid()}.py`);
    fs.writeFileSync(filePath, code);
    const cleanup = () => { try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (e) {} };

    const child = spawn('python', [filePath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      cleanup();
      resolve(result);
    };

    const timer = setTimeout(() => { child.kill('SIGKILL'); finish({ ok: false, message: 'Execution timed out (4s limit)' }); }, 4000);
    child.stdout.on('data', d => { stdout += d; if (stdout.length > 20000) { child.kill('SIGKILL'); finish({ ok: false, message: 'Output limit exceeded' }); } });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', async err => {
      clearTimeout(timer);
      cleanup();
      try {
        const pRes = await runPiston(code, 'python');
        resolve(pRes);
      } catch (pistonErr) {
        finish({ ok: false, message: 'Python is not installed or not in PATH: ' + err.message });
      }
    });
    child.on('close', exitCode => {
      if (exitCode !== 0) {
        const lineMatch = stderr.match(/line (\d+)/i);
        const line = lineMatch ? Number(lineMatch[1]) : null;
        finish({ ok: false, line, message: stderr.trim() || 'Python execution error' });
      } else {
        finish({ ok: true, output: stdout.slice(0, 5000) });
      }
    });
  });
}

function runJava(code) {
  return new Promise(resolve => {
    const dir = path.join(TEMP_RUN_DIR, `java_${uid()}`);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    let className = 'Main';
    const match = code.match(/public\s+class\s+([A-Za-z0-9_]+)/);
    if (match) className = match[1];

    const srcFile = path.join(dir, `${className}.java`);
    fs.writeFileSync(srcFile, code);
    const cleanup = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} };

    const compile = spawn('javac', ['-d', dir, srcFile], { stdio: ['ignore', 'pipe', 'pipe'] });
    let cStderr = '';
    const cTimer = setTimeout(() => { compile.kill('SIGKILL'); cleanup(); resolve({ ok: false, message: 'Java compilation timed out' }); }, 6000);

    compile.stderr.on('data', d => cStderr += d);
    compile.on('error', async err => {
      clearTimeout(cTimer);
      cleanup();
      try {
        const pRes = await runPiston(code, 'java');
        resolve(pRes);
      } catch (pistonErr) {
        resolve({ ok: false, message: 'JDK (javac) not found in PATH: ' + err.message });
      }
    });
    compile.on('close', codeExit => {
      clearTimeout(cTimer);
      if (codeExit !== 0) {
        cleanup();
        const lineMatch = cStderr.match(/:(\d+):/);
        const line = lineMatch ? Number(lineMatch[1]) : null;
        return resolve({ ok: false, line, message: 'Java Compilation Error:\n' + cStderr.trim() });
      }

      const run = spawn('java', ['-cp', dir, className], { stdio: ['ignore', 'pipe', 'pipe'] });
      let rStdout = '', rStderr = '';
      const rTimer = setTimeout(() => { run.kill('SIGKILL'); cleanup(); resolve({ ok: false, message: 'Java execution timed out (4s)' }); }, 4000);

      run.stdout.on('data', d => { rStdout += d; if (rStdout.length > 20000) { run.kill('SIGKILL'); cleanup(); resolve({ ok: false, message: 'Output limit exceeded' }); } });
      run.stderr.on('data', d => rStderr += d);
      run.on('close', runExit => {
        clearTimeout(rTimer);
        cleanup();
        if (runExit !== 0) {
          resolve({ ok: false, message: 'Java Runtime Error:\n' + rStderr.trim() });
        } else {
          resolve({ ok: true, output: rStdout.slice(0, 5000) });
        }
      });
    });
  });
}

function runCSharp(code) {
  return new Promise(resolve => {
    const dir = path.join(TEMP_RUN_DIR, `cs_${uid()}`);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const srcFile = path.join(dir, 'Program.cs');
    const exeFile = path.join(dir, 'Program.exe');
    fs.writeFileSync(srcFile, code);
    const cleanup = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} };

    const compile = spawn(CSC_PATH, ['/nologo', `/out:${exeFile}`, srcFile], { stdio: ['ignore', 'pipe', 'pipe'] });
    let cStderr = '', cStdout = '';
    const cTimer = setTimeout(() => { compile.kill('SIGKILL'); cleanup(); resolve({ ok: false, message: 'C# compilation timed out' }); }, 6000);

    compile.stdout.on('data', d => cStdout += d);
    compile.stderr.on('data', d => cStderr += d);
    compile.on('error', async err => {
      clearTimeout(cTimer);
      cleanup();
      try {
        const pRes = await runPiston(code, 'csharp');
        resolve(pRes);
      } catch (pistonErr) {
        resolve({ ok: false, message: 'C# compiler (csc) not found: ' + err.message });
      }
    });
    compile.on('close', exitCode => {
      clearTimeout(cTimer);
      if (exitCode !== 0) {
        cleanup();
        const errText = (cStdout + '\n' + cStderr).trim();
        const lineMatch = errText.match(/\((\d+),\d+\):/);
        const line = lineMatch ? Number(lineMatch[1]) : null;
        return resolve({ ok: false, line, message: 'C# Compilation Error:\n' + errText });
      }

      const run = spawn(exeFile, [], { stdio: ['ignore', 'pipe', 'pipe'] });
      let rStdout = '', rStderr = '';
      const rTimer = setTimeout(() => { run.kill('SIGKILL'); cleanup(); resolve({ ok: false, message: 'C# execution timed out (4s)' }); }, 4000);

      run.stdout.on('data', d => { rStdout += d; if (rStdout.length > 20000) { run.kill('SIGKILL'); cleanup(); resolve({ ok: false, message: 'Output limit exceeded' }); } });
      run.stderr.on('data', d => rStderr += d);
      run.on('close', runExit => {
        clearTimeout(rTimer);
        cleanup();
        if (runExit !== 0) {
          resolve({ ok: false, message: 'C# Runtime Error:\n' + rStderr.trim() });
        } else {
          resolve({ ok: true, output: rStdout.slice(0, 5000) });
        }
      });
    });
  });
}

function runNative(code, isCpp = false) {
  return new Promise(resolve => {
    const dir = path.join(TEMP_RUN_DIR, `${isCpp ? 'cpp' : 'c'}_${uid()}`);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const srcFile = path.join(dir, `main.${isCpp ? 'cpp' : 'c'}`);
    const exeFile = path.join(dir, process.platform === 'win32' ? 'main.exe' : 'main.out');
    fs.writeFileSync(srcFile, code);
    const compiler = isCpp ? 'g++' : 'gcc';
    const cleanup = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} };

    const compile = spawn(compiler, ['-o', exeFile, srcFile], { stdio: ['ignore', 'pipe', 'pipe'] });
    let cStderr = '';
    const cTimer = setTimeout(() => { compile.kill('SIGKILL'); cleanup(); resolve({ ok: false, message: `${compiler.toUpperCase()} compilation timed out` }); }, 6000);

    compile.stderr.on('data', d => cStderr += d);
    compile.on('error', async err => {
      clearTimeout(cTimer);
      cleanup();
      try {
        const pRes = await runPiston(code, isCpp ? 'cpp' : 'c');
        resolve(pRes);
      } catch (pistonErr) {
        resolve({
          ok: false,
          message: `${compiler.toUpperCase()} is not installed on this server and Piston fallback failed: ${pistonErr.message}`
        });
      }
    });
    compile.on('close', exitCode => {
      clearTimeout(cTimer);
      if (exitCode !== 0) {
        cleanup();
        const lineMatch = cStderr.match(/:(\d+):/);
        const line = lineMatch ? Number(lineMatch[1]) : null;
        return resolve({ ok: false, line, message: `${compiler.toUpperCase()} Compilation Error:\n` + cStderr.trim() });
      }

      const run = spawn(exeFile, [], { stdio: ['ignore', 'pipe', 'pipe'] });
      let rStdout = '', rStderr = '';
      const rTimer = setTimeout(() => { run.kill('SIGKILL'); cleanup(); resolve({ ok: false, message: 'Execution timed out (4s)' }); }, 4000);

      run.stdout.on('data', d => { rStdout += d; if (rStdout.length > 20000) { run.kill('SIGKILL'); cleanup(); resolve({ ok: false, message: 'Output limit exceeded' }); } });
      run.stderr.on('data', d => rStderr += d);
      run.on('close', runExit => {
        clearTimeout(rTimer);
        cleanup();
        if (runExit !== 0) {
          resolve({ ok: false, message: `${compiler.toUpperCase()} Runtime Error:\n` + rStderr.trim() });
        } else {
          resolve({ ok: true, output: rStdout.slice(0, 5000) });
        }
      });
    });
  });
}

async function runCode(code, language = 'javascript') {
  const engine = db.settings?.executionEngine || 'auto';
  const lang = String(language || 'javascript').toLowerCase().trim();

  // If cloud-only Piston engine is chosen
  if (engine === 'piston') {
    return await runPiston(code, lang);
  }

  switch (lang) {
    case 'python':
    case 'py':
      return await runPython(code);
    case 'java':
      return await runJava(code);
    case 'csharp':
    case 'c#':
    case 'cs':
      return await runCSharp(code);
    case 'c':
      return await runNative(code, false);
    case 'cpp':
    case 'c++':
      return await runNative(code, true);
    case 'javascript':
    case 'js':
    default:
      return await runJS(code);
  }
}
const norm = s => String(s || '').replace(/\r/g, '').split('\n').map(l => l.trimEnd()).join('\n').trim();

// ---------- login ----------
app.post('/api/login', (req, res) => {
  const { password, name, code } = req.body || {};
  if (password !== undefined) {
    if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Wrong password' });
    const token = uid() + uid(); adminTokens.add(token);
    return res.json({ role: 'admin', token });
  }

  const trimmedName = String(name || '').trim();
  const trimmedCode = String(code || '').trim();
  if (!trimmedName || !trimmedCode) return res.status(400).json({ error: 'Name and access code required' });

  // 1. Check if the access code belongs to a group
  const group = db.groups.find(g => g.code === trimmedCode);
  if (group) {
    let p = db.participants.find(p => p.groupId === group.id && p.name.toLowerCase() === trimmedName.toLowerCase());
    if (!p) {
      // Auto-register participant into this group
      p = { id: uid(), name: trimmedName, code: group.code, groupId: group.id, token: uid() + uid() };
      db.participants.push(p);
    } else {
      if (!p.token) p.token = uid() + uid();
      p.code = group.code;
    }
    save();
    return res.json({ role: 'participant', token: p.token, name: p.name });
  }

  // 2. Individual participant code match
  const p = db.participants.find(p => p.name.toLowerCase() === trimmedName.toLowerCase() && p.code === trimmedCode);
  if (!p) return res.status(401).json({ error: 'Invalid name or access code' });
  if (!p.token) { p.token = uid() + uid(); save(); }
  res.json({ role: 'participant', token: p.token, name: p.name });
});

// ---------- participant ----------
app.get('/api/state', partOnly, (req, res) => {
  const p = req.p;
  const group = db.groups.find(g => g.id === p.groupId);
  if (!group) return res.json({ name: p.name, status: 'nogroup' });
  const info = slotInfo(group);

  const groupLeaderboard = db.participants
    .filter(pt => pt.groupId === group.id)
    .map(pt => ({
      name: pt.name,
      score: score(pt.id),
      solved: db.solves.filter(s => s.pid === pt.id).length,
      lastSolve: Math.max(0, ...db.solves.filter(s => s.pid === pt.id).map(s => s.at)),
      isCurrent: pt.id === p.id
    }))
    .sort((a, b) => b.score - a.score || a.lastSolve - b.lastSolve);

  if (info.status !== 'running') {
    return res.json({
      name: p.name,
      group: group.name,
      status: info.status,
      groupLeaderboard
    });
  }

  const prob = db.problems[info.idx];
  res.json({
    name: p.name,
    group: group.name,
    status: 'running',
    msLeft: info.msLeft,
    index: info.idx + 1,
    total: db.problems.length,
    problem: {
      id: prob.id,
      title: prob.title,
      language: prob.language || 'javascript',
      description: prob.description,
      code: prob.code
    },
    solved: db.solves.some(s => s.pid === p.id && s.problemId === prob.id),
    groupLeaderboard
  });
});

function currentProblemFor(p) {
  const info = slotInfo(db.groups.find(g => g.id === p.groupId));
  return info.status === 'running' ? db.problems[info.idx] : null;
}
const errMsg = line => ({ ok: false, message: 'There is an error in the code.' + (line ? ` (Check around line ${line})` : '') });

app.post('/api/run', partOnly, async (req, res) => {
  const prob = currentProblemFor(req.p);
  if (!prob) return res.status(400).json({ error: 'No active problem' });
  const r = await runCode(req.body.code, prob.language);
  if (!r.ok) return res.json(r.message ? { ok: false, message: r.message } : errMsg(r.line));
  res.json({ ok: true, output: r.output });
});

// ---------- Gemini AI Integration ----------
const DEFAULT_GEMINI_MODELS = ['gemini-3.8-flash', 'gemini-3.1-flash-lite', 'gemini-3.5-flash'];

function getGeminiModels() {
  const custom = (process.env.GEMINI_MODEL || db.settings?.geminiModel || '').trim();
  const list = [custom, ...DEFAULT_GEMINI_MODELS].filter(Boolean);
  return [...new Set(list)];
}

async function callGeminiJson(prompt, systemInstruction = '', apiKey) {
  const models = getGeminiModels();
  let lastError = null;

  for (const model of models) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const body = {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: 'application/json'
        }
      };
      if (systemInstruction) {
        body.systemInstruction = { parts: [{ text: systemInstruction }] };
      }
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey
        },
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        lastError = new Error(err.error?.message || `Gemini API error ${res.status}`);
        if (res.status === 404 || res.status === 503) {
          continue;
        }
        throw lastError;
      }
      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error('Empty response from Gemini');
      const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
      return JSON.parse(cleaned);
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError || new Error('Failed to generate response from Gemini AI');
}

async function evaluateSubmissionWithAI(prob, code, output, apiKey) {
  const lang = (prob.language || 'javascript').toUpperCase();
  const prompt = `You are a hackathon code reviewer assessing a participant's submission for a ${lang} debugging challenge.

PROGRAMMING LANGUAGE:
${lang}

PROBLEM TITLE:
${prob.title}

PROBLEM DESCRIPTION / REQUIREMENTS:
${prob.description || 'Fix the bug in the code.'}

EXPECTED OUTPUT:
${prob.expected}

PARTICIPANT'S SUBMITTED CODE:
\`\`\`${prob.language || 'javascript'}
${code}
\`\`\`

EXECUTION OUTPUT:
${output}

EVALUATION TASK:
1. Did the participant actually satisfy the core requirements and fix the underlying bug, OR did they cheat / hardcode the output without solving the problem?
2. Did the solution meet all logic requirements specified in the problem statement?
3. Provide a constructive, encouraging 1-2 sentence hint or summary. Do not give away the full solution.

Respond ONLY with valid JSON in this exact structure without markdown backticks:
{
  "meetsRequirements": true,
  "feedback": "1-2 concise sentences explaining why the requirements are met OR guidance on what requirement was missed/violated"
}`;

  return await callGeminiJson(prompt, 'You are an objective, encouraging code review bot for a live debugging competition.', apiKey);
}

app.post('/api/submit', partOnly, async (req, res) => {
  const prob = currentProblemFor(req.p);
  if (!prob) return res.status(400).json({ error: 'No active problem' });
  const r = await runCode(req.body.code, prob.language);
  if (!r.ok) return res.json(r.message ? { ok: false, message: r.message } : errMsg(r.line));

  const outputMatches = norm(r.output) === norm(prob.expected);
  let meetsRequirements = outputMatches;
  let aiFeedback = null;

  const apiKey = db.settings?.geminiApiKey || process.env.GEMINI_API_KEY;
  const aiEnabled = db.settings?.aiEnabled ?? true;

  if (apiKey && aiEnabled) {
    try {
      const evaluation = await evaluateSubmissionWithAI(prob, req.body.code, r.output, apiKey);
      if (evaluation) {
        aiFeedback = evaluation.feedback;
        if (evaluation.meetsRequirements === false) {
          meetsRequirements = false;
        }
      }
    } catch (err) {
      console.warn('AI evaluation warning:', err.message);
    }
  }

  const correct = outputMatches && meetsRequirements;
  if (correct && !db.solves.some(s => s.pid === req.p.id && s.problemId === prob.id)) {
    db.solves.push({ pid: req.p.id, problemId: prob.id, at: Date.now() });
    save();
  }
  res.json({
    ok: true,
    correct,
    outputMatches,
    meetsRequirements,
    output: r.output,
    aiFeedback
  });
});

// ---------- admin ----------
app.get('/api/admin/data', adminOnly, (req, res) => {
  const participants = db.participants.map(p => ({
    id: p.id, name: p.name, code: p.code, groupId: p.groupId || null,
    score: score(p.id), solved: db.solves.filter(s => s.pid === p.id).length,
    lastSolve: Math.max(0, ...db.solves.filter(s => s.pid === p.id).map(s => s.at)),
  }));
  const groups = db.groups.map(g => ({ ...g, slot: slotInfo(g) }));
  const hasKey = Boolean(db.settings?.geminiApiKey || process.env.GEMINI_API_KEY);
  const aiEnabled = db.settings?.aiEnabled ?? true;
  res.json({
    slotMinutes: SLOT_MS / 60000,
    groups,
    participants,
    problems: db.problems,
    aiSettings: {
      hasKey,
      aiEnabled,
      geminiModel: db.settings?.geminiModel || process.env.GEMINI_MODEL || 'gemini-3.8-flash',
      executionEngine: db.settings?.executionEngine || 'auto',
      keyMasked: hasKey ? (db.settings?.geminiApiKey ? db.settings.geminiApiKey.slice(0, 6) + '...' + db.settings.geminiApiKey.slice(-4) : '(from process.env)') : ''
    }
  });
});

app.post('/api/admin/groups', adminOnly, (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name required' });
  let code = String(req.body.code || '').trim();
  if (!code) {
    do { code = genCode(); } while (db.groups.some(g => g.code === code));
  }
  const group = { id: uid(), name, code, startedAt: null };
  db.groups.push(group);
  save();
  res.json({ ok: true, group });
});
app.post('/api/admin/groups/:id/regenerate-code', adminOnly, (req, res) => {
  const g = db.groups.find(g => g.id === req.params.id);
  if (!g) return res.status(404).end();
  let code;
  do { code = genCode(); } while (db.groups.some(gr => gr.code === code));
  g.code = code;
  db.participants.forEach(p => {
    if (p.groupId === g.id) p.code = g.code;
  });
  save();
  res.json({ ok: true, code: g.code });
});
app.delete('/api/admin/groups/:id', adminOnly, (req, res) => {
  db.groups = db.groups.filter(g => g.id !== req.params.id);
  db.participants.forEach(p => { if (p.groupId === req.params.id) p.groupId = null; });
  save(); res.json({ ok: true });
});
app.post('/api/admin/groups/:id/start', adminOnly, (req, res) => {
  const g = db.groups.find(g => g.id === req.params.id); if (!g) return res.status(404).end();
  g.startedAt = Date.now(); save(); res.json({ ok: true });
});
app.post('/api/admin/groups/:id/stop', adminOnly, (req, res) => {
  const g = db.groups.find(g => g.id === req.params.id); if (!g) return res.status(404).end();
  g.startedAt = null; save(); res.json({ ok: true });
});

app.post('/api/admin/participants', adminOnly, (req, res) => {
  const names = String(req.body.names || '').split('\n').map(s => s.trim()).filter(Boolean);
  const groupId = req.body.groupId || null;
  const targetGroup = groupId ? db.groups.find(g => g.id === groupId) : null;
  names.forEach(name => {
    const code = targetGroup?.code || genCode();
    db.participants.push({ id: uid(), name, code, groupId, token: null });
  });
  save(); res.json({ ok: true, added: names.length });
});
app.put('/api/admin/participants/:id', adminOnly, (req, res) => {
  const p = db.participants.find(p => p.id === req.params.id); if (!p) return res.status(404).end();
  p.groupId = req.body.groupId || null;
  const targetGroup = p.groupId ? db.groups.find(g => g.id === p.groupId) : null;
  if (targetGroup?.code) p.code = targetGroup.code;
  save(); res.json({ ok: true });
});
app.delete('/api/admin/participants/:id', adminOnly, (req, res) => {
  db.participants = db.participants.filter(p => p.id !== req.params.id);
  db.solves = db.solves.filter(s => s.pid !== req.params.id);
  save(); res.json({ ok: true });
});

app.post('/api/admin/problems', adminOnly, (req, res) => {
  const { title, language, description, code, expected, points } = req.body;
  if (!title || !code) return res.status(400).json({ error: 'Title and code required' });
  db.problems.push({
    id: uid(),
    title,
    language: String(language || 'javascript').toLowerCase(),
    description: description || '',
    code,
    expected: expected || '',
    points: Number(points) || 10
  });
  save(); res.json({ ok: true });
});
app.delete('/api/admin/problems/:id', adminOnly, (req, res) => {
  db.problems = db.problems.filter(p => p.id !== req.params.id);
  db.solves = db.solves.filter(s => s.problemId !== req.params.id);
  save(); res.json({ ok: true });
});
app.post('/api/admin/problems/:id/move', adminOnly, (req, res) => {
  const i = db.problems.findIndex(p => p.id === req.params.id), j = i + (req.body.dir === 'up' ? -1 : 1);
  if (i < 0 || j < 0 || j >= db.problems.length) return res.json({ ok: true });
  [db.problems[i], db.problems[j]] = [db.problems[j], db.problems[i]];
  save(); res.json({ ok: true });
});
app.post('/api/admin/run-test', adminOnly, async (req, res) => {
  const { code, language } = req.body || {};
  if (!code) return res.status(400).json({ error: 'Code is required' });
  try {
    const r = await runCode(code, language || 'javascript');
    res.json(r);
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

app.post('/api/admin/reset-scores', adminOnly, (req, res) => { db.solves = []; save(); res.json({ ok: true }); });

// ---------- AI Admin Endpoints ----------
app.post('/api/admin/settings', adminOnly, (req, res) => {
  if (!db.settings) db.settings = {};
  if (req.body.geminiApiKey !== undefined) {
    db.settings.geminiApiKey = String(req.body.geminiApiKey || '').trim();
  }
  if (req.body.aiEnabled !== undefined) {
    db.settings.aiEnabled = Boolean(req.body.aiEnabled);
  }
  if (req.body.geminiModel !== undefined) {
    db.settings.geminiModel = String(req.body.geminiModel || '').trim();
  }
  if (req.body.executionEngine !== undefined) {
    db.settings.executionEngine = String(req.body.executionEngine || 'auto').trim();
  }
  save();
  res.json({ ok: true });
});

app.post('/api/admin/test-ai', adminOnly, async (req, res) => {
  const apiKey = req.body.geminiApiKey?.trim() || db.settings?.geminiApiKey || process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(400).json({ error: 'No Gemini API key provided' });
  const models = getGeminiModels();
  let lastError = null;

  for (const model of models) {
    try {
      const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey
        },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'Reply in one short sentence confirming Google Gemini connection is working properly.' }] }]
        })
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        lastError = new Error(err.error?.message || `Gemini API error (${resp.status})`);
        if (resp.status === 404 || resp.status === 503) {
          continue;
        }
        return res.status(400).json({ error: lastError.message });
      }
      const data = await resp.json();
      const reply = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || 'Connected!';
      return res.json({ ok: true, message: reply, model });
    } catch (e) {
      lastError = e;
    }
  }
  res.status(400).json({ error: lastError?.message || 'Failed to connect to Gemini API' });
});

app.post('/api/admin/generate-problem', adminOnly, async (req, res) => {
  const apiKey = db.settings?.geminiApiKey || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(400).json({ error: 'Please configure your Gemini API Key in AI Settings first.' });
  }
  const language = String(req.body.language || 'javascript').toLowerCase().trim();
  const topic = String(req.body.topic || '').trim() || `${language} syntax, logic, boundary check, or algorithm bugs`;
  const difficulty = String(req.body.difficulty || 'Medium');

  const printGuidance = {
    javascript: 'console.log(...)',
    python: 'print(...)',
    java: 'System.out.println(...)',
    csharp: 'Console.WriteLine(...)',
    c: 'printf(...) in <stdio.h>',
    cpp: 'std::cout in <iostream>'
  }[language] || 'standard output';

  const prompt = `Create an educational ${language.toUpperCase()} debugging challenge for a live hackathon competition.
Target Language: ${language}
Topic: ${topic}
Difficulty: ${difficulty}

Rules:
1. The code must be 100% valid ${language}.
2. The buggy code should contain a realistic bug (logic flaw, boundary error, off-by-one, type issue).
3. The fixed code must print output to stdout using ${printGuidance}.
4. Provide the EXACT expected stdout output string that the fixed code produces.

Respond ONLY with valid JSON in this exact structure without markdown backticks:
{
  "title": "Short descriptive title",
  "language": "${language}",
  "description": "Clear problem statement explaining what the program should do and the requirements it must satisfy.",
  "code": "The buggy code that participants need to fix",
  "expected": "Exact expected stdout string",
  "points": 10
}`;

  try {
    const problem = await callGeminiJson(prompt, 'You are an expert computer science hackathon challenge designer.', apiKey);
    res.json({ ok: true, problem });
  } catch (e) {
    res.status(500).json({ error: 'Failed to generate problem: ' + e.message });
  }
});

app.listen(PORT, () => {
  console.log(`Hackathon site running on http://localhost:${PORT}`);
  if (!process.env.ADMIN_PASSWORD) console.log('WARNING: using default admin password "admin123". Set ADMIN_PASSWORD before going live.');
});
