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
<style>
body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;margin:20px;max-width:760px}
label{display:block;margin:10px 0 4px}
input,button{font:inherit;padding:10px;border-radius:8px;border:1px solid #cbd5e1}
button{background:#4f8cff;border:none;color:#fff;cursor:pointer}
.box{padding:12px;border:1px solid #e2e8f0;border-radius:10px;background:#f8fafc;margin-bottom:14px}
pre{white-space:pre-wrap;word-break:break-all;background:#0f172a;color:#e5e7eb;padding:12px;border-radius:8px}
.err{color:#dc2626;font-weight:700}
.row{display:flex;gap:12px;flex-wrap:wrap}
a.btn{display:inline-block;background:#0ea5e9;color:#fff;text-decoration:none;padding:10px 12px;border-radius:8px}
.muted{color:#64748b}
.qr{display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.badge{font-size:12px;background:#e2e8f0;color:#334155;border-radius:999px;padding:4px 8px}
</style>
<h1>Получение TELEGRAM_STRING_SESSION</h1>
${body}
<hr><small class="muted">Никому не показывай свою строку сессии.</small>`;

let ctx = {
  client: null,
  phone: null,
  hash: null,
  qr: null // { token, expiresAt }
};

// Главная: QR + номер
app.get('/', (_req, res) => {
  res.send(page(`
<div class="box">
  <b>Вариант 1 — QR (рекомендую)</b><br>С телефона: Telegram → Настройки → Устройства → <b>Подключить устройство</b> и сканируй.
</div>
<div class="row">
  <a class="btn" href="/qr">Войти по QR</a>
</div>

<div class="box" style="margin-top:14px">
  <b>Вариант 2 — по номеру</b> (если хочешь через код/SMS/звонок).
</div>
<form method="post" action="/send">
  <label>Номер телефона</label>
  <input name="phone" placeholder="+380XXXXXXXXX" required>
  <button>Отправить код</button>
</form>
`));
});

/* ===== QR: генерация токена и страница с автообновлением ===== */
async function ensureClient() {
  if (ctx.client) return ctx.client;
  const client = new TelegramClient(new StringSession(''), apiId, apiHash, {
    connectionRetries: 6, retryDelay: 1200
  });
  await client.connect();
  ctx.client = client;
  return client;
}

async function exportQrToken() {
  const client = await ensureClient();
  const tokenResp = await client.invoke(new Api.auth.ExportLoginToken({
    apiId, apiHash, exceptIds: []
  }));
  if (!('token' in tokenResp)) {
    throw new Error('Не удалось получить QR-токен');
  }
  const token = tokenResp.token;
  // Срок жизни у токена очень короткий; зададим "примерно" 25с.
  ctx.qr = { token, expiresAt: Date.now() + 25_000 };
  return token;
}

function qrHtml(tgLink) {
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(tgLink)}`;
  return `
<div class="box">
  <div class="qr">
    <img alt="QR" src="${qrUrl}" width="240" height="240">
    <div>
      <div><span class="badge">QR действует ~25 сек</span></div>
      <div class="muted" style="margin-top:8px">Если не открывается автоматически, можно нажать ссылку ниже:</div>
      <div style="margin-top:6px"><a class="btn" href="${tgLink}">Открыть tg://login</a></div>
      <div class="muted" style="margin-top:8px">После сканирования подтвердите вход на телефоне.</div>
    </div>
  </div>
</div>
<form method="post" action="/qr/check" id="fcheck" style="display:none"></form>
<script>
  // Автоматически проверяем авторизацию каждые 5 сек
  let poll = setInterval(async () => {
    try {
      const r = await fetch('/qr/check', {method:'POST'});
      const t = await r.text();
      if (t.includes('TELEGRAM_STRING_SESSION')) {
        clearInterval(poll);
        document.open(); document.write(t); document.close();
      }
    } catch (e) {}
  }, 5000);

  // Автоматически обновляем QR каждые ~25 сек
  setTimeout(()=>{ location.reload(); }, 25000);
</script>
`;
}

app.get('/qr', async (_req, res) => {
  try {
    const token = await exportQrToken();
    const tgLink = `tg://login?token=${Buffer.from(token).toString('base64url')}`;
    res.send(page(qrHtml(tgLink)));
  } catch (e) {
    res.status(500).send(page(`<div class="box err">Ошибка /qr: ${String(e?.message || e)}</div><a href="/">Назад</a>`));
  }
});

app.post('/qr/check', async (_req, res) => {
  try {
    const client = await ensureClient();

    // если токен отсутствует или протух — выпустим новый
    if (!ctx.qr?.token || (ctx.qr.expiresAt && Date.now() > ctx.qr.expiresAt)) {
      await exportQrToken();
      // просто покажем свежую страницу /qr (автообновление)
      const tgLink = `tg://login?token=${Buffer.from(ctx.qr.token).toString('base64url')}`;
      return res.send(page(qrHtml(tgLink)));
    }

    // пробуем импорт токена (если отсканирован и подтвержден — вернётся Success)
    const resp = await client.invoke(new Api.auth.ImportLoginToken({ token: ctx.qr.token }));

    if (resp instanceof Api.auth.LoginTokenSuccess) {
      const session = new StringSession(client.session.save()).save();
      // очистим контекст
      ctx = { client: null, phone: null, hash: null, qr: null };
      return res.send(page(`
<div class="box"><b>Готово!</b> Скопируй свою TELEGRAM_STRING_SESSION:</div>
<pre>${session}</pre>
<div class="box">Вставь её в Render → Environment → <b>TELEGRAM_STRING_SESSION</b>.</div>
`));
    } else if (resp instanceof Api.auth.LoginTokenMigrateTo) {
      // Миграция в другой DC
      const { dcId, token } = resp;
      await client._switchDC(dcId);
      const resp2 = await client.invoke(new Api.auth.ImportLoginToken({ token }));
      if (resp2 instanceof Api.auth.LoginTokenSuccess) {
        const session = new StringSession(client.session.save()).save();
        ctx = { client: null, phone: null, hash: null, qr: null };
        return res.send(page(`
<div class="box"><b>Готово!</b> Скопируй свою TELEGRAM_STRING_SESSION:</div>
<pre>${session}</pre>
<div class="box">Вставь её в Render → Environment → <b>TELEGRAM_STRING_SESSION</b>.</div>
`));
      }
      // если ещё нет — вернём страницу и продолжим поллинг
      const tgLink = `tg://login?token=${Buffer.from(ctx.qr.token).toString('base64url')}`;
      return res.send(page(qrHtml(tgLink)));
    } else {
      // Ещё не подтверждено — вернём ту же страницу
      const tgLink = `tg://login?token=${Buffer.from(ctx.qr.token).toString('base64url')}`;
      return res.send(page(qrHtml(tgLink)));
    }
  } catch (e) {
    // Если токен истёк — просто обновим QR
    const msg = String(e?.message || e);
    if (msg.includes('AUTH_TOKEN_EXPIRED') || msg.includes('SESSION_PASSWORD_NEEDED')) {
      try {
        await exportQrToken();
        const tgLink = `tg://login?token=${Buffer.from(ctx.qr.token).toString('base64url')}`;
        return res.send(page(qrHtml(tgLink)));
      } catch (e2) {
        return res.status(500).send(page(`<div class="box err">Ошибка /qr/check: ${String(e2?.message || e2)}</div><a href="/qr">Назад</a>`));
      }
    }
    res.status(500).send(page(`<div class="box err">Ошибка /qr/check: ${String(e?.message || e)}</div><a href="/qr">Назад</a>`));
  }
});

/* ===== Вариант по номеру (как было, с таймером) ===== */
app.post('/send', async (req, res) => {
  try {
    const phone = String(req.body.phone || '').trim();
    if (!phone.startsWith('+')) throw new Error('Укажи номер вида +380…');

    const client = new TelegramClient(new StringSession(''), apiId, apiHash, {
      connectionRetries: 6, retryDelay: 1200
    });
    await client.connect();

    const send = await client.invoke(new Api.auth.SendCode({
      phoneNumber: phone, apiId, apiHash,
      settings: new Api.CodeSettings({
        allowFlashcall: false,
        currentNumber: true,
        allowAppHash: true,
        allowMissedCall: true
      })
    }));

    ctx = { client, phone, hash: send.phoneCodeHash, qr: null };

    const timeout = send?.timeout ?? null;
    const nextType = send?.nextType?._ || null;
    const tip = nextType
      ? `Следующий тип доставки: <b>${nextType.replace('auth.sentCodeType','')}</b>.`
      : `Сервер не сообщил тип следующей доставки.`;

    const waitBlock = timeout
      ? `<div class="box">Повтор (SMS/звонок) разрешат через ~${timeout} сек. Раньше будет 406: SEND_CODE_UNAVAILABLE.</div>`
      : `<div class="box">Если код не пришёл ~1 минуту — попробуй «Запросить SMS/Звонок».</div>`;

    res.send(page(`
${waitBlock}
<div class="muted">${tip}</div>
<form method="post" action="/signin" style="margin-top:10px">
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

app.post('/resend', async (_req, res) => {
  try {
    if (!ctx.client || !ctx.hash || !ctx.phone) throw new Error('Сначала отправь номер на /');
    await ctx.client.invoke(new Api.auth.ResendCode({
      phoneNumber: ctx.phone, phoneCodeHash: ctx.hash
    }));
    res.redirect(303, '/');
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
    ctx = { client: null, phone: null, hash: null, qr: null };

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
