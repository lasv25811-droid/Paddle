const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

// Sizin verdiyiniz Paddle Key
const PADDLE_API_KEY = "MME8KQ1JDXPJ22EPCC37NA5RNGNHJMH7QC7DHFB4QWTXC4YFH5";

// Əsas yoxlama endpoint-i
app.get('/health', (req, res) => {
  res.json({ status: 'Aktivdir', service: 'Paddle Backend' });
});

// Paddle ödəniş yaratma endpoint-i
app.post('/create-paddle-payment', async (req, res) => {
  try {
    const { amount, uid, email } = req.body;

    if (!amount || amount < 3) {
      return res.status(400).json({ success: false, error: 'Minimum məbləğ 3 AZN olmalıdır.' });
    }

    // Paddle Billing API (v2) üçün dinamik məbləğlə əməliyyat yaratmaq
    // Qeyd: Paddle API-də məbləğlər cent/qəpik ilə hesablanmırsa dəqiq format göndərilməlidir.
    const response = await axios.post('https://api.paddle.com/transactions', {
      items: [
        {
          price: {
            description: "YevroLato Depozit",
            unit_price: {
              amount: (amount * 100).toString(), // Qəpik formatında
              currency_code: "AZN"
            },
            product: {
              name: "Balans artırımı",
              tax_category: "standard"
            }
          },
          quantity: 1
        }
      ],
      customer: {
        email: email || "customer@yevroloto.app"
      },
      custom_data: {
        uid: uid
      }
    }, {
      headers: {
        'Authorization': `Bearer ${PADDLE_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    if (response.data && response.data.data) {
      // Ödəniş linkini frontend-ə qaytarırıq
      res.json({
        success: true,
        checkout_url: response.data.data.checkout.url,
        transaction_id: response.data.data.id
      });
    } else {
      res.status(500).json({ success: false, error: 'Paddle API xətası.' });
    }

  } catch (error) {
    console.error('Paddle Error:', error.response ? error.response.data : error.message);
    res.status(500).json({ 
      success: false, 
      error: 'Ödəniş yaradıla bilmədi.',
      details: error.response ? error.response.data : error.message
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Paddle Backend serveri ${PORT} portunda işləyir...`);
});
