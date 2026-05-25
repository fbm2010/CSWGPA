/**
 * JWT Authentication Middleware.
 * Reads Bearer token from Authorization header.
 * Sets req.userId on success.
 */
const jwt = require('jsonwebtoken');

function authenticateJWT(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing Authorization header' });
  }
  try {
    const payload = jwt.verify(
      header.slice(7),
      process.env.JWT_SECRET || 'dev_secret_replace_me'
    );
    req.userId = payload.sub;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

module.exports = { authenticateJWT };
