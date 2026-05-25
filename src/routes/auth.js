/**
 * ATLAS GPA — Google OAuth + User Profile Routes
 *
 * GET  /auth/google               → redirect to Google
 * GET  /auth/google/callback      → handle callback, issue JWT
 * GET  /auth/logout               → clear session
 * GET  /api/me                    → user profile (includes needsHighSchoolYear)
 * PUT  /api/me/high-school-year   → set HS year, clear popup flag
 * PUT  /api/user/import_method    → toggle pdf/manual preference
 *
 * FRONTEND INTEGRATION NOTE:
 * /api/me returns { needsHighSchoolYear: true } on first Google login.
 * The existing frontend reads this flag to trigger a "What year in high school
 * are you?" popup. No frontend code changes needed — the flag is the trigger.
 * Once user answers, frontend calls PUT /api/me/high-school-year and the flag
 * is permanently set to false.
 */

const express  = require('express');
const passport = require('passport');
const { Strategy: GoogleStrategy } = require('passport-google-oauth20');
const jwt      = require('jsonwebtoken');
const crypto   = require('crypto');
const { getDb } = require('../db');
const { authenticateJWT } = require('../middleware/auth');
const router   = express.Router();

// ── Passport Google Strategy ─────────────────────────────────────────────────

function setupPassport() {
  if (!process.env.GOOGLE_OAUTH_CLIENT_ID) {
    console.warn('[auth] GOOGLE_OAUTH_CLIENT_ID not set — Google login disabled');
    return;
  }

  passport.use(new GoogleStrategy(
    {
      clientID:     process.env.GOOGLE_OAUTH_CLIENT_ID,
      clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
      callbackURL:  process.env.OAUTH_CALLBACK_URL || 'http://localhost:3000/auth/google/callback',
    },
    async (accessToken, refreshToken, profile, done) => {
      try {
        const db          = getDb();
        const googleId    = profile.id;
        const email       = profile.emails?.[0]?.value;
        const displayName = profile.displayName;
        const avatarUrl   = profile.photos?.[0]?.value;

        if (!email) return done(new Error('No email from Google'), null);

        let user = db.prepare('SELECT * FROM users WHERE google_id = ?').get(googleId)
                || db.prepare('SELECT * FROM users WHERE email = ?').get(email);

        if (user) {
          if (!user.google_id) {
            db.prepare('UPDATE users SET google_id=?, updated_at=datetime("now") WHERE id=?')
              .run(googleId, user.id);
            user = db.prepare('SELECT * FROM users WHERE id=?').get(user.id);
          }
        } else {
          // New user — set needs_high_school_year = 1
          const id = crypto.randomUUID();
          db.prepare(`
            INSERT INTO users (id, google_id, email, display_name, avatar_url, needs_high_school_year)
            VALUES (?, ?, ?, ?, ?, 1)
          `).run(id, googleId, email, displayName, avatarUrl);
          user = db.prepare('SELECT * FROM users WHERE id=?').get(id);
        }

        done(null, user);
      } catch (err) {
        done(err, null);
      }
    }
  ));

  passport.serializeUser((user, done) => done(null, user.id));
  passport.deserializeUser((id, done) => {
    try {
      const user = getDb().prepare('SELECT * FROM users WHERE id=?').get(id);
      done(null, user || false);
    } catch (err) { done(err); }
  });
}

setupPassport();

// ── Helpers ───────────────────────────────────────────────────────────────────

function issueJWT(user) {
  return jwt.sign(
    { sub: user.id, email: user.email },
    process.env.JWT_SECRET || 'dev_secret_replace_me',
    { expiresIn: '7d' }
  );
}

function formatProfile(user) {
  return {
    id:                    user.id,
    email:                 user.email,
    displayName:           user.display_name,
    avatarUrl:             user.avatar_url,
    highSchoolYear:        user.high_school_year || null,
    needsHighSchoolYear:   user.needs_high_school_year === 1,
    preferredImportMethod: user.preferred_import_method || 'manual',
  };
}

// ── Routes ────────────────────────────────────────────────────────────────────

router.get('/auth/google', (req, res, next) => {
  if (!process.env.GOOGLE_OAUTH_CLIENT_ID) {
    return res.status(503).json({
      error: 'Google OAuth not configured',
      hint:  'Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET in .env',
    });
  }
  passport.authenticate('google', { scope: ['profile', 'email'] })(req, res, next);
});

router.get('/auth/google/callback',
  passport.authenticate('google', { session: false, failureRedirect: '/?auth_error=1' }),
  (req, res) => {
    try {
      const token = issueJWT(req.user);
      const frontendBase = process.env.FRONTEND_URL || '';
      // If FRONTEND_URL is same origin as backend (localhost:3000), use relative redirect
      const redirectBase = (frontendBase && frontendBase !== 'http://localhost:3000')
        ? frontendBase : '';
      res.redirect(`${redirectBase}/?token=${token}`);
    } catch (err) {
      console.error('[auth/callback]', err.message);
      res.redirect('/?auth_error=1');
    }
  }
);

router.get('/api/me', authenticateJWT, (req, res) => {
  const user = getDb().prepare('SELECT * FROM users WHERE id=?').get(req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(formatProfile(user));
});

router.put('/api/me/high-school-year', authenticateJWT, (req, res) => {
  const { highSchoolYear } = req.body;
  if (!highSchoolYear) return res.status(400).json({ error: 'highSchoolYear required' });
  getDb().prepare(`
    UPDATE users SET high_school_year=?, needs_high_school_year=0,
    updated_at=datetime('now') WHERE id=?
  `).run(String(highSchoolYear), req.userId);
  res.json({ success: true, highSchoolYear });
});

router.put('/api/user/import_method', authenticateJWT, (req, res) => {
  const { method } = req.body;
  if (!['pdf', 'manual'].includes(method))
    return res.status(400).json({ error: 'method must be "pdf" or "manual"' });
  getDb().prepare(`
    UPDATE users SET preferred_import_method=?, updated_at=datetime('now') WHERE id=?
  `).run(method, req.userId);
  res.json({ success: true, preferredImportMethod: method });
});

router.get('/auth/logout', (req, res) => {
  req.logout?.();
  res.json({ success: true });
});

module.exports = { router, passport };
