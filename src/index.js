require('dotenv').config();
const express  = require('express');
const session  = require('express-session');
const cors     = require('cors');

const { router: authRouter, passport } = require('./routes/auth');
const gpaRouter    = require('./routes/gpa');
const rcRouter     = require('./routes/reportCards');
const { router: courseRouter } = require('./routes/courses');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: process.env.CORS_ORIGIN || true, credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret:            process.env.SESSION_SECRET || 'dev_session_secret',
  resave:            false,
  saveUninitialized: false,
  cookie:            { secure: process.env.NODE_ENV === 'production', httpOnly: true },
}));
app.use(passport.initialize());
app.use(passport.session());

app.use(authRouter);
app.use(gpaRouter);
app.use(rcRouter);
app.use(courseRouter);

app.get('/health', (req, res) => res.json({ status: 'ok', school: 'csw', version: '2.0' }));

app.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE')
    return res.status(413).json({ error: `Max PDF size: ${process.env.MAX_PDF_SIZE_MB || 10}MB` });
  console.error('[error]', err.message);
  res.status(500).json({ error: err.message });
});

app.listen(PORT, () => console.log(`[atlas-gpa] http://localhost:${PORT}`));
module.exports = app;
