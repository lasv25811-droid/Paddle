const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const admin = require('firebase-admin');

/* ================== KONFİQURASİYA (Render → Environment) ==================
   PADDLE_API_KEY            Paddle Billing API açarı
   PADDLE_WEBHOOK_SECRET     (istəyə bağlı) Paddle bildiriş secret-i — webhook üçün
   FIREBASE_SERVICE_ACCOUNT  Firebase service account JSON (bütöv mətn) — balansı yazmaq üçün MÜTLƏQDİR
   FIREBASE_PROJECT_ID       standart: yevrolatotest
   AZN_PER_USD               standart: 1.70
   PADDLE_ENV                "sandbox" yazsan test mühiti
============================================================================ */
const PADDLE_API_KEY = process.env.PADDLE_API_KEY;
const PADDLE_WEBHOOK_SECRET = process.env.PADDLE_WEBHOOK_SECRET;
const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'yevrolatotest';
const AZN_PER_USD = Number(process.env.AZN_PER_USD) || 1.70;
const PADDLE_BASE = process.env.PADDLE_ENV === 'sandbox'
  ? 'https://sandbox-api.paddle.com'
  : 'https://api.paddle.com';
const MIN_AZN = 3;
const MAX_AZN = 5000;

/* ---------- Firebase Admin ----------
   Token yoxlamaq üçün yalnız projectId kifayətdir.
   Balansı yazmaq üçün service account (hasCreds) lazımdır. */
let hasCreds = false;
let credProject = '';
let dataAppReady = false;
try {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (raw) {
    const sa = JSON.parse(raw);
    if (sa.private_key) sa.private_key = String(sa.private_key).replace(/\\n/g, '\n');
    credProject = sa.project_id || '';
    admin.initializeApp({ credential: admin.credential.cert(sa), projectId: credProject || PROJECT_ID });
    hasCreds = credProject === PROJECT_ID;
    dataAppReady = true;
    if (!hasCreds) console.error(`DİQQƏT: service account "${credProject}" layihəsindəndir, sayt isə "${PROJECT_ID}" istifadə edir!`);
  }
} catch (e) {
  console.error('Firebase service account oxunmadı:', e.message);
}
if (!dataAppReady) {
  admin.initializeApp({ projectId: PROJECT_ID });
  console.warn('DİQQƏT: FIREBASE_SERVICE_ACCOUNT yoxdur/oxunmadı — ödəniş yaradılmayacaq.');
}
/* Token həmişə saytın Firebase layihəsinə qarşı yoxlanılır (service account-dan asılı olmayaraq) */
const authApp = admin.initializeApp({ projectId: PROJECT_ID }, 'auth-check');
if (!PADDLE_API_KEY) console.warn('DİQQƏT: PADDLE_API_KEY təyin olunmayıb!');

const db = () => admin.firestore();
const paddleHeaders = () => ({ Authorization: `Bearer ${PADDLE_API_KEY}`, 'Content-Type': 'application/json' });

const app = express();
app.use(cors());

app.get('/health', (req, res) => {
  res.json({
    status: 'Aktivdir',
    service: 'Paddle Backend',
    firebaseCredentials: hasCreds,
    serviceAccountProject: credProject || null,
    expectedProject: PROJECT_ID,
    paddleKey: !!PADDLE_API_KEY,
    webhookSecret: !!PADDLE_WEBHOOK_SECRET,
    env: process.env.PADDLE_ENV === 'sandbox' ? 'sandbox' : 'live'
  });
});

