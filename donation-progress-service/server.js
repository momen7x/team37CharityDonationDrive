'use strict';
// Runs the service on your PC: npm run dev  ->  http://localhost:3003/api/health
require('dotenv').config();
const app = require('./app');

const port = Number(process.env.PORT) || 3003;
app.listen(port, () => console.log(`donation-progress-service listening on http://localhost:${port}`));
