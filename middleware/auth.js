const jwt = require('jsonwebtoken');
const logger = require('../lib/logger');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('JWT_SECRET is not set. Copy .env.example to .env and set a real secret.');
}
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '8h';

function signToken(user) {
  return jwt.sign(
    { userId: user._id.toString(), username: user.username, role: user.role },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ success: false, message: 'Login required.' });
  }
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    return next();
  } catch (err) {
    logger.warn({ err: err.message }, 'Rejected invalid/expired token');
    return res.status(401).json({ success: false, message: 'Session expired. Please log in again.' });
  }
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ success: false, message: 'Login required.' });
  if (req.user.role !== 'admin') return res.status(403).json({ success: false, message: 'Admins only.' });
  return next();
}

module.exports = { signToken, requireAuth, requireAdmin, JWT_SECRET };