/* ---------- Balansı yazmaq (təkrar yazılmaya qarşı qorunur) ---------- */
async function creditPayment(txnId, uid, azn) {
  if (!hasCreds) return 'nocreds';
  const payRef = db().collection('paddlePayments').doc(txnId);
  return db().runTransaction(async (t) => {
    const paySnap = await t.get(payRef);
    if (paySnap.exists && paySnap.data().status === 'paid') return 'already';
    const userRef = db().collection('users').doc(uid);
    const userSnap = await t.get(userRef);
    if (!userSnap.exists) return 'nouser';
    t.update(userRef, {
      balance: admin.firestore.FieldValue.increment(azn),
      points: admin.firestore.FieldValue.increment(azn),
      payWheelSpins: admin.firestore.FieldValue.increment(1)
    });
    t.set(userRef.collection('history').doc(), {
      type: 'deposit',
      amount: azn,
      description: 'Paddle ilə kart depozit',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    t.set(payRef, {
      uid, azn, usd: Math.round((azn / AZN_PER_USD) * 100) / 100,
      status: 'paid',
      paidAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    return 'credited';
  });
}

function parseCustomData(txn) {
  const cd = (txn && txn.custom_data) || {};
  const azn = Math.round(Number(cd.azn) * 100) / 100;
  return { uid: cd.uid ? String(cd.uid) : '', azn: (azn > 0 && isFinite(azn)) ? azn : 0 };
}

/* ---------- Paddle webhook (istəyə bağlı, xam body lazımdır) ---------- */
function verifyPaddleSignature(rawBody, header, secret) {
  if (!secret || !header) return false;
  const parts = {};
  String(header).split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) parts[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  });
  if (!parts.ts || !parts.h1) return false;
  if (Math.abs(Date.now() / 1000 - Number(parts.ts)) > 5 * 60) return false;
  const calc = crypto.createHmac('sha256', secret).update(`${parts.ts}:${rawBody.toString('utf8')}`).digest('hex');
  const a = Buffer.from(calc), b = Buffer.from(parts.h1);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

app.post('/paddle-webhook', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
  const raw = req.body;
  if (!Buffer.isBuffer(raw) || !verifyPaddleSignature(raw, req.get('Paddle-Signature'), PADDLE_WEBHOOK_SECRET)) {
    return res.status(401).send('invalid signature');
  }
  try {
    const event = JSON.parse(raw.toString('utf8'));
    if (event.event_type === 'transaction.completed' && event.data && event.data.id) {
      const { uid, azn } = parseCustomData(event.data);
      if (uid && azn) {
        const result = await creditPayment(event.data.id, uid, azn);
        console.log('Paddle webhook:', event.data.id, result);
      }
    }
    res.status(200).send('ok');
  } catch (e) {
    console.error('Webhook xətası:', e);
    res.status(500).send('error');
  }
});

app.use(express.json());

/* ---------- İstifadəçi tokeni ---------- */
async function authUser(req) {
  const h = req.get('Authorization') || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return { error: 'Giriş tələb olunur (token göndərilməyib). Səhifəni yeniləyib yenidən daxil olun.' };
  try {
    const decoded = await admin.auth(authApp).verifyIdToken(m[1]);
    return { user: decoded };
  } catch (e) {
    console.error('Token xətası:', e.code || e.message);
    return { error: `Sessiya etibarsızdır (${e.code || 'token'}), yenidən daxil olun.` };
  }
}

/* ---------- Ödəniş yaratma: istifadəçi AZN yazır, Paddle-a USD gedir ---------- */
app.post('/create-paddle-payment', async (req, res) => {
  try {
    const a = await authUser(req);
    if (!a.user) return res.status(401).json({ success: false, error: a.error });
    const user = a.user;

    if (!PADDLE_API_KEY) {
      return res.status(500).json({ success: false, error: 'Server xətası: PADDLE_API_KEY təyin olunmayıb.' });
    }
    if (!hasCreds) {
      return res.status(500).json({ success: false, error: credProject && credProject !== PROJECT_ID ? `Server xətası: service account "${credProject}" layihəsindəndir, olmalıdır "${PROJECT_ID}".` : 'Server xətası: FIREBASE_SERVICE_ACCOUNT təyin olunmayıb və ya oxunmayıb (balans yazıla bilməz).' });
    }

    const aznAmount = Math.round(Number(req.body.amount) * 100) / 100;
    if (!aznAmount || !isFinite(aznAmount) || aznAmount < MIN_AZN) {
      return res.status(400).json({ success: false, error: `Minimum məbləğ ${MIN_AZN} AZN olmalıdır.` });
    }
    if (aznAmount > MAX_AZN) {
      return res.status(400).json({ success: false, error: 'Məbləğ çox böyükdür.' });
    }

    const usdAmount = Math.round((aznAmount / AZN_PER_USD) * 100) / 100;
    const usdCents = Math.round(usdAmount * 100);

    const body = {
      items: [{
        quantity: 1,
        price: {
          name: 'YevroLato Depozit',
          description: `Balans artırımı (${aznAmount.toFixed(2)} AZN)`,
          unit_price: { amount: String(usdCents), currency_code: 'USD' },
          product: { name: 'Balans artırımı', tax_category: 'standard' }
        }
      }],
      custom_data: { uid: user.uid, azn: String(aznAmount) }
    };
    if (user.email && !/@(phone\.)?yevroloto\.app$/i.test(user.email)) {
      /* Paddle müştəri yaratması üçün real e-poçt lazımdır; avtomatik e-poçtlar göndərilmir */
    }

    const response = await axios.post(`${PADDLE_BASE}/transactions`, body, { headers: paddleHeaders(), timeout: 30000 });

    const txn = response.data && response.data.data;
    const checkoutUrl = txn && txn.checkout && txn.checkout.url;
    if (!txn || !txn.id) {
      return res.status(502).json({ success: false, error: 'Paddle cavab vermədi.' });
    }
    if (!checkoutUrl) {
      return res.status(502).json({ success: false, error: 'Paddle ödəniş linki qaytarmadı. Paddle → Checkout settings-də "Default payment link" və domen təyin edin.' });
    }

    await db().collection('paddlePayments').doc(txn.id).set({
      uid: user.uid,
      azn: aznAmount,
      usd: usdAmount,
      rate: AZN_PER_USD,
      status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({ success: true, checkout_url: checkoutUrl, transaction_id: txn.id, azn: aznAmount, usd: usdAmount });
  } catch (error) {
    const pd = error.response && error.response.data;
    console.error('Paddle Error:', pd ? JSON.stringify(pd) : error.message);
    const detail = pd && pd.error && (pd.error.detail || pd.error.code);
    res.status(500).json({ success: false, error: 'Ödəniş yaradıla bilmədi' + (detail ? ': ' + detail : '.') });
  }
});

/* ---------- Ödəniş statusu: Paddle-dan yoxlayır, ödənibsə balansı yazır ---------- */
app.get('/payment-status', async (req, res) => {
  try {
    const a = await authUser(req);
    if (!a.user) return res.status(401).json({ success: false, error: a.error });
    const order = String(req.query.order || '');
    if (!/^txn_[A-Za-z0-9]+$/.test(order)) {
      return res.status(400).json({ success: false, error: 'order səhvdir' });
    }

    let txn;
    try {
      const r = await axios.get(`${PADDLE_BASE}/transactions/${order}`, { headers: paddleHeaders(), timeout: 30000 });
      txn = r.data && r.data.data;
    } catch (e) {
      if (e.response && e.response.status === 404) return res.status(404).json({ success: false, error: 'tapılmadı' });
      throw e;
    }
    const { uid, azn } = parseCustomData(txn);
    if (!txn || uid !== a.user.uid) return res.status(404).json({ success: false, error: 'tapılmadı' });

    if (txn.status === 'completed' || txn.status === 'paid') {
      const result = await creditPayment(order, uid, azn);
      if (result === 'credited' || result === 'already') {
        return res.json({ success: true, status: 'paid', azn });
      }
      return res.status(500).json({ success: false, error: 'Balans yazıla bilmədi: ' + result });
    }
    if (txn.status === 'canceled') return res.json({ success: true, status: 'failed' });
    res.json({ success: true, status: 'pending' });
  } catch (e) {
    console.error('Status xətası:', e.response ? JSON.stringify(e.response.data) : e.message);
    res.status(500).json({ success: false, error: 'Status yoxlanmadı' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Paddle Backend serveri ${PORT} portunda işləyir...`);
});
