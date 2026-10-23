require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Delay utility function
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Helper function to format phone numbers to 254XXXXXXXXX
function formatPhone(phone) {
  let cleaned = phone.replace(/\D/g, '');
  if (cleaned.startsWith('0')) {
    cleaned = '254' + cleaned.slice(1);
  } else if (cleaned.startsWith('7') || cleaned.startsWith('1')) {
    cleaned = '254' + cleaned;
  } else if (cleaned.startsWith('+254')) {
    cleaned = cleaned.replace('+254', '254');
  }
  return cleaned;
}

// Bulk STK Push Endpoint
app.post('/api/bulk-stk', async (expressReq, expressRes) => {
  const { numbers, amount, reference, description } = expressReq.body;
  const apiKey = process.env.SNAPEARN_API_KEY;

  if (!apiKey) {
    return expressRes.status(500).json({
      success: false,
      message: 'Server missing SNAPEARN_API_KEY environment variable.',
    });
  }

  if (!numbers || !Array.isArray(numbers) || numbers.length === 0) {
    return expressRes.status(400).json({
      success: false,
      message: 'Please provide an array of phone numbers.',
    });
  }

  if (!amount || Number(amount) <= 0) {
    return expressRes.status(400).json({
      success: false,
      message: 'Please provide a valid amount.',
    });
  }

  // Set SSE (Server-Sent Events) headers for live streaming updates to frontend
  expressRes.setHeader('Content-Type', 'text/event-stream');
  expressRes.setHeader('Cache-Control', 'no-cache');
  expressRes.setHeader('Connection', 'keep-alive');

  // Track if client disconnects to abort further dispatches
  let isConnected = true;
  expressReq.on('close', () => {
    isConnected = false;
  });

  const sendEvent = (data) => {
    if (isConnected) {
      expressRes.write(`data: ${JSON.stringify(data)}\n\n`);
    }
  };

  sendEvent({ type: 'start', total: numbers.length });

  for (let i = 0; i < numbers.length; i++) {
    if (!isConnected) break; // Stop loop if client disconnected

    const rawPhone = numbers[i].trim();
    if (!rawPhone) continue;

    const formattedPhone = formatPhone(rawPhone);

    try {
      const apiResponse = await fetch('https://api.snapearn.co.ke/api/stk-push', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          phone: formattedPhone,
          amount: Number(amount),
          reference: reference || 'ORD001',
          description: description || 'Order Payment',
        }),
      });

      // Capture raw response text for diagnostic visibility
      const responseText = await apiResponse.text();
      let responseData;
      try {
        responseData = JSON.parse(responseText);
      } catch (e) {
        responseData = { raw: responseText };
      }

      // PRINT DIAGNOSTICS TO YOUR TERMINAL WINDOW
      console.log(`[SnapEarn API Response for ${formattedPhone}] Status: ${apiResponse.status}`, responseData);

      sendEvent({
        type: 'progress',
        index: i + 1,
        total: numbers.length,
        phone: formattedPhone,
        status: apiResponse.ok ? 'SUCCESS' : 'FAILED',
        response: responseData,
      });
    } catch (err) {
      console.error(`[Network/Fetch Error for ${formattedPhone}]:`, err.message);
      sendEvent({
        type: 'progress',
        index: i + 1,
        total: numbers.length,
        phone: formattedPhone,
        status: 'ERROR',
        error: err.message,
      });
    }

    // 6-second delay between requests (except after the last item)
    if (i < numbers.length - 1 && isConnected) {
      sendEvent({ type: 'delay', seconds: 6 });
      await sleep(6000);
    }
  }

  if (isConnected) {
    sendEvent({ type: 'complete', message: 'All dispatches finished.' });
    expressRes.end();
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
