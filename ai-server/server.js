'use strict';

const express   = require('express');
const cors      = require('cors');
const Anthropic = require('@anthropic-ai/sdk');

const app      = express();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.use(cors());
app.use(express.json({ limit: '512kb' }));

/* ── Prompt constants ────────────────────────────────────────────────── */
const GENERALIZATION = `
ROBUSTNESS RULES — code must handle ANY future upload, not just the sample:
  - Treat sample data as column-type hints only. Do NOT hardcode specific values.
  - Dates: handle ISO, US (MM/DD/YYYY), EU (DD/MM/YYYY), long-form text, Excel serial numbers, and blanks.
  - Numbers: strip $£€, commas, % signs; keep negatives; replace pure-text cells with 0.
  - Text: always guard null/undefined — use String(cell || '').trim(), never cell.trim().
  - Emails: validate with a general RFC regex, not patterns from the sample.
  - IDs/codes: normalise generically (trim, pad, case) — not pattern-matched to sample values.
`.trim();

const COMMENT_FORMAT = `
OUTPUT FORMAT — respond with exactly this structure and nothing else:
// NAME: [5-word max workflow name]
// SUMMARY: [15-word max summary]
// EXPLANATION: [2-4 plain-English sentences describing what each column transform does]
function runCleaningCode(data) {
  // your code here
}

No JSON. No markdown fences. No prose before or after. Just the comments + function.
`.trim();

/* ── Prompt builders ─────────────────────────────────────────────────── */

/* Initial (first message) prompt */
function buildInitialPrompt(userMessage, headers, sampleData) {
  return [
    'COLUMNS: ' + JSON.stringify(headers),
    'SAMPLE DATA (rows 1-7, for column type hints only): ' + JSON.stringify(sampleData),
    '',
    'USER REQUEST: ' + userMessage,
    '',
    'Write a JavaScript function runCleaningCode(data) where:',
    '  - data is a 2D array; first row is headers',
    '  - returns the cleaned 2D array (headers as first row)',
    '  - vanilla JS only — no imports, no fetch, no eval',
    '  - deep-copies input before modifying (never mutate the original)',
    '  - removes fully blank rows after all other transforms',
    '',
    GENERALIZATION,
    '',
    COMMENT_FORMAT
  ].join('\n');
}

/*
 * Build the Claude messages array for a refinement.
 * We replay the conversation as multi-turn messages so Claude has
 * true memory of every previously approved change.
 *
 * Structure:
 *   user  → original generation request
 *   asst  → the current approved code  (Claude "remembers" producing this)
 *   user  → each subsequent refinement the user asked for (from history)
 *   asst  → the same approved code repeated (stable reference point)
 *   user  → the NEW change being requested right now
 */
function buildRefinementMessages(userMessage, headers, sampleData, previousCode, conversation) {
  const msgs = [];

  /* Find the first user turn in the stored conversation — the original request */
  const firstUserTurn = (conversation || []).find(t => t.role === 'user');
  const firstRequest  = firstUserTurn ? firstUserTurn.content : userMessage;

  /* Turn 1: original generation */
  msgs.push({
    role:    'user',
    content: buildInitialPrompt(firstRequest, headers, sampleData)
  });
  /* Turn 2: Claude's "previous answer" = the current approved function */
  msgs.push({
    role:    'assistant',
    content: previousCode
  });

  /* Replay intermediate refinements so Claude sees the full edit history */
  const refinements = (conversation || []).filter(t => t.role === 'user').slice(1);
  for (const turn of refinements) {
    msgs.push({
      role:    'user',
      content: 'REFINEMENT: ' + turn.content + '\n\nKeep every other existing transform exactly as-is. Only apply this one change.\n\n' + COMMENT_FORMAT
    });
    /* Repeat the approved code as Claude's answer after each refinement */
    msgs.push({
      role:    'assistant',
      content: previousCode
    });
  }

  /* Final turn: the NEW change being requested now */
  msgs.push({
    role:    'user',
    content: [
      'REFINEMENT: ' + userMessage,
      '',
      'RULES:',
      '1. Start from the APPROVED function above — do NOT rewrite from scratch.',
      '2. Add or adjust ONLY what the user just asked for.',
      '3. Every other transform already in the function must remain unchanged.',
      '4. Do NOT remove any existing logic even if you think it could be simplified.',
      '',
      COMMENT_FORMAT
    ].join('\n')
  });

  return msgs;
}

function buildFallbackPrompt(userMessage, headers, previousCode) {
  if (previousCode) {
    return (
      'Output ONLY the updated JavaScript function. No explanation, no markdown fences, no prose.\n\n' +
      'CHANGE TO APPLY: ' + userMessage + '\n\n' +
      'FUNCTION TO MODIFY:\n' + previousCode.slice(0, 3000)
    );
  }
  return (
    'Output ONLY a complete JavaScript function named runCleaningCode(data).\n' +
    'No explanation, no markdown fences, no prose — just the function.\n' +
    'The function takes a 2D array (first row = headers) and returns the cleaned 2D array.\n\n' +
    'Columns: ' + JSON.stringify(headers) + '\n' +
    'Request: ' + userMessage
  );
}

