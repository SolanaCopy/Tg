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

// Optional AI fallback (only when no FAQ match)
// Mode: "openai" (direct OpenAI call) or "openclaw" (call local OpenClaw webhook -> runs gpt via OpenClaw)
const AI_FALLBACK = String(process.env.AI_FALLBACK || '').trim().toLowerCase() === 'on';
const AI_MODE = (process.env.AI_MODE || 'openai').trim().toLowerCase();

// Direct OpenAI fallback
const AI_MODEL = (process.env.AI_MODEL || 'openai/gpt-5.2').trim();
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || '').trim();

// OpenClaw webhook fallback (3B)
const OPENCLAW_HOOK_URL = (process.env.OPENCLAW_HOOK_URL || 'http://127.0.0.1:18789/hooks/agent').trim();
const OPENCLAW_HOOK_TOKEN = (process.env.OPENCLAW_HOOK_TOKEN || '').trim();

const AI_MAX_TOKENS = Number(process.env.AI_MAX_TOKENS || 90);
const AI_COOLDOWN_SECONDS = Number(process.env.AI_COOLDOWN_SECONDS || 30);

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

// Separate cooldown for AI fallback to protect costs
const lastAiByChat = new Map(); // key `${chatId}` -> tsMs

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

async function openaiChat({ model, messages, maxTokens }) {
  if (!OPENAI_API_KEY) throw new Error('missing_OPENAI_API_KEY');
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: Number.isFinite(maxTokens) ? maxTokens : 120,
      temperature: 0.4,
    }),
  });

  const text = await r.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }

  if (!r.ok) {
    const msg = json?.error?.message || json?.message || `openai_http_${r.status}`;
    throw new Error(msg);
  }

  return String(json?.choices?.[0]?.message?.content || '').trim();
}

async function aiFallbackAnswer({ userText, chatId, replyToMessageId }) {
  const system =
    'Je bent Flexbot AI in een Telegram community. Antwoord SUPER kort (max 1 zin). ' +
    'Alleen over Flexbot/XAUUSD/MT5/EA/support/regels/pricing/setup/scams. ' +
    'Als het buiten scope is: zeg kort dat je alleen Flexbot vragen doet. ' +
    'Geen financiële garanties, geen lange uitleg, geen opsommingen.';

  // Mode 1: direct OpenAI
  if (AI_MODE === 'openai') {
    const answer = await openaiChat({
      model: AI_MODEL,
      maxTokens: AI_MAX_TOKENS,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userText },
      ],
    });
    return answer.replace(/\s*\n\s*/g, ' ').trim();
  }

  // Mode 2: OpenClaw webhook (3B) -> ask OpenClaw to respond to the Telegram group as a reply.
  if (AI_MODE === 'openclaw') {
    if (!OPENCLAW_HOOK_TOKEN) throw new Error('missing_OPENCLAW_HOOK_TOKEN');

    // We return empty here; the OpenClaw hook will deliver the message.
    await fetch(OPENCLAW_HOOK_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENCLAW_HOOK_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'faq-fallback',
        wakeMode: 'now',
        deliver: false,
        model: 'openai/gpt-5.2',
        thinking: 'low',
        timeoutSeconds: 60,
        message:
          system +
          '\n\nUser question (reply in 1 zin, Nederlands): ' +
          userText,
      }),
    });

    return '';
  }

  return '';
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
    if (ctx.from?.is_bot) return;

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
      const r = m.intent.reply;
      const replyText = Array.isArray(r)
        ? String(r[Math.abs(Number(ctx.message?.message_id || 0)) % r.length] || '')
        : String(r);

      if (!replyText) return;

      await ctx.reply(replyText, {
        reply_to_message_id: ctx.message?.message_id,
        allow_sending_without_reply: true,
      });
      markCooldown({ chatId, userId });
      return;
    }

    // No FAQ match -> optional AI fallback
    if (AI_FALLBACK) {
      if (AI_MODE === 'openai' && !OPENAI_API_KEY) return;
      if (AI_MODE === 'openclaw' && !OPENCLAW_HOOK_TOKEN) return;

      const now = Date.now();
      const lastAi = lastAiByChat.get(String(chatId)) || 0;
      const aiCooldownMs = Math.max(0, AI_COOLDOWN_SECONDS) * 1000;
      if (aiCooldownMs > 0 && now - lastAi < aiCooldownMs) return;

      // Keep costs down: ignore ultra-short + non-question messages
      const normalized = normalizeText(text);
      const words = normalized.split(' ').filter(Boolean);
      if (words.length < 4) return;

      const questionWords = new Set(['hoe', 'waarom', 'wat', 'waar', 'wanneer', 'welke', 'kan', 'mag', 'moet']);
      const looksLikeQuestion = text.includes('?') || words.some((w) => questionWords.has(w));
      if (!looksLikeQuestion) return;

      const reply = await aiFallbackAnswer({
        userText: text,
        chatId,
        replyToMessageId: ctx.message?.message_id,
      });

      // In openclaw mode we may choose to not return text (if OpenClaw delivers separately)
      if (reply) {
        await ctx.reply(reply, {
          reply_to_message_id: ctx.message?.message_id,
          allow_sending_without_reply: true,
        });
      }

      lastAiByChat.set(String(chatId), now);
    }

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
