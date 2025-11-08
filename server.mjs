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

const page = (body) => `<!doctype html>
<html lang="ru"><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Telegram StringSession</title>
<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;margin:20px;max-width:760px}
label{display:block;margin:10px 0 4px}input,button{font:inherit;padding:10px;border-radius:8px;border:1px solid #cbd5e1}
button{background:#4f8cff;border:none;color:#fff;cursor:pointer} .muted{color:#64748b}
.box{padding:12px;border:1px solid #e2e8f0;border-radius:10px;background:#f8fafc;margin-bottom:14px}
pre{white-space:pre-wrap;word-break:break-all;background:#0f172a;color:#e5e7eb;padding:12px;border-radius:8px}
.err{color:#dc2626;font-weight:700}
</style>
<h1>Получение TELEGRAM_STRING_SESSION</h1>
${body}
<hr><small class="muted">Никому не показывай свою строку сессии.</small>`;

let ctx = { client: null, phone: null, hash: null };

app.get('/', (_req, res) => {
  res.send(page(`
<div class="box">
  <b>Шаг 1.</b> Введи номер в формате <b>+380XXXXXXXXX</b> и нажми «Отправить код».<br>
  Если код в приложении не пришёл, сразу нажимай «Запросить SMS» или «Запросить звонок».
</div>
<form method="post" action="/send">
  <label>Номер телефона</label>
  <input name="phone" placeholder="+380XXXXXXXXX" required>
  <button>Отправить код</button>
</form>
`));
});

app.post('/send', async (req, res) => {
  try {
    const phone = String(req.body.phone || '').trim();
    if (!phone.startsWith('+')) throw new Error('Укажи номер вида +380…');

    // новый клиент и пустая сессия
    const client = new TelegramClient(new StringSession(''), apiId, apiHash, {
      connectionRetries: 6, retryDelay: 1200
    });
    await client.connect();

    // первичный запрос кода
    const send = await client.invoke(new Api.auth.SendCode({
      phoneNumber: phone, apiId, apiHash,
      settings: new Api.CodeSettings({
        allowFlashcall: false,
        currentNumber: true,
        allowAppHash: true,
        allowMissedCall: true
      })
    }));

    ctx = { client, phone, hash: send.phoneCodeHash };

    res.send(page(`
<div class="box">
<b>Шаг 2.</b> Введи код (если пришёл в Telegram).<br>
Если нет — нажми «Запросить SMS» или «Запросить звонок».
</div>
<form method="post" action="/signin">
  <label>Код</label>
  <input name="code" placeholder="12345" required>
  <button>Войти</button>
</form>
<form method="post" action="/resend" style="margin-top:10px;display:flex;gap:8px">
  <button name="mode" value="sms" type="submit">Запросить SMS</button>
  <button name="mode" value="call" type="submit">Запросить звонок</button>
</form>
`));
  } catch (e) {
    res.status(500).send(page(`<div class="box err">Ошибка /send: ${String(e?.message || e)}</div><a href="/">Назад</a>`));
  }
});

app.post('/resend', async (req, res) => {
  try {
    if (!ctx.client || !ctx.hash || !ctx.phone) throw new Error('Сначала отправь номер на /');
    // Telegram сам выбирает канал доставки при ResendCode.
    await ctx.client.invoke(new Api.auth.ResendCode({
      phoneNumber: ctx.phone, phoneCodeHash: ctx.hash
    }));
    res.send(page(`
<div class="box">Повторный запрос кода отправлен. Проверь Telegram/SMS/звонок.</div>
<form method="post" action="/signin">
  <label>Код</label>
  <input name="code" placeholder="12345" required>
  <button>Войти</button>
</form>
<form method="post" action="/resend" style="margin-top:10px;display:flex;gap:8px">
  <button name="mode" value="sms" type="submit">Запросить SMS</button>
  <button name="mode" value="call" type="submit">Запросить звонок</button>
</form>
`));
  } catch (e) {
    res.status(500).send(page(`<div class="box err">Ошибка /resend: ${String(e?.message || e)}</div><a href="/">Назад</a>`));
  }
});

app.post('/signin', async (req, res) => {
  try {
    const code = String(req.body.code || '').trim();
    if (!ctx.client || !ctx.hash || !ctx.phone) throw new Error('Сначала отправь номер на /');

    await ctx.client.invoke(new Api.auth.SignIn({
      phoneNumber: ctx.phone, phoneCodeHash: ctx.hash, phoneCode: code
    }));

    const session = new StringSession(ctx.client.session.save()).save();
    ctx = { client: null, phone: null, hash: null };

    res.send(page(`
<div class="box"><b>Готово!</b> Скопируй свою TELEGRAM_STRING_SESSION:</div>
<pre>${session}</pre>
<div class="box">Вставь её в Render → Environment → <b>TELEGRAM_STRING_SESSION</b>.</div>
`));
  } catch (e) {
    res.status(500).send(page(`<div class="box err">Ошибка /signin: ${String(e?.message || e)}</div>
<a href="/">Назад</a>`));
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Listening on :' + PORT));
