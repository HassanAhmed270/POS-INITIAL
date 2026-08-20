const express = require('express');
const bcrypt = require('bcrypt');
const User = require('../models/user');
const { signToken } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { loginLimiter } = require('../middleware/rateLimit');
const logger = require('../lib/logger');

const router = express.Router();

router.post(
  '/login',
  loginLimiter,
  asyncHandler(async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ success: false, message: 'Username and password are required.' });
    }

    const user = await User.findOne({ username: username.trim().toLowerCase() });
    const genericFail = { success: false, message: 'Invalid username or password.' };

    if (!user) {
      logger.warn({ username }, 'Login attempt for unknown user');
      return res.status(401).json(genericFail);
    }

    const passwordOk = await bcrypt.compare(password, user.passwordHash);
    if (!passwordOk) {
      logger.warn({ username: user.username }, 'Login attempt with wrong password');
      return res.status(401).json(genericFail);
    }

    const token = signToken(user);
    logger.info({ username: user.username, role: user.role }, 'Login successful');
    return res.status(200).json({ success: true, token, user: { username: user.username, role: user.role } });
  })
);

module.exports = router;