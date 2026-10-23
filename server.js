const express = require('express');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const SNAPEARN_API_KEY = process.env.SNAPEARN_API_KEY;
const STK_URL = 'https://api.snapearn.co.ke/api/stk-push.php';
const STATUS_URL = 'https://api.snapearn.co.ke/api/transaction.php';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Global queue and processing state
const queue = [];
let isProcessing = false;
const logs = [];

function addLog(message, type = 'info') {
  const timestamp = new Date().toLocaleTimeString();
  const logEntry = { timestamp, message, type };
  logs.unshift(logEntry);
  if (logs.length > 100) logs.pop();
}

function formatPhoneNumber(phone) {
  let cleaned = phone.replace(/\D/g, '');
  if (cleaned.startsWith('0')) {
    cleaned = '254' + cleaned.substring(1);
  } else if (cleaned.startsWith('7') || cleaned.startsWith('1')) {
    cleaned = '254' + cleaned;
  }
  return cleaned;
}

// Safely parse JSON responses to prevent unexpected token crashes
async function safeParseResponse(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    return { error: 'Non-JSON response received', rawResponse: text.substring(0, 150) };
  }
}

async function checkTransactionStatus(transactionId, phone) {
  try {
    addLog(`Checking status for transaction ID: ${transactionId} (${phone})...`, 'info');
    
    const response = await fetch(`${STATUS_URL}?id=${transactionId}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${SNAPEARN_API_KEY}`
      }
    });

    const data = await safeParseResponse(response);

    if (response.ok) {
      addLog(`STATUS CHECK [${phone}]: ${JSON.stringify(data)}`, 'success');
    } else {
      addLog(`STATUS CHECK FAILED [${phone}]: ${JSON.stringify(data)}`, 'error');
    }
  } catch (error) {
    addLog(`STATUS CHECK ERROR [${phone}]: ${error.message}`, 'error');
  }
}

async function processQueue() {
  if (isProcessing || queue.length === 0) return;

  isProcessing = true;
  const task = queue.shift();

  try {
    addLog(`Sending STK push to ${task.phone} for KES ${task.amount}...`, 'info');

    const response = await fetch(STK_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SNAPEARN_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        phone: task.phone,
        amount: Number(task.amount),
        reference: task.reference,
        description: task.description
      })
    });

    const data = await safeParseResponse(response);

    if (response.ok && !data.error) {
      addLog(`SUCCESS [${task.phone}]: ${JSON.stringify(data)}`, 'success');
      
      const txnId = data.id || data.transaction_id || data.uuid || data.checkoutRequestID;
      
      if (txnId) {
        setTimeout(() => {
          checkTransactionStatus(txnId, task.phone);
        }, 15000);
      }
    } else {
      addLog(`FAILED [${task.phone}]: ${JSON.stringify(data)}`, 'error');
    }
  } catch (error) {
    addLog(`ERROR [${task.phone}]: ${error.message}`, 'error');
  }

  if (queue.length > 0) {
    addLog(`Waiting 6 seconds before next dispatch... (${queue.length} remaining)`, 'info');
    setTimeout(() => {
      isProcessing = false;
      processQueue();
    }, 6000);
  } else {
    addLog('Queue processing complete.', 'success');
    isProcessing = false;
  }
}

app.post('/api/enqueue', (req, res) => {
  const { numbers, amount, reference, description } = req.body;

  if (!numbers || !Array.isArray(numbers) || numbers.length === 0) {
    return res.status(400).json({ error: 'Please provide an array of phone numbers.' });
  }

  if (!amount || isNaN(amount) || amount <= 0) {
    return res.status(400).json({ error: 'Please provide a valid amount.' });
  }

  let addedCount = 0;
  numbers.forEach((rawPhone, index) => {
    const formattedPhone = formatPhoneNumber(rawPhone.toString());
    if (formattedPhone.length === 12) {
      const ref = reference ? `${reference}-${index + 1}` : `BULK-${index + 1}`;
      queue.push({
        phone: formattedPhone,
        amount,
        reference: ref.substring(0, 12),
        description: (description || 'Batch Push').substring(0, 13)
      });
      addedCount++;
    }
  });

  addLog(`Enqueued ${addedCount} valid numbers. Queue length: ${queue.length}`, 'info');

  if (!isProcessing) {
    processQueue();
  }

  res.json({ message: `Successfully queued ${addedCount} requests.`, queueLength: queue.length });
});

app.get('/api/status', (req, res) => {
  res.json({
    queueLength: queue.length,
    isProcessing,
    logs
  });
});

app.listen(PORT, () => {
  console.log(`STK Push Bot listening on port ${PORT}`);
});
