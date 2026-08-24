require('./redis/client');
const config = require('./config/index');
const express = require('express');
const mongoose = require('mongoose');
const chatRoutes = require('./routes/chat.routes');
const adminRoutes = require('./routes/admin.routes');
const { isAvailable } = require('./redis/client');
const usageWorker = require('./queue/usageWorker');
const { adminAuth } = require('./middleware/adminAuth.middleware');

const app = express();

app.use(express.json());

app.use('/v1', chatRoutes);
app.use('/admin',adminAuth, adminRoutes);

app.get('/health', (req, res) => {
  res.json({ status: 'ok', redis: isAvailable() ? 'up' : 'down' });
});

mongoose
  .connect(process.env.MONGO_URI)
  .then(() => {
    usageWorker.run();

    app.listen(config.port, () => {
      console.log(`Gateway listening on port ${config.port}`);
    });
  })
  .catch((err) => {
    console.error('Mongo connection failed:', err);
    process.exit(1);
  });