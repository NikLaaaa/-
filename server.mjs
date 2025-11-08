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

// Храним последнюю выданную строку сессии в памяти (и дублируем в лог)
let lastSession = null;

const page = (body) => `<!doctype html>
<html lang="ru"><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Telegram StringSession</title>
<style>
body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;margin:20px;max-width:860px}
label{display:block;margin:10px 0 4px}
input,button,textarea{font:inherit;padding:10px;border-radius:8px;border:1px solid #cbd5e1}
button{background:#4f8cff;border:none;color:#fff;cursor:pointer}
.box{padding:12px;border:1px solid #e2e8f0;border-radius:10px;background:#f8fafc;margin-bottom:14px}
pre{white-space:pre-wrap;word-break:break-all;background:#f1f5f9;color:#111;padding:12px;border-radius:8px}
.err{color:#dc2626;font-weight:700}
.row{display:flex;gap:12px;flex-wrap:wrap}
a.btn{display:inline-block;background:#0ea5e9;color:#fff;text-decoration:none;padding:10px 12px;border-radius:8px}
.muted{color:#64748b}
.qr{display:flex;gap:14px;flex-wrap:wrap;align-items:center}
.badge{font-size:12px;background:#e2e8f0;color:#334155;border-radius:999px;padding:4px 8px}
textarea.session{width:100%;min-height:140px}
.copy{background:#16a34a}
</style>
<h1>Получение TELEGRAM_STRING_SESSION</h1>
${body}
<hr><small class="muted">Никому не показывай свою строку сессии.</small>`;

let ctx = { client: null, phone: null, hash: null, qr: null };

app.get('/', (_req, res) => {
  res.send(page(`
<div class="box"><b>Вариант 1 — QR</b> (рекомендую): Telegram на телефоне → Настройки → Устройства → <b>Подключить устройство</b>, сканируй QR.</div>
<div class="row">
  <a class="btn" href="/qr">Войти по QR</a>
  <a class="btn" href="/last">Показать последнюю сессию</a>
</div>
<div class="box" style="margin-top:14px"><b>Вариант 2 — по номеру</b> (код/SMS/звонок).</div>
<form method="post" action="/send">
  <label>Номер телефона</label>
  <input name="phone" placeholder="+380XXXXXXXXX" required>
  <button>Отправить код</button>
</form>
`));
});

/* ===== QR: автообновление токена и автопроверка ===== */
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
  const tok = await client.invoke(new Api.auth.ExportLoginToken({ apiId, apiHash, exceptIds: [] }));
  if (!('token' in tok)) throw new Error('Не удалось получить QR-токен');
  const token = tok.token;
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
      <div class="muted" style="margin-top:8px">Если не открывается автоматически, нажми ссылку:</div>
      <div style="margin-top:6px"><a class="btn" href="${tgLink}">Открыть tg://login</a></div>
      <div class="muted" style="margin-top:8px">После сканирования подтверди вход в Telegram.</div>
    </div>
  </div>
</div>
<script>
  // Автопроверка каждые 5 сек: если получим сессию — страница заменится на результат
  let poll = setInterval(async () => {
    try {
      const r = await fetch('/qr/check', {method:'POST'});
      const t = await r.text();
      if (t.includes('textarea') && t.includes('TELEGRAM_STRING_SESSION')) {
        clearInterval(poll);
        document.open(); document.write(t); document.close();
      }
    } catch (e) {}
  }, 5000);
  // Автообновление QR каждые ~25 сек
  setTimeout(()=>{ location.reload(); }, 25000);
