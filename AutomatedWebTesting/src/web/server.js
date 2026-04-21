'use strict';

require('dotenv').config();
const express = require('express');
const path = require('path');

const apiRoutes = require('./routes/api');
const pageRoutes = require('./routes/pages');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Routes
app.use('/api', apiRoutes);
app.use('/', pageRoutes);

// Start server
app.listen(PORT, () => {
  console.log(`\n  QA Dashboard running at http://localhost:${PORT}\n`);
});

module.exports = app;
