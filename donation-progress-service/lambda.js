'use strict';
// Lab 7: run the SAME Express app on AWS Lambda.
// serverless-http turns the Lambda event into an Express request, and the Express response back into the answer.
const serverless = require('serverless-http');
const app = require('./app');

module.exports.handler = serverless(app); // Lambda setting: handler = lambda.handler
