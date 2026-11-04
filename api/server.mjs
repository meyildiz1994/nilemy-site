// Nilemy API for the app's two Premium AI features: the "For you today" note on Home and
// "What repeats in your cycles" in Insights. Runs in its own container next to the site
// (deploy/add-api.sh) and is reached at https://nilemy.com/api/ through the existing Caddy proxy.
//
// POST /api/daily-note   body: a short JSON summary of the user's logs (counts and labels only)
//                        header: Authorization: Bearer <Firebase ID token of a nilemy-app user>
//                        -> { text }   One note per account per day; the same day returns the kept note.
// POST /api/patterns     body: day-by-day labels from the user's last completed cycles (no dates, notes or sex logs)
//                        -> { items: [{ title, text }] }   Kept per account until those logs change ("key").
// DELETE either path     forgets the kept note and repeats (AI turned off, Delete all data, Delete account).
//                        An answer Claude is still writing then is not kept either.
// GET /api/health        -> ok once Claude has taken the key and settings (asked once at start)
//
// Env: ANTHROPIC_API_KEY (required), MODEL (default claude-opus-5-5), INFERENCE_GEO (default us:
// Claude runs in the US only; empty for the workspace default), DAILY_CAP (default 3000),
// DATA_DIR (default /data). Nothing about a person is kept except, by account id, the last note
// (48 hours at most) and the latest repeats (60 days at most). Claude never gets the account id
// or a date.

import Anthropic from '@anthropic-ai/sdk';
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const PORT = Number(process.env.PORT ?? 8080);
const MODEL = process.env.MODEL || 'claude-opus-5-5';
const GEO = process.env.INFERENCE_GEO ?? 'us';
const DAILY_CAP = Number(process.env.DAILY_CAP ?? 3000);
const DATA = path.join(process.env.DATA_DIR ?? '/data', 'notes.json');
const PATTERN_DATA = path.join(process.env.DATA_DIR ?? '/data', 'patterns.json');
const MAX_BODY = 8000;
const MAX_PATTERN_BODY = 24000;
const HOUR = 3600e3;
const NOTE_KEPT = 48 * HOUR;
const REPEATS_KEPT = 60 * 24 * HOUR;
/** New answers per account per UTC day. Kept apart from the answers, so turning AI off and on doesn't reset it. */
const PER_DAY = { note: 4, repeats: 4 };

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY is not set');
  process.exit(1);
}

initializeApp({ projectId: 'nilemy-app' });
const auth = getAuth();
const claude = new Anthropic({ timeout: 60_000, maxRetries: 1 });

const LANG_NAME = { en: 'English', tr: 'Turkish', de: 'German', fr: 'French', pt: 'Brazilian Portuguese', it: 'Italian' };
const NO_PATTERN = 'Never use the word "pattern" or its translations (örüntü, Muster, motif, tendance, padrão, modello, schema).';
const SAME_WORDS = 'Logged values are written as the app shows them to the person; use the same words for them.';

const SYSTEM = `You write the "For you today" note on the home screen of Nilemy, a period tracking app.
You get a short JSON summary of one person's own logs. Write a note for today in the language given in "lang".

What a good note does:
- Points out one useful thing the logs show for today or the next days, and, when it fits, one practical thing to do about it. Example of the kind of content: cramps usually start on day 1 in their recent cycles and their period is due tomorrow, so keeping a hot water bottle at hand helps.
- Uses only what is in the summary. Never invent numbers, dates or symptoms. If the summary has little in it, give one practical point for the current cycle phase.
- In conceive mode, focus on the fertile days and tests.

Style:
- At most 2 sentences and 220 characters. Plain text: no emoji, no markdown, no quotes, no greeting, no sign-off, no name.
- Address the person informally (tr: "sen", de: "du", fr: "tu", pt: "você", it: "tu").
- State what the logs show directly. No openers such as "your logs show", "according to your logs", "kayıtların gösteriyor", "kayıtlarına göre" or "kendi kayıtlarından". Never "studies show" or "it is known".
- Not medical: no diagnosis, no reassurance or warning about health, no medication names or doses. Never call anything "normal" or "abnormal".
- ${NO_PATTERN}
- Never use these words or anything that sounds like them: calm, gentle, soft, soothing, relax, sakin, nazik, yumuşak, rahatla, sanft, ruhig, doux, doucement, calme, tranquilo, suave, calmo, dolce.
- Do not just repeat the number of days until the next period; the screen already shows it.`;

