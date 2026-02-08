/* eslint-disable no-console */

const fs = require('fs');
const path = require('path');
const { Telegraf } = require('telegraf');

const TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
if (!TOKEN) {
  console.error('Missing TELEGRAM_BOT_TOKEN');
  process.exit(1);
}

const PUBLIC_URL = (process.env.PUBLIC_URL || '').trim();
const WEBHOOK_PATH = (process.env.WEBHOOK_PATH || '/telegram').trim();
const ALLOWED_CHAT_IDS = (process.env.ALLOWED_CHAT_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const FAQ_FILE = process.env.FAQ_FILE || './faq.intents.json';

function loadFaq(file) {
  const p = path.resolve(process.cwd(), file);
  const raw = fs.readFileSync(p, 'utf8');
  const json = JSON.parse(raw);
  return json;
}

function normalizeText(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(s) {
  if (!s) return [];
  return s.split(' ').filter(Boolean);
}

function nowMs() {
  return Date.now();
}

// Cooldown state (in-memory). For Render this resets on restart; OK for anti-spam.
const lastByUser = new Map(); // key `${chatId}:${userId}` -> tsMs
const lastByChat = new Map(); // key `${chatId}` -> tsMs

function cooldownOk({ chatId, userId, perUserMs, perChatMs }) {
  const t = nowMs();
  if (perChatMs > 0) {
    const lastC = lastByChat.get(String(chatId)) || 0;
    if (t - lastC < perChatMs) return { ok: false, reason: 'cooldown_chat' };
  }
  if (perUserMs > 0) {
    const key = `${chatId}:${userId}`;
    const lastU = lastByUser.get(key) || 0;
    if (t - lastU < perUserMs) return { ok: false, reason: 'cooldown_user' };
  }
  return { ok: true, reason: null };
}

function markCooldown({ chatId, userId }) {
  const t = nowMs();
  lastByChat.set(String(chatId), t);
  lastByUser.set(`${chatId}:${userId}`, t);
}

function scoreIntent({ tokens, intent }) {
  const kw = intent.keywords || {};
  let score = 0;
  let distinctHits = 0;
  const hitSet = new Set();

  for (const tok of tokens) {
    if (kw[tok] != null) {
      score += Number(kw[tok]) || 0;
      if (!hitSet.has(tok)) {
        hitSet.add(tok);
        distinctHits += 1;
      }
    }
  }

  return { score, distinctHits, hitTokens: Array.from(hitSet) };
}

function hasAnyDenyWord({ tokens, denyWords }) {
  if (!denyWords || !denyWords.length) return false;
  const set = new Set(tokens);
  return denyWords.some((w) => set.has(String(w).toLowerCase()));
}

function matchFaq({ text, faq }) {
  const settings = faq.settings || {};
  const minDistinctHits = settings.minDistinctHits ?? 2;
  const threshold = settings.threshold ?? 5;
  const ambiguityGap = settings.ambiguityGap ?? 2;
  const denyWordsGlobal = (settings.denyWordsGlobal || []).map((w) => String(w).toLowerCase());

  const normalized = normalizeText(text);
  const tokens = tokenize(normalized);

  if (tokens.length === 0) {
    return { kind: 'no_match', reason: 'empty', tokens, normalized };
  }

  // Global deny words: if present, we avoid FAQ auto replies (forces “fallback”).
  if (hasAnyDenyWord({ tokens, denyWords: denyWordsGlobal })) {
    return { kind: 'no_match', reason: 'deny_global', tokens, normalized };
  }

  const scored = (faq.intents || [])
    .map((intent) => {
      const denyWords = (intent.denyWords || []).map((w) => String(w).toLowerCase());
      if (hasAnyDenyWord({ tokens, denyWords })) {
        return { intent, blocked: true, score: 0, distinctHits: 0, hitTokens: [] };
      }
      const { score, distinctHits, hitTokens } = scoreIntent({ tokens, intent });
      return { intent, blocked: false, score, distinctHits, hitTokens };
    })
    .filter((x) => !x.blocked)
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  const second = scored[1];

  if (!best || best.score <= 0) {
    return { kind: 'no_match', reason: 'no_score', tokens, normalized };
  }

  if ((best.distinctHits || 0) < minDistinctHits) {
    return { kind: 'no_match', reason: 'min_hits', tokens, normalized, best };
  }

  if (best.score < threshold) {
    return { kind: 'no_match', reason: 'below_threshold', tokens, normalized, best };
  }

  if (second && (best.score - second.score) < ambiguityGap) {
    return { kind: 'ambiguous', reason: 'gap_small', tokens, normalized, best, second };
  }

  return { kind: 'match', intent: best.intent, best, second, tokens, normalized };
}

const bot = new Telegraf(TOKEN);

bot.start((ctx) => ctx.reply('Yo. Ik ben actief. Stel je vraag.'));

bot.on('text', async (ctx) => {
  try {
    const chatId = ctx.chat?.id;
    const userId = ctx.from?.id;

    if (!chatId || !userId) return;

    // If configured, only answer in allowed chats.
    if (ALLOWED_CHAT_IDS.length > 0 && !ALLOWED_CHAT_IDS.includes(String(chatId))) {
      return;
    }

    // Ignore commands
    const text = ctx.message?.text || '';
    if (text.startsWith('/')) return;

    const faq = loadFaq(FAQ_FILE);
    const cooldown = faq.settings?.cooldown || {};
    const perUserMs = (Number(cooldown.perUserSeconds) || 0) * 1000;
    const perChatMs = (Number(cooldown.perGroupSeconds) || 0) * 1000;

    const cd = cooldownOk({ chatId, userId, perUserMs, perChatMs });
    if (!cd.ok) return;

    const m = matchFaq({ text, faq });

    if (m.kind === 'match' && m.intent?.reply) {
      await ctx.reply(m.intent.reply, {
        reply_to_message_id: ctx.message?.message_id,
        allow_sending_without_reply: true,
      });
      markCooldown({ chatId, userId });
      return;
    }

    // Ambiguous or no match -> stay silent (this is where you can later add GPT fallback)
    return;
  } catch (e) {
    console.error('handler_error', e);
    return;
  }
});

async function start() {
  if (PUBLIC_URL) {
    const url = new URL(PUBLIC_URL);
    const webhookUrl = `${url.origin}${WEBHOOK_PATH}`;
    console.log('Setting webhook:', webhookUrl);
    await bot.telegram.setWebhook(webhookUrl);
    bot.startWebhook(WEBHOOK_PATH, null, Number(process.env.PORT) || 3000);
    console.log('Webhook started');
  } else {
    console.log('Starting long polling');
    await bot.launch();
  }
}

start().catch((e) => {
  console.error('startup_failed', e);
  process.exit(1);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
