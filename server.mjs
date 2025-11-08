import 'dotenv/config';
import express from 'express';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { Api } from 'telegram';

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;

// Простая html-страница (форма → отправка кода → ввод кода → вывод StringSession)
const page = (body) => `<!doctype html>
<html lang="ru"><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Telegram StringSession</title>
<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;margin:24px;max-width:720px}
input,button{font:inherit;padding:10px;border-radius:8px;border:1px solid #ccc}button{background:#4f8cff;color:#fff;border:0}
label{display:block;margin:12px 0 6px}form{display:grid;gap:10px;margin:12px 0}.box{padding:12px;border:1px dashed #bbb;border-radius:10px;background:#fafbff}
pre{white-space:pre-wrap;word-break:break-all;background:#0f172a;color:#e5e7eb;padding:12px;border-radius:8px}
</style>
<h1>Telegram StringSession (Render)</h1>
${body}
<hr><small>⚠️ Не делись этой строкой ни с кем.</small>`;

let ctx = {
  client: null,
  phone: null,
  hash: null
};

app.get('/', (_req, res) => {
  res.send(page(`<div class="box">
  <b>Шаг 1.</b> Введи номер в формате <b>+380…</b>. Мы отправим запрос кода в Telegram.<br>
  Через минуту, если код не придёт в уже залогиненный клиент, можно запросить SMS/звонок.
</div>
<form method="post" action="/send">
  <label>Номер телефона</label>
  <input name="phone" placeholder="+380XXXXXXXXX" required>
  <button>Отправить код</button>
</form>`));
});

app.post('/send', async (req, res) => {
  try {
    const phone = String(req.body.phone || '').trim();
    if (!phone.startsWith('+')) throw new Error('Укажи номер вида +380…');

    // Новый клиент и пустая сессия
    const client = new TelegramClient(new StringSession(''), apiId, apiHash, {
      connectionRetries: 6, retryDelay: 1200
    });
    await client.connect();

    // Отправим запрос кода
    const send = await client.invoke(new Api.auth.SendCode({
      phoneNumber: phone, apiId, apiHash,
      settings: new Api.CodeSettings({
        allowFlashcall: false, currentNumber: true,
        allowAppHash: true, allowMissedCall: true
      })
    }));

    // Сохраняем контекст (в памяти процесса)
    ctx = { client, phone, hash: send.phoneCodeHash };

    res.send(page(`<div class="box">
<b>Шаг 2.</b> Введи код, который пришёл в Telegram (или подожди ~60 сек, затем можно нажать «Запросить SMS»/«Звонок»).
</div>
<form method="post" action="/signin">
  <label>Код из Telegram</label>
  <input name="code" placeholder="12345">
  <button>Войти</button>
</form>
<form method="post" action="/resend" style="margin-top:8px;display:flex;gap:8px">
  <button name="mode" value="sms">Запросить SMS</button>
  <button name="mode" value="call">Запросить звонок</button>
</form>`));
  } catch (e) {
    res.status(500).send(page(`<div class="box">Ошибка /send: ${String(e?.message || e)}</div><a href="/">Назад</a>`));
  }
});

app.post('/resend', async (req, res) => {
  try {
    if (!ctx.client || !ctx.hash || !ctx.phone) throw new Error('Сначала /send');
    // Telegram сам решает канал доставки, мы просто просим повтор
    await ctx.client.invoke(new Api.auth.ResendCode({
      phoneNumber: ctx.phone, phoneCodeHash: ctx.hash
    }));
    res.send(page(`<div class="box">Повторный запрос кода отправлен. Проверь Telegram/SMS/звонок.</div>
<form method="post" action="/signin">
  <label>Код из Telegram/SMS/звонка</label>
  <input name="code" placeholder="12345" required>
  <button>Войти</button>
</form>`));
  } catch (e) {
    res.status(500).send(page(`<div class="box">Ошибка /resend: ${String(e?.message || e)}</div><a href="/">Назад</a>`));
  }
});

app.post('/signin', async (req, res) => {
  try {
    const code = String(req.body.code || '').trim();
    if (!ctx.client || !ctx.hash || !ctx.phone) throw new Error('Сначала /send');

    await ctx.client.invoke(new Api.auth.SignIn({
      phoneNumber: ctx.phone, phoneCodeHash: ctx.hash, phoneCode: code
    }));

    const session = new StringSession(ctx.client.session.save()).save();
    // Сбросим контекст
    ctx = { client: null, phone: null, hash: null };

    res.send(page(`<div class="box"><b>Готово!</b> Вот твой TELEGRAM_STRING_SESSION:</div>
<pre>${session}</pre>
<div class="box">Скопируй полностью и вставь в Render → Environment → <b>TELEGRAM_STRING_SESSION</b>.</div>`));
  } catch (e) {
    res.status(500).send(page(`<div class="box">Ошибка /signin: ${String(e?.message || e)}</div><a href="/">Назад</a>`));
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Listening on :' + PORT));
