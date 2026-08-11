const express = require('express');
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 3333;

app.use(cors());
app.use(express.json());

app.get('/api/status', (req, res) => {
  res.json({
    name: 'Aferiy Powerstation',
    level: 68,
    state: 'charging',
    lastUpdated: new Date().toISOString(),
  });
});

app.post('/api/charge', (req, res) => {
  res.json({ success: true, message: 'Charge command received.' });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
