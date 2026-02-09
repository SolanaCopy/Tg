# @Aiflexbotbot – Community Telegram Bot

Small Telegram bot (Telegraf) that:
- Receives group messages via webhook or long polling
- Runs a lightweight FAQ/intent matcher
- Prevents spam via per-user and per-group cooldown
- Falls back (no reply) when ambiguous

## Environment variables

Required:
- `TELEGRAM_BOT_TOKEN` – BotFather token

Optional:
- `PUBLIC_URL` – Render public URL (for webhook). Example: `https://your-service.onrender.com`
- `WEBHOOK_PATH` – default `/telegram`
- `ALLOWED_CHAT_IDS` – comma-separated list of chat ids. If set, bot only replies there.
- `FAQ_FILE` – path to intents file, default `./faq.intents.json`

AI fallback (only used when no FAQ match; costs OpenAI credits):
- `AI_FALLBACK` – set to `on` to enable
- `OPENAI_API_KEY` – OpenAI key
- `AI_MODEL` – default `openai/gpt-5.2`
- `AI_MAX_TOKENS` – default `90`
- `AI_COOLDOWN_SECONDS` – default `30` (per chat)

## Run locally

```bash
npm install
TELEGRAM_BOT_TOKEN=... node index.js
```

## Deploy on Render (recommended)

- Create a new **Web Service** from this repo
- Build command: `npm install`
- Start command: `npm start`
- Set env var `TELEGRAM_BOT_TOKEN`
- Set env var `PUBLIC_URL` to Render URL of the service

The bot will try to set webhook to `${PUBLIC_URL}${WEBHOOK_PATH}`.
If `PUBLIC_URL` is not set, it will use long polling.