const PATTERN_SYSTEM = `You write "What repeats in your cycles" on the Insights screen of Nilemy, a period tracking app.
You get one person's own logs from their last completed cycles as JSON: for each cycle its length and period length,
and for each logged day the cycle number, cycle day, days until the next period and what was logged that day
(flow, pain, mood, energy, symptoms, products such as painkiller or heat). Find what keeps coming back in these logs.

What to look for:
- Things that come back at the same point of the cycle (a symptom 2 days before the period, low energy on day 1).
- Things that come together (on days with headache, mood is often low; painkiller days are mostly the first two period days).
- Changes across cycles (cramps logged on fewer days in recent cycles, cycles getting shorter).

Rules:
- Only things seen in at least 2 different cycles. Use only what is in the data; never invent numbers or symptoms.
- Up to 4 items, the most useful first. Fewer is fine; an empty list is fine when nothing repeats.
- Each item has a title and a text. The title says what repeats, in at most 40 characters, e.g. "Headache 2 days before your period".
  The text, at most 140 characters, says how often it happened ("In 3 of your last 4 cycles.") and, when it fits,
  one practical thing to do. Do not repeat the title in the text.
- State things directly. No openers such as "your logs show", "your data shows", "according to your logs",
  "kayıtların gösteriyor", "kayıtlarına göre", "kendi kayıtlarından". No filler, no summary sentence.
- ${NO_PATTERN}
- Each item starts differently; do not reuse the same sentence shape or phrase across items.
- Language: the one named by the user message. Address the person informally (tr: "sen", de: "du", fr: "tu", pt: "você", it: "tu").
- Plain text: no emoji, no markdown, no quotes, no greeting, no name.
- Not medical: no diagnosis or cause, no reassurance or warning about health, no medication names or doses.
  Never call anything "normal" or "abnormal". Never say "studies show".
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

/** One Claude call with the settings both features share. */
function ask({ system, content, maxTokens, format }, options) {
  return claude.beta.messages.create(
    {
      model: MODEL,
      max_tokens: maxTokens,
      output_config: { effort: 'low', ...(format ? { format } : null) },
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
  ready ??= ask({ system: 'Reply with an empty list.', content: 'Nothing repeats.', maxTokens: 200, format: PATTERN_FORMAT }, { timeout: 20_000 }).then(
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

function load(file) {
  try {
    return new Map(Object.entries(JSON.parse(readFileSync(file, 'utf8'))));
  } catch {
    // First start or unreadable file: start empty.
    return new Map();
  }
}

function store(file, map) {
  writeFileSync(`${file}.tmp`, JSON.stringify(Object.fromEntries(map)));
  renameSync(`${file}.tmp`, file);
}

// uid -> { date, lang, text, at }: the last note (date is the phone's day, at the server time it was asked).
const notes = load(DATA);
// uid -> { key, lang, items, at }: the latest repeats.
const found = load(PATTERN_DATA);
// uid -> when the last DELETE came in.
const wipes = new Map();
// uid -> { day, note, repeats }: new answers today.
const usage = new Map();
let made = { day: '', count: 0 };

const today = () => new Date().toISOString().slice(0, 10);
/** Entries saved before `at` was kept count from their date. */
const madeAt = (e) => e.at ?? (Date.parse(e.date) || 0);

/** Drops what is past its time. Runs at start, on every save and every 10 minutes. */
function prune() {
  const now = Date.now();
  const drop = (map, kept) => {
    let dropped = false;
    for (const [uid, e] of map) if (!(now - madeAt(e) <= kept)) dropped = map.delete(uid);
    return dropped;
  };
  if (drop(notes, NOTE_KEPT)) store(DATA, notes);
  if (drop(found, REPEATS_KEPT)) store(PATTERN_DATA, found);
  for (const [uid, at] of wipes) if (now - at > HOUR) wipes.delete(uid);
  for (const [uid, u] of usage) if (u.day !== today()) usage.delete(uid);
}

/** Saves an answer unless a DELETE came in after it was asked for, or a later request saved first. */
function keep(map, file, uid, entry) {
  if ((wipes.get(uid) ?? -1) >= entry.at) return false;
  prune();
  if ((map.get(uid)?.at ?? -1) <= entry.at) map.set(uid, entry);
  store(file, map);
  return true;
}

function forget(uid, at) {
  wipes.set(uid, at);
  if (notes.delete(uid)) store(DATA, notes);
  if (found.delete(uid)) store(PATTERN_DATA, found);
}

/** The shared daily cap and the account's own limit, counted before Claude is asked so parallel requests count too. */
function limit(uid, kind) {
  const day = today();
  if (made.day !== day) made = { day, count: 0 };
  if (made.count >= DAILY_CAP) return [503, { error: 'busy' }];
  let u = usage.get(uid);
  if (u?.day !== day) usage.set(uid, (u = { day, note: 0, repeats: 0 }));
  if (u[kind] >= PER_DAY[kind]) return [429, { error: 'tomorrow' }];
  made.count++;
  u[kind]++;
  return null;
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

class TooBig extends Error {}

/** The body as JSON. A body over `max` is read to the end and dropped, so the phone still gets a 413. */
function readJson(req, max) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size <= max) chunks.push(c);
    });
    req.on('end', () => {
      if (size > max) return reject(new TooBig(`${req.url} body of ${size} bytes`));
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function badBody(res, e, error) {
  if (!(e instanceof TooBig)) return send(res, 400, { error });
  console.error('too big:', e.message);
  return send(res, 413, { error: 'too-big' });
}

async function write(summary, lang) {
  // Claude gets neither the date (kept here only to know the day) nor the version mark; the list of
  // what repeats is named for what it is, so the word "pattern" isn't put in front of it.
  const { date: _date, v, patterns, ...rest } = summary;
  const res = await ask({
    system: SYSTEM,
    maxTokens: 2000,
    content: `Write today's note in ${LANG_NAME[lang]}.${v === 2 ? ` ${SAME_WORDS}` : ''}\n\n${JSON.stringify({ ...rest, repeatsInEarlierCycles: patterns })}`,
  });
  if (res.stop_reason === 'refusal') return null;
  const text = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('').trim();
  return text.replace(/^["“”']+|["“”']+$/g, '').slice(0, 400) || null;
}

async function dailyNote(req, res, uid, at) {
  let summary;
  try {
    summary = await readJson(req, MAX_BODY);
  } catch (e) {
    return badBody(res, e, 'bad-summary');
  }
  const lang = Object.hasOwn(LANG_NAME, summary?.lang) ? summary.lang : null;
  const date = typeof summary?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(summary.date) ? summary.date : null;
  if (!lang || !date) return send(res, 400, { error: 'bad-summary' });

  const kept = notes.get(uid);
  if (kept?.date === date && kept.lang === lang) return send(res, 200, { text: kept.text });
  const no = limit(uid, 'note');
  if (no) return send(res, ...no);

  let text;
  try {
    text = await write(summary, lang);
  } catch (e) {
    logClaude('claude', e);
    return send(res, 503, { error: 'busy' });
  }
  if (!text) return send(res, 503, { error: 'no-note' });
  // Turned off while Claude was writing: nothing is kept, and the phone drops it too.
  if (!keep(notes, DATA, uid, { date, lang, text, at })) return send(res, 409, { error: 'turned-off' });
  return send(res, 200, { text });
}

/** Cuts a too-long text at a word, so a line never ends mid-word. */
function clip(text, max) {
  const t = text.trim().replace(/\s+/g, ' ');
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max / 2)).replace(/[\s,;:.-]+$/, '')}…`;
}

async function findPatterns(logs, lang, v2) {
  // Phones before v 2 number the cycles from the newest and send the stored English keys.
  const order = v2 ? `Cycles are numbered from the oldest (1) to the most recent. ${SAME_WORDS}` : 'Cycle 1 is the most recent completed cycle; higher numbers are older.';
  const res = await ask({
    system: PATTERN_SYSTEM,
    maxTokens: 4000,
    format: PATTERN_FORMAT,
    content: `Write what repeats, in ${LANG_NAME[lang]}. ${order}\n\n${JSON.stringify(logs)}`,
  });
  if (res.stop_reason === 'refusal' || res.stop_reason === 'max_tokens') return null;
  const text = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  const items = JSON.parse(text).items;
  if (!Array.isArray(items)) return null;
  return items
    .filter((i) => typeof i?.title === 'string' && typeof i?.text === 'string' && i.title.trim() && i.text.trim())
    .slice(0, 4)
    .map((i) => ({ title: clip(i.title, 60), text: clip(i.text, 200) }));
}

async function patternsRoute(req, res, uid, at) {
  let logs;
  try {
    logs = await readJson(req, MAX_PATTERN_BODY);
  } catch (e) {
    return badBody(res, e, 'bad-logs');
  }
  const lang = Object.hasOwn(LANG_NAME, logs?.lang) ? logs.lang : null;
  const key = typeof logs?.key === 'string' && logs.key.length <= 40 ? logs.key : null;
  if (!lang || !key || !Array.isArray(logs?.cycles) || !Array.isArray(logs?.days)) return send(res, 400, { error: 'bad-logs' });

  const kept = found.get(uid);
  if (kept?.key === key && kept.lang === lang) return send(res, 200, { items: kept.items });
  // A new cycle or a language change asks again; a few a day per account.
  const no = limit(uid, 'repeats');
  if (no) return send(res, ...no);

  let items;
  try {
    const { key: _key, v, ...rest } = logs;
    items = await findPatterns(rest, lang, v === 2);
  } catch (e) {
    logClaude('claude', e);
    return send(res, 503, { error: 'busy' });
  }
  if (!items) return send(res, 503, { error: 'no-patterns' });
  if (!keep(found, PATTERN_DATA, uid, { key, lang, items, at })) return send(res, 409, { error: 'turned-off' });
  return send(res, 200, { items });
}

const ROUTES = { '/api/daily-note': dailyNote, '/api/patterns': patternsRoute };

http
  .createServer((req, res) => {
    const at = Date.now();
    const url = (req.url ?? '').split('?')[0];
    if (url === '/api/health') return checkClaude().then((ok) => send(res, ok ? 200 : 503, ok ? { ok } : { error: 'claude' }));
    const route = ROUTES[url];
    if (!route || (req.method !== 'POST' && req.method !== 'DELETE')) return send(res, 404, { error: 'not-found' });
    (async () => {
      const uid = await user(req);
      if (!uid) return send(res, 401, { error: 'sign-in' });
      if (req.method === 'DELETE') {
        forget(uid, at);
        return send(res, 200, { ok: true });
      }
      return route(req, res, uid, at);
    })().catch((e) => {
      console.error(e);
      if (!res.headersSent) send(res, 500, { error: 'server' });
    });
  })
  .listen(PORT, () => {
    console.log(`nilemy-api on ${PORT}, model ${MODEL}, inference ${GEO || 'workspace default'}`);
    const tidy = () => {
      try {
        prune();
      } catch (e) {
        console.error('prune', e);
      }
    };
    tidy();
    setInterval(tidy, 10 * 60e3).unref();
    checkClaude();
  });
