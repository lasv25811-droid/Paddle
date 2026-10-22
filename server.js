const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const admin = require('firebase-admin');

/* ================== KONFİQURASİYA (Render → Environment) ==================
   PADDLE_API_KEY          Paddle Billing API açarı (Developer Tools → Authentication)
   PADDLE_WEBHOOK_SECRET   Paddle bildiriş (notification) destination secret-i
   FIREBASE_SERVICE_ACCOUNT  Firebase service account JSON (bütöv mətn kimi)
   AZN_PER_USD             1 USD neçə AZN (standart 1.70)
   PADDLE_ENV              "sandbox" yazsan test mühiti işləyir (standart: canlı)
============================================================================ */
const PADDLE_API_KEY = process.env.PADDLE_API_KEY;
const PADDLE_WEBHOOK_SECRET = process.env.PADDLE_WEBHOOK_SECRET;
const AZN_PER_USD = Number(process.env.AZN_PER_USD) || 1.70;
const PADDLE_BASE = process.env.PADDLE_ENV === 'sandbox'
  ? 'https://sandbox-api.paddle.com'
  : 'https://api.paddle.com';
const MIN_AZN = 3;

if (!PADDLE_API_KEY) console.warn('DİQQƏT: PADDLE_API_KEY təyin olunmayıb!');
if (!PADDLE_WEBHOOK_SECRET) console.warn('DİQQƏT: PADDLE_WEBHOOK_SECRET təyin olunmayıb!');

try {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
  });
} catch (e) {
  console.error('Firebase admin başlamadı (FIREBASE_SERVICE_ACCOUNT yoxlayın):', e.message);
}
const db = () => admin.firestore();

const app = express();
app.use(cors());

app.get('/health', (req, res) => {
  res.json({ status: 'Aktivdir', service: 'Paddle Backend' });
});

/* ---------- Paddle webhook (xam body lazımdır, express.json-dan ƏVVƏL) ---------- */
function verifyPaddleSignature(rawBody, header, secret) {
  if (!secret || !header) return false;
  const parts = {};
  String(header).split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) parts[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  });
  if (!parts.ts || !parts.h1) return false;
  if (Math.abs(Date.now() / 1000 - Number(parts.ts)) > 5 * 60) return false; // köhnə sorğu
  const calc = crypto.createHmac('sha256', secret)
    .update(`${parts.ts}:${rawBody.toString('utf8')}`).digest('hex');
  const a = Buffer.from(calc), b = Buffer.from(parts.h1);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function creditPayment(txnId) {
  const payRef = db().collection('paddlePayments').doc(txnId);
  return db().runTransaction(async (t) => {
    const paySnap = await t.get(payRef);
    if (!paySnap.exists) return 'unknown';
    const pay = paySnap.data();
    if (pay.status === 'paid') return 'already';
    const userRef = db().collection('users').doc(pay.uid);
    const userSnap = await t.get(userRef);
    if (!userSnap.exists) return 'nouser';
    const azn = Number(pay.azn) || 0;
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
    t.update(payRef, { status: 'paid', paidAt: admin.firestore.FieldValue.serverTimestamp() });
    return 'credited';
  });
}

app.post('/paddle-webhook', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
  const raw = req.body;
  if (!Buffer.isBuffer(raw) || !verifyPaddleSignature(raw, req.get('Paddle-Signature'), PADDLE_WEBHOOK_SECRET)) {
    return res.status(401).send('invalid signature');
  }
  try {
    const event = JSON.parse(raw.toString('utf8'));
    if (event.event_type === 'transaction.completed' && event.data && event.data.id) {
      const result = await creditPayment(event.data.id);
      console.log('Paddle webhook:', event.data.id, result);
    }
    res.status(200).send('ok');
  } catch (e) {
    console.error('Webhook xətası:', e);
    res.status(500).send('error'); // Paddle yenidən cəhd edəcək
  }
});

app.use(express.json());

async function authUser(req) {
  const h = req.get('Authorization') || '';
  const m = h.match(/^Bearer (.+)$/);
  if (!m) return null;
  try { return await admin.auth().verifyIdToken(m[1]); } catch (_) { return null; }
}

/* ---------- Ödəniş yaratma: istifadəçi AZN yazır, Paddle-a USD gedir ---------- */
app.post('/create-paddle-payment', async (req, res) => {
  try {
    const user = await authUser(req);
    if (!user) return res.status(401).json({ success: false, error: 'Giriş tələb olunur.' });

    const aznAmount = Math.round(Number(req.body.amount) * 100) / 100;
    if (!aznAmount || !isFinite(aznAmount) || aznAmount < MIN_AZN) {
      return res.status(400).json({ success: false, error: `Minimum məbləğ ${MIN_AZN} AZN olmalıdır.` });
    }
    if (aznAmount > 5000) {
      return res.status(400).json({ success: false, error: 'Məbləğ çox böyükdür.' });
    }

    const usdAmount = Math.round((aznAmount / AZN_PER_USD) * 100) / 100;
    const usdCents = Math.round(usdAmount * 100);

    const response = await axios.post(`${PADDLE_BASE}/transactions`, {
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
    }, {
      headers: { Authorization: `Bearer ${PADDLE_API_KEY}`, 'Content-Type': 'application/json' }
    });

    const txn = response.data && response.data.data;
    const checkoutUrl = txn && txn.checkout && txn.checkout.url;
    if (!txn || !txn.id || !checkoutUrl) {
      return res.status(500).json({ success: false, error: 'Paddle ödəniş linki qaytarmadı. Paddle-da "Default payment link" təyin edilib?' });
    }

    await db().collection('paddlePayments').doc(txn.id).set({
      uid: user.uid,
      azn: aznAmount,
      usd: usdAmount,
      rate: AZN_PER_USD,
      status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({
      success: true,
      checkout_url: checkoutUrl,
      transaction_id: txn.id,
      azn: aznAmount,
      usd: usdAmount
    });
  } catch (error) {
    console.error('Paddle Error:', error.response ? JSON.stringify(error.response.data) : error.message);
    res.status(500).json({ success: false, error: 'Ödəniş yaradıla bilmədi.' });
  }
});

/* ---------- Ödəniş statusu (frontend geri qayıdanda yoxlayır) ---------- */
app.get('/payment-status', async (req, res) => {
  try {
    const user = await authUser(req);
    if (!user) return res.status(401).json({ success: false, error: 'Giriş tələb olunur.' });
    const order = String(req.query.order || '');
    if (!order) return res.status(400).json({ success: false, error: 'order yoxdur' });
    const snap = await db().collection('paddlePayments').doc(order).get();
    if (!snap.exists || snap.data().uid !== user.uid) {
      return res.status(404).json({ success: false, error: 'tapılmadı' });
    }
    const p = snap.data();
    res.json({ success: true, status: p.status, azn: p.azn, usd: p.usd });
  } catch (e) {
    console.error('Status xətası:', e.message);
    res.status(500).json({ success: false, error: 'xəta' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Paddle Backend serveri ${PORT} portunda işləyir...`);
});
