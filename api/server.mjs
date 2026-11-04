// Nilemy API: the Premium "For you today" note on the app's Home screen.
// Runs in its own container next to the site (deploy/add-api.sh) and is reached at
// https://nilemy.com/api/daily-note through the existing Caddy proxy.
//
// POST /api/daily-note   body: a short JSON summary of the user's logs (counts and labels only)
//                        header: Authorization: Bearer <Firebase ID token of a nilemy-app user>
//                        -> { text }   One note per account per day; the same day returns the kept note.
// DELETE /api/daily-note forget the kept note and patterns (Delete account).
// POST /api/patterns     body: day-by-day labels from the user's last completed cycles (no dates, notes or sex logs)
//                        -> { items: [{ title, text }] }   Kept per account until the logs gain a cycle ("key").
// GET /api/health        -> ok
//
// Env: ANTHROPIC_API_KEY (required), MODEL (default claude-opus-5-5), DAILY_CAP (default 3000),
// DATA_DIR (default /data). Nothing about a person is kept except today's note and the latest
// patterns, by account id.

import Anthropic from '@anthropic-ai/sdk';
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const PORT = Number(process.env.PORT ?? 8080);
const MODEL = process.env.MODEL || 'claude-opus-5-5';
const DAILY_CAP = Number(process.env.DAILY_CAP ?? 3000);
const DATA = path.join(process.env.DATA_DIR ?? '/data', 'notes.json');
const PATTERN_DATA = path.join(process.env.DATA_DIR ?? '/data', 'patterns.json');
const MAX_BODY = 3000;
const MAX_PATTERN_BODY = 24000;

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY is not set');
  process.exit(1);
}

initializeApp({ projectId: 'nilemy-app' });
const auth = getAuth();
const claude = new Anthropic();

const LANG_NAME = { en: 'English', tr: 'Turkish', de: 'German', fr: 'French', pt: 'Brazilian Portuguese', it: 'Italian' };

const SYSTEM = `You write the "For you today" note on the home screen of Nilemy, a period tracking app.
You get a short JSON summary of one person's own logs. Write a note for today in the language given in "lang".

What a good note does:
- Points out one useful thing the logs show for today or the next days, and, when it fits, one practical thing to do about it. Example of the kind of content: cramps usually start on day 1 in their recent cycles and their period is due tomorrow, so keeping a hot water bottle at hand helps.
- Uses only what is in the summary. Never invent numbers, dates or symptoms. If the summary has little in it, give one practical point for the current cycle phase.
- In conceive mode, focus on the fertile days and tests.

Style:
- At most 2 sentences and 220 characters. Plain text: no emoji, no markdown, no quotes, no greeting, no sign-off, no name.
- Address the person informally (tr: "sen", de: "du", fr: "tu", pt: "você", it: "tu").
- Say "your logs show" or "in your last cycles", never "studies show" or "it is known".
- Not medical: no diagnosis, no reassurance or warning about health, no medication names or doses. Never call anything "normal" or "abnormal".
- Never use these words or anything that sounds like them: calm, gentle, soft, soothing, relax, sakin, nazik, yumuşak, rahatla, sanft, ruhig, doux, doucement, calme, tranquilo, suave, calmo, dolce.
- Do not just repeat the number of days until the next period; the screen already shows it.`;

// uid -> { date, lang, text, count }; today's notes only, saved to disk so a restart keeps them.
let notes = new Map();
try {
  notes = new Map(Object.entries(JSON.parse(readFileSync(DATA, 'utf8'))));
} catch {
  // First start or unreadable file: start empty.
}
let made = { date: '', count: 0 };

function save() {
  const today = new Date().toISOString().slice(0, 10);
  // Keep yesterday and today (time zones differ); drop the rest.
  const keep = new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 10);
  for (const [uid, n] of notes) if (n.date < keep) notes.delete(uid);
  writeFileSync(`${DATA}.tmp`, JSON.stringify(Object.fromEntries(notes)));
  renameSync(`${DATA}.tmp`, DATA);
  if (made.date !== today) made = { date: today, count: 0 };
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function user(req) {
  const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
  if (!token) return null;
  try {
    return (await auth.verifyIdToken(token)).uid;
  } catch {
    return null;
  }
}

