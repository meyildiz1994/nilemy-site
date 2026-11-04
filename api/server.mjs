// Nilemy API for the "For you today" note on the app's Home screen (Premium). Runs in its own
// container next to the site (deploy/add-api.sh) and is reached at https://nilemy.com/api/ through
// the existing Caddy proxy.
//
// GET /api/daily-note?lang=tr&mode=cycle&phase=Luteal&date=2026-11-04
//                        -> { text }   A general note for that cycle phase and mode, in that language.
//                        Written once a day per phase, mode and language and given to everyone who asks
//                        for the same: nothing about a person is sent, to this server or to Claude.
// GET /api/health        -> ok once Claude has taken the key and settings (asked once at start)
//
// Env: ANTHROPIC_API_KEY (required), MODEL (default claude-opus-5-5), INFERENCE_GEO (default us),
// DAILY_CAP (default 500 new notes a day), DATA_DIR (default /data). The notes are kept in memory for
// 3 days; nothing is written to disk. Answers the earlier per-account versions saved there
// (notes.json, patterns.json) are deleted at start.

import Anthropic from '@anthropic-ai/sdk';
import { rmSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const PORT = Number(process.env.PORT ?? 8080);
const MODEL = process.env.MODEL || 'claude-opus-5-5';
const GEO = process.env.INFERENCE_GEO ?? 'us';
const DAILY_CAP = Number(process.env.DAILY_CAP ?? 500);
const DATA_DIR = process.env.DATA_DIR ?? '/data';
const DAY = 24 * 3600e3;
const KEPT = 3 * DAY;

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY is not set');
  process.exit(1);
}

const claude = new Anthropic({ timeout: 60_000, maxRetries: 1 });

const LANG_NAME = { en: 'English', tr: 'Turkish', de: 'German', fr: 'French', pt: 'Brazilian Portuguese', it: 'Italian' };
const PHASES = {
  Menstrual: 'the period (menstrual phase)',
  Follicular: 'the follicular phase, after the period and before ovulation',
  Ovulation: 'the days around ovulation (the fertile window)',
  Luteal: 'the luteal phase, after ovulation and before the next period',
  Neutral: 'an unknown phase (cycles not logged enough yet, or irregular)',
};
const MODES = {
  cycle: 'tracking their cycle (not trying to get pregnant)',
  conceive: 'trying to get pregnant',
};
/** What today's note is about, so the note changes from day to day. */
const TOPICS = ['what happens in the body now', 'food and drink', 'movement and exercise', 'sleep and energy', 'mood', 'a practical tip for logging or planning the day'];

const SYSTEM = `You write the "For you today" note on the home screen of Nilemy, a period tracking app.
The note is general: you know only the person's cycle phase, whether they are trying to get pregnant, and the language.
Everyone in the same phase, mode and language reads the same note today.

What a good note does:
- Says one useful, well-established thing about this phase for the topic given, and one practical thing to do.
- In conceive mode, focus on fertility, timing and tests.

Style:
- At most 2 sentences and 220 characters. Plain text: no emoji, no markdown, no quotes, no greeting, no sign-off.
- Address the reader informally (tr: "sen", de: "du", fr: "tu", pt: "você", it: "tu").
- Never claim to know anything about the reader's own logs or body ("your logs", "you logged", "you usually").
- Not medical: no diagnosis, no medication names or doses, no reassurance or warning about health. Never call anything "normal" or "abnormal". Never say "studies show".
- Never mention AI, Claude or that the note was written for many people.
- Never use the word "pattern" or its translations (örüntü, Muster, motif, tendance, padrão, modello, schema).
- Never use these words or anything that sounds like them: calm, gentle, soft, soothing, relax, sakin, nazik, yumuşak, rahatla, sanft, ruhig, doux, doucement, calme, tranquilo, suave, calmo, dolce.`;

/** One Claude call with the settings the note and the start check share. */
function ask({ system, content, maxTokens }, options) {
  return claude.beta.messages.create(
    {
      model: MODEL,
      max_tokens: maxTokens,
      output_config: { effort: 'low' },
      ...(GEO ? { inference_geo: GEO } : null),
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system,
      messages: [{ role: 'user', content }],
    },
    options,
  );
}

const logClaude = (what, e) => console.error(what, e instanceof Anthropic.APIError ? `${e.status ?? ''} ${e.message}` : e);

