// generate-secret.js
// Run this with: node generate-secret.js
// Prints a random 64-character hex string you can use as JWT_SECRET.

const crypto = require('crypto');
console.log(crypto.randomBytes(32).toString('hex'));
