const express = require('express');
const cors = require('cors');
const routes = require('./routes');
require('dotenv').config({ override: true });

const app = express();
app.use(cors());
app.use(express.json());

// Apply routes
app.use('/api', routes);

// Healthcheck endpoint
app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

module.exports = app;
