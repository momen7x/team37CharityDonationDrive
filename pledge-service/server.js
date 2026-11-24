'use strict';
// Runs the service on your PC: npm run dev  ->  http://localhost:3002/api/health
require('dotenv').config();
const app = require('./app');

const port = Number(process.env.PORT) || 3002;
app.listen(port, () => console.log(`pledge-service listening on http://localhost:${port}`));
