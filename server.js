const express = require('express');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const SNAPEARN_API_KEY = process.env.SNAPEARN_API_KEY;
const API_URL = 'https://api.snapearn.co.ke/api/stk-push';

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
  if (logs.length > 100) logs.pop(); // Keep last 100 logs
}

// Function to normalize Kenyan phone numbers to 2547XXXXXXXX / 2541XXXXXXXX format
function formatPhoneNumber(phone) {
  let cleaned = phone.replace(/\D/g, '');
  if (cleaned.startsWith('0')) {
    cleaned = '254' + cleaned.substring(1);
  } else if (cleaned.startsWith('7') || cleaned.startsWith('1')) {
    cleaned = '254' + cleaned;
  }
  return cleaned;
}

// Process the queue one item at a time with a 6-second delay
async function processQueue() {
  if (isProcessing || queue.length === 0) return;

  isProcessing = true;
  const task = queue.shift();

  try {
    addLog(`Sending STK push to ${task.phone} for KES ${task.amount}...`, 'info');

    const response = await fetch(API_URL, {
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

    const data = await response.json();

    if (response.ok) {
      addLog(`SUCCESS [${task.phone}]: ${JSON.stringify(data)}`, 'success');
    } else {
      addLog(`FAILED [${task.phone}]: ${JSON.stringify(data)}`, 'error');
    }
  } catch (error) {
    addLog(`ERROR [${task.phone}]: ${error.message}`, 'error');
  }

  // Enforce 6-second delay before processing next item
  if (queue.length > 0) {
    addLog(`Waiting 6 seconds before next dispatch... (${queue.length} remaining in queue)`, 'info');
    setTimeout(() => {
      isProcessing = false;
      processQueue();
    }, 6000);
  } else {
    addLog('Queue processing complete.', 'success');
    isProcessing = false;
  }
}

// API Routes
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
      const ref = reference ? `${reference}-${Date.now()}-${index + 1}` : `REF-${Date.now()}-${index + 1}`;
      queue.push({
        phone: formattedPhone,
        amount,
        reference: ref,
        description: description || 'Batch Payment'
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
