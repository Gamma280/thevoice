// Vercel entry point: the whole Express app (API, /mcp, /health) runs as ONE serverless function.
// vercel.json rewrites /api/*, /mcp and /health here; everything in public/ is served statically.
module.exports = require('../server');
