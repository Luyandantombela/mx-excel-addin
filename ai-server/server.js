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
function buildPrompt(userMessage, headers, sampleData, previousCode) {
  if (previousCode) {
    return [
      'You are a data cleaning code generator for Microsoft Excel.',
      '',
      'COLUMNS: ' + JSON.stringify(headers),
      '',
      'EXISTING FUNCTION — modify it to apply the change below, keep everything else unchanged:',
      previousCode.slice(0, 3000),
      '',
      'CHANGE REQUESTED: ' + userMessage,
      '',
      COMMENT_FORMAT
    ].join('\n');
  }

  return [
    'You are a data cleaning code generator for Microsoft Excel.',
    '',
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
  const { userMessage, headers, sampleData, previousCode, previousName } = req.body || {};

  if (!userMessage || !Array.isArray(headers) || headers.length === 0) {
    return res.status(400).json({ error: 'Missing required fields: userMessage, headers' });
  }

  const prompt = buildPrompt(userMessage, headers, sampleData || [], previousCode || null);
  const fallbackName = previousName || null;

  /* Primary attempt */
  let raw = '';
  try {
    const msg = await anthropic.messages.create({
      model:      'claude-3-5-sonnet-20241022',
      max_tokens: 4096,
      messages:   [{ role: 'user', content: prompt }]
    });
    raw = (msg.content[0] && msg.content[0].text) || '';
  } catch (err) {
    console.error('[Primary] Claude error:', err.message);
    return res.status(502).json({ error: 'AI service unavailable: ' + err.message });
  }

  let parsed = parseResponse(raw, fallbackName);

  /* Automatic internal retry with a simpler prompt — user never sees this */
  if (!parsed) {
    console.log('[Retry] Primary parse failed, trying fallback prompt…');
    const fallbackPrompt = buildFallbackPrompt(userMessage, headers, previousCode || null);
    try {
      const msg2 = await anthropic.messages.create({
        model:      'claude-3-5-sonnet-20241022',
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
      model:      'claude-3-5-sonnet-20241022',
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

/* ── /health ─────────────────────────────────────────────────────────── */
app.get('/health', (_req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

/* ── Start ───────────────────────────────────────────────────────────── */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`MX AI Server listening on port ${PORT}`));