// Claude is asked once at start, with the same settings, so a bad key, model or region shows up in the
// health check add-api.sh runs after each deploy (and the deploy rolls back) instead of for a user later.
let ready = null;
function checkClaude() {
  ready ??= ask({ system: 'Reply with one word.', content: 'Say ok.', maxTokens: 200 }, { timeout: 20_000 }).then(
    () => true,
    (e) => {
      logClaude('claude check', e);
      // A refused setting stays refused; a busy or unreachable API is asked again at the next check.
      const status = e instanceof Anthropic.APIError ? (e.status ?? 0) : 0;
      if (!(status >= 400 && status < 500 && status !== 408 && status !== 429)) ready = null;
      return false;
    },
  );
  return ready;
}

// "date|lang|mode|phase" -> { text, at }, or the request still being written.
const notes = new Map();
const writing = new Map();
let made = { day: '', count: 0 };

function prune() {
  const now = Date.now();
  for (const [key, e] of notes) if (now - e.at > KEPT) notes.delete(key);
}

function send(res, status, body, cache = 'no-store') {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': cache });
  res.end(JSON.stringify(body));
}

/** The phone's date, accepted only within a day of the server's (time zones), so old or future days can't be asked for. */
function validDate(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const diff = Date.parse(`${date}T12:00:00Z`) - Date.now();
  return Math.abs(diff) <= 1.6 * DAY;
}

async function write(lang, mode, phase, date) {
  const day = Math.floor(Date.parse(date) / DAY);
  const topic = TOPICS[day % TOPICS.length];
  const res = await ask({
    system: SYSTEM,
    maxTokens: 2000,
    content: `Write today's note in ${LANG_NAME[lang]}. The reader is in ${PHASES[phase]} and is ${MODES[mode]}. Topic for today: ${topic}.`,
  });
  if (res.stop_reason === 'refusal') return null;
  const text = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('').trim();
  return text.replace(/^["“”']+|["“”']+$/g, '').slice(0, 400) || null;
}

async function dailyNote(res, query) {
  const lang = query.get('lang');
  const mode = query.get('mode');
  const phase = query.get('phase');
  const date = query.get('date');
  if (!Object.hasOwn(LANG_NAME, lang) || !Object.hasOwn(MODES, mode) || !Object.hasOwn(PHASES, phase) || !validDate(date)) {
    return send(res, 400, { error: 'bad-request' });
  }
  const key = `${date}|${lang}|${mode}|${phase}`;
  const kept = notes.get(key);
  if (kept) return send(res, 200, { text: kept.text }, 'public, max-age=3600');

  let job = writing.get(key);
  if (!job) {
    const today = new Date().toISOString().slice(0, 10);
    if (made.day !== today) made = { day: today, count: 0 };
    if (made.count >= DAILY_CAP) return send(res, 503, { error: 'busy' });
    made.count++;
    job = write(lang, mode, phase, date).finally(() => writing.delete(key));
    writing.set(key, job);
  }
  let text;
  try {
    text = await job;
  } catch (e) {
    logClaude('claude', e);
    return send(res, 503, { error: 'busy' });
  }
  if (!text) return send(res, 503, { error: 'no-note' });
  prune();
  notes.set(key, { text, at: Date.now() });
  return send(res, 200, { text }, 'public, max-age=3600');
}

http
  .createServer((req, res) => {
    const [url, search] = (req.url ?? '').split('?');
    if (url === '/api/health') return checkClaude().then((ok) => send(res, ok ? 200 : 503, ok ? { ok } : { error: 'claude' }));
    // 2.1 test builds still ask to delete their account's answers: nothing is kept per account any more.
    if (req.method === 'DELETE' && (url === '/api/daily-note' || url === '/api/patterns')) return send(res, 200, { ok: true });
    if (url !== '/api/daily-note' || req.method !== 'GET') return send(res, 404, { error: 'not-found' });
    dailyNote(res, new URLSearchParams(search ?? '')).catch((e) => {
      console.error(e);
      if (!res.headersSent) send(res, 500, { error: 'server' });
    });
  })
  .listen(PORT, () => {
    console.log(`nilemy-api on ${PORT}, model ${MODEL}, inference ${GEO || 'workspace default'}`);
    // Answers the per-account versions kept by account id: gone.
    for (const f of ['notes.json', 'patterns.json', 'notes.json.tmp', 'patterns.json.tmp']) rmSync(path.join(DATA_DIR, f), { force: true });
    setInterval(prune, 3600e3).unref();
    checkClaude();
  });