</script>`;
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
    if (!ctx.qr?.token || (ctx.qr.expiresAt && Date.now() > ctx.qr.expiresAt)) {
      await exportQrToken();
      const tgLink = `tg://login?token=${Buffer.from(ctx.qr.token).toString('base64url')}`;
      return res.send(page(qrHtml(tgLink)));
    }
    const resp = await client.invoke(new Api.auth.ImportLoginToken({ token: ctx.qr.token }));
    if (resp instanceof Api.auth.LoginTokenSuccess) {
      const session = new StringSession(client.session.save()).save();
      lastSession = session;
      console.log('SESSION:', session); // ← видно в логах Render
      ctx = { client: null, phone: null, hash: null, qr: null };
      return res.send(page(`
<div class="box"><b>Готово!</b> Скопируй TELEGRAM_STRING_SESSION:</div>
<textarea class="session" readonly>${session}</textarea>
<div style="margin-top:8px;display:flex;gap:8px">
  <button class="copy" onclick="navigator.clipboard.writeText(document.querySelector('textarea.session').value)">Скопировать</button>
  <a class="btn" href="/last" target="_blank">Открыть /last</a>
</div>
`));
    } else if (resp instanceof Api.auth.LoginTokenMigrateTo) {
      const { dcId, token } = resp;
      await client._switchDC(dcId);
      const resp2 = await client.invoke(new Api.auth.ImportLoginToken({ token }));
      if (resp2 instanceof Api.auth.LoginTokenSuccess) {
        const session = new StringSession(client.session.save()).save();
        lastSession = session;
        console.log('SESSION:', session);
        ctx = { client: null, phone: null, hash: null, qr: null };
        return res.send(page(`
<div class="box"><b>Готово!</b> Скопируй TELEGRAM_STRING_SESSION:</div>
<textarea class="session" readonly>${session}</textarea>
<div style="margin-top:8px;display:flex;gap:8px">
  <button class="copy" onclick="navigator.clipboard.writeText(document.querySelector('textarea.session').value)">Скопировать</button>
  <a class="btn" href="/last" target="_blank">Открыть /last</a>
</div>
`));
      }
      const tgLink = `tg://login?token=${Buffer.from(ctx.qr.token).toString('base64url')}`;
      return res.send(page(qrHtml(tgLink)));
    } else {
      const tgLink = `tg://login?token=${Buffer.from(ctx.qr.token).toString('base64url')}`;
      return res.send(page(qrHtml(tgLink)));
    }
  } catch (e) {
    if (String(e?.message||e).includes('AUTH_TOKEN_EXPIRED')) {
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

/* ===== Вариант по номеру (оставлен) ===== */
app.post('/send', async (req, res) => {
  try {
    const phone = String(req.body.phone || '').trim();
    if (!phone.startsWith('+')) throw new Error('Укажи номер вида +380…');
    const client = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 6, retryDelay: 1200 });
    await client.connect();
    const send = await client.invoke(new Api.auth.SendCode({
      phoneNumber: phone, apiId, apiHash,
      settings: new Api.CodeSettings({ allowFlashcall:false, currentNumber:true, allowAppHash:true, allowMissedCall:true })
    }));
    ctx = { client, phone, hash: send.phoneCodeHash, qr: null };
    const timeout = send?.timeout ?? null;
    const nextType = send?.nextType?._ || null;
    const tip = nextType ? `Следующий тип доставки: <b>${nextType.replace('auth.sentCodeType','')}</b>.` : `Сервер не сообщил тип следующей доставки.`;
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
    await ctx.client.invoke(new Api.auth.ResendCode({ phoneNumber: ctx.phone, phoneCodeHash: ctx.hash }));
    res.redirect(303, '/');
  } catch (e) {
    res.status(500).send(page(`<div class="box err">Ошибка /resend: ${String(e?.message || e)}</div><a href="/">Назад</a>`));
  }
});

app.post('/signin', async (req, res) => {
  try {
    const code = String(req.body.code || '').trim();
    if (!ctx.client || !ctx.hash || !ctx.phone) throw new Error('Сначала отправь номер на /');
    await ctx.client.invoke(new Api.auth.SignIn({ phoneNumber: ctx.phone, phoneCodeHash: ctx.hash, phoneCode: code }));
    const session = new StringSession(ctx.client.session.save()).save();
    lastSession = session;
    console.log('SESSION:', session);
    ctx = { client: null, phone: null, hash: null, qr: null };
    res.send(page(`
<div class="box"><b>Готово!</b> Скопируй TELEGRAM_STRING_SESSION:</div>
<textarea class="session" readonly>${session}</textarea>
<div style="margin-top:8px">
  <button class="copy" onclick="navigator.clipboard.writeText(document.querySelector('textarea.session').value)">Скопировать</button>
  <a class="btn" href="/last" target="_blank">Открыть /last</a>
</div>
`));
  } catch (e) {
    res.status(500).send(page(`<div class="box err">Ошибка /signin: ${String(e?.message || e)}</div><a href="/">Назад</a>`));
  }
});

/* ===== Показать последнюю сохранённую сессию ===== */
app.get('/last', (_req, res) => {
  if (!lastSession) {
    return res.send(page(`<div class="box">Пока нет сохранённой сессии. Сначала авторизуйся через QR или код.</div><a class="btn" href="/">На главную</a>`));
  }
  res.send(page(`
<div class="box"><b>Последняя TELEGRAM_STRING_SESSION:</b></div>
<textarea class="session" readonly>${lastSession}</textarea>
<div style="margin-top:8px"><button class="copy" onclick="navigator.clipboard.writeText(document.querySelector('textarea.session').value)">Скопировать</button></div>
`));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Listening on :' + PORT));