function readBody(req, max = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > max) {
        reject(new Error('too big'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function write(summary, lang) {
  const res = await claude.beta.messages.create({
    model: MODEL,
    max_tokens: 2000,
    output_config: { effort: 'low' },
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: SYSTEM,
    messages: [{ role: 'user', content: `Write today's note in ${LANG_NAME[lang]}.\n\n${JSON.stringify(summary)}` }],
  });
  if (res.stop_reason === 'refusal') return null;
  const text = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('').trim();
  return text.replace(/^["“”']+|["“”']+$/g, '').slice(0, 400) || null;
}

async function dailyNote(req, res) {
  const uid = await user(req);
  if (!uid) return send(res, 401, { error: 'sign-in' });
  if (req.method === 'DELETE') {
    notes.delete(uid);
    save();
    if (found.delete(uid)) saveFound();
    return send(res, 200, { ok: true });
  }
  let summary;
  try {
    summary = JSON.parse(await readBody(req));
  } catch {
    return send(res, 400, { error: 'bad-summary' });
  }
  const lang = Object.hasOwn(LANG_NAME, summary?.lang) ? summary.lang : null;
  const date = typeof summary?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(summary.date) ? summary.date : null;
  if (!lang || !date) return send(res, 400, { error: 'bad-summary' });

  const kept = notes.get(uid);
  if (kept?.date === date && kept.lang === lang) return send(res, 200, { text: kept.text });
  // One new note a day per account (a language change may ask once more).
  if (kept?.date === date && kept.count >= 2) return send(res, 429, { error: 'tomorrow' });
  const today = new Date().toISOString().slice(0, 10);
  if (made.date !== today) made = { date: today, count: 0 };
  if (made.count >= DAILY_CAP) return send(res, 503, { error: 'busy' });

  let text;
  try {
    made.count++;
    text = await write(summary, lang);
  } catch (e) {
    console.error('claude', e instanceof Anthropic.APIError ? `${e.status} ${e.message}` : e);
    return send(res, 503, { error: 'busy' });
  }
  if (!text) return send(res, 503, { error: 'no-note' });
  notes.set(uid, { date, lang, text, count: kept?.date === date ? kept.count + 1 : 1 });
  save();
  return send(res, 200, { text });
}

const PATTERN_SYSTEM = `You write the "Your patterns" card on the Insights screen of Nilemy, a period tracking app.
You get one person's own logs from their last completed cycles as JSON: for each cycle its length and period length,
and for each logged day the cycle number, cycle day, days until the next period and what was logged that day
(flow, pain, mood, energy, symptoms, products such as painkiller or heat). Find what keeps repeating in these logs.

What to look for:
- Things that come back at the same point of the cycle (a symptom 2 days before the period, low energy on day 1).
- Things that come together (on days with headache, mood is often low; painkiller days are mostly the first two period days).
- Changes across cycles (cramps logged on fewer days in recent cycles, cycles getting shorter).

Rules:
- Only patterns seen in at least 2 different cycles. Use only what is in the data; never invent numbers or symptoms.
  Say how many cycles it was seen in when it helps ("in 3 of your last 4 cycles").
- Up to 4 items, the most useful first. Fewer is fine; an empty list is fine when nothing repeats.
- Each item: a title of at most 50 characters and a text of at most 180 characters with one practical point when it fits.
- Language: the one named by the user message. Address the person informally (tr: "sen", de: "du", fr: "tu", pt: "você", it: "tu").
- Plain text: no emoji, no markdown, no quotes, no greeting, no name.
- Not medical: no diagnosis or cause, no reassurance or warning about health, no medication names or doses.
  Never call anything "normal" or "abnormal". Say "your logs show", never "studies show".
- Never use these words or anything that sounds like them: calm, gentle, soft, soothing, relax, sakin, nazik, yumuşak, rahatla,
  sanft, ruhig, doux, doucement, calme, tranquilo, suave, calmo, dolce.`;

const PATTERN_FORMAT = {
  type: 'json_schema',
  schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: { title: { type: 'string' }, text: { type: 'string' } },
          required: ['title', 'text'],
          additionalProperties: false,
        },
      },
    },
    required: ['items'],
    additionalProperties: false,
  },
};

// uid -> { key, lang, items, date, count }: the latest patterns per account, saved to disk.
let found = new Map();
try {
  found = new Map(Object.entries(JSON.parse(readFileSync(PATTERN_DATA, 'utf8'))));
} catch {
  // First start or unreadable file: start empty.
}

function saveFound() {
  writeFileSync(`${PATTERN_DATA}.tmp`, JSON.stringify(Object.fromEntries(found)));
  renameSync(`${PATTERN_DATA}.tmp`, PATTERN_DATA);
}

async function findPatterns(logs, lang) {
  const res = await claude.beta.messages.create({
    model: MODEL,
    max_tokens: 4000,
    output_config: { effort: 'low', format: PATTERN_FORMAT },
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: PATTERN_SYSTEM,
    messages: [{ role: 'user', content: `Write the patterns in ${LANG_NAME[lang]}.\n\n${JSON.stringify(logs)}` }],
  });
  if (res.stop_reason === 'refusal' || res.stop_reason === 'max_tokens') return null;
  const text = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  const items = JSON.parse(text).items;
  if (!Array.isArray(items)) return null;
  return items
    .filter((i) => typeof i?.title === 'string' && typeof i?.text === 'string' && i.title.trim() && i.text.trim())
    .slice(0, 4)
    .map((i) => ({ title: i.title.trim().slice(0, 80), text: i.text.trim().slice(0, 260) }));
}

async function patternsRoute(req, res) {
  const uid = await user(req);
  if (!uid) return send(res, 401, { error: 'sign-in' });
  if (req.method === 'DELETE') {
    if (found.delete(uid)) saveFound();
    return send(res, 200, { ok: true });
  }
  let logs;
  try {
    logs = JSON.parse(await readBody(req, MAX_PATTERN_BODY));
  } catch {
    return send(res, 400, { error: 'bad-logs' });
  }
  const lang = Object.hasOwn(LANG_NAME, logs?.lang) ? logs.lang : null;
  const key = typeof logs?.key === 'string' && logs.key.length <= 40 ? logs.key : null;
  if (!lang || !key || !Array.isArray(logs?.cycles) || !Array.isArray(logs?.days)) return send(res, 400, { error: 'bad-logs' });

  const kept = found.get(uid);
  if (kept?.key === key && kept.lang === lang) return send(res, 200, { items: kept.items });
  // At most 3 new answers a day per account (a new cycle, a language change).
  const today = new Date().toISOString().slice(0, 10);
  if (kept?.date === today && kept.count >= 3) return send(res, 429, { error: 'tomorrow' });
  if (made.date !== today) made = { date: today, count: 0 };
  if (made.count >= DAILY_CAP) return send(res, 503, { error: 'busy' });

  let items;
  try {
    made.count++;
    const { key: _, ...rest } = logs;
    items = await findPatterns(rest, lang);
  } catch (e) {
    console.error('claude', e instanceof Anthropic.APIError ? `${e.status} ${e.message}` : e);
    return send(res, 503, { error: 'busy' });
  }
  if (!items) return send(res, 503, { error: 'no-patterns' });
  found.set(uid, { key, lang, items, date: today, count: kept?.date === today ? kept.count + 1 : 1 });
  saveFound();
  return send(res, 200, { items });
}

http
  .createServer((req, res) => {
    const url = (req.url ?? '').split('?')[0];
    if (url === '/api/health') return send(res, 200, { ok: true });
    if (url === '/api/daily-note' && (req.method === 'POST' || req.method === 'DELETE')) {
      return dailyNote(req, res).catch((e) => {
        console.error(e);
        send(res, 500, { error: 'server' });
      });
    }
    if (url === '/api/patterns' && (req.method === 'POST' || req.method === 'DELETE')) {
      return patternsRoute(req, res).catch((e) => {
        console.error(e);
        send(res, 500, { error: 'server' });
      });
    }
    send(res, 404, { error: 'not-found' });
  })
  .listen(PORT, () => console.log(`nilemy-api on ${PORT}, model ${MODEL}`));