/* ── Response parser ─────────────────────────────────────────────────── */
function parseResponse(raw, fallbackName) {
  raw = (raw || '').replace(/```[\w]*\n?/g, '').trim();

  const nameM = raw.match(/^\/\/\s*NAME:\s*(.+)/im);
  const summM = raw.match(/^\/\/\s*SUMMARY:\s*(.+)/im);
  const expM  = raw.match(/\/\/\s*EXPLANATION:\s*([\s\S]*?)(?=\nfunction\s)/i)
             || raw.match(/\/\/\s*EXPLANATION:\s*(.+)/i);

  const name        = nameM ? nameM[1].trim().slice(0, 60)  : (fallbackName || 'Cleaning workflow');
  const summary     = summM ? summM[1].trim().slice(0, 120) : '';
  const explanation = expM
    ? expM[1].replace(/^\/\/\s*/gm, '').trim().slice(0, 500)
    : 'Applied your requested changes.';

  /* Brace-match to extract the complete function body */
  const fi = raw.indexOf('function runCleaningCode');
  if (fi === -1) return null;

  let depth = 0, fe = -1;
  for (let i = fi; i < raw.length; i++) {
    if (raw[i] === '{')      depth++;
    else if (raw[i] === '}') { depth--; if (depth === 0) { fe = i + 1; break; } }
  }
  if (fe === -1) return null;

  return { name, summary, explanation, code: raw.slice(fi, fe) };
}

/* ── /api/clean  ─────────────────────────────────────────────────────── */
app.post('/api/clean', async (req, res) => {
  const { userMessage, headers, sampleData, previousCode, previousName, conversation } = req.body || {};

  if (!userMessage || !Array.isArray(headers) || headers.length === 0) {
    return res.status(400).json({ error: 'Missing required fields: userMessage, headers' });
  }

  const fallbackName = previousName || null;
  const isRefinement = !!previousCode;

  /* Build Claude messages — multi-turn for refinements, single-turn for new requests */
  const messages = isRefinement
    ? buildRefinementMessages(userMessage, headers, sampleData || [], previousCode, conversation || [])
    : [{ role: 'user', content: buildInitialPrompt(userMessage, headers, sampleData || []) }];

  /* Primary attempt */
  let raw = '';
  try {
    const msg = await anthropic.messages.create({
      model:      'claude-opus-4-5',
      max_tokens: 4096,
      messages
    });
    raw = (msg.content[0] && msg.content[0].text) || '';
  } catch (err) {
    console.error('[Primary] Claude error:', err.message);
    return res.status(502).json({ error: 'AI service unavailable: ' + err.message });
  }

  let parsed = parseResponse(raw, fallbackName);

  /* Automatic internal retry with a simpler single-turn fallback — user never sees this */
  if (!parsed) {
    console.log('[Retry] Primary parse failed, trying fallback prompt…');
    const fallbackPrompt = buildFallbackPrompt(userMessage, headers, previousCode || null);
    try {
      const msg2 = await anthropic.messages.create({
        model:      'claude-opus-4-5',
        max_tokens: 4096,
        messages:   [{ role: 'user', content: fallbackPrompt }]
      });
      raw = (msg2.content[0] && msg2.content[0].text) || '';
      parsed = parseResponse(raw, fallbackName);
    } catch (err2) {
      console.error('[Retry] Claude error:', err2.message);
    }
  }

  if (!parsed) {
    return res.status(422).json({
      error: 'Could not generate a valid cleaning function. Try rephrasing your request.',
      hint:  'Example: "Capitalise the Name column and format Order Amount to 2 decimal places."'
    });
  }

  return res.json(parsed);
});

/* ── /api/describe  ──────────────────────────────────────────────────── */
app.post('/api/describe', async (req, res) => {
  const { code } = req.body || {};
  if (!code) return res.status(400).json({ error: 'Missing code' });

  const prompt =
    'The following JavaScript function cleans spreadsheet data.\n' +
    'In 3-5 plain-English sentences (no code, no bullet points), explain what it does to each column.\n' +
    'End your response with exactly: "What would you like to change?"\n\n' +
    'FUNCTION:\n' + code.slice(0, 3000);

  try {
    const msg = await anthropic.messages.create({
      model:      'claude-opus-4-5',
      max_tokens: 512,
      messages:   [{ role: 'user', content: prompt }]
    });
    const description = (msg.content[0] && msg.content[0].text) || '';
    return res.json({ description });
  } catch (err) {
    /* Fallback — just return empty so the add-in uses the stored explanation */
    return res.json({ description: '' });
  }
});

/* ── / (root status page) ────────────────────────────────────────────── */
app.get('/', (_req, res) => {
  res.send(
    '<html><body style="font-family:sans-serif;padding:40px">' +
    '<h2>✅ MX AI Server is running</h2>' +
    '<p>Endpoints:</p><ul>' +
    '<li><code>POST /api/clean</code> — generate a cleaning workflow</li>' +
    '<li><code>POST /api/describe</code> — describe an existing workflow</li>' +
    '<li><code>GET /health</code> — health check</li>' +
    '</ul></body></html>'
  );
});

/* ── /health ─────────────────────────────────────────────────────────── */
app.get('/health', (_req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

/* ── Start ───────────────────────────────────────────────────────────── */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`MX AI Server listening on port ${PORT}`));
