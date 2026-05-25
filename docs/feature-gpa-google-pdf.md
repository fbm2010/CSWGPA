# ATLAS GPA Backend — Feature Guide

## Setup

```bash
cp .env.example .env
# Fill in GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET
npm run setup     # installs deps + runs DB migrations
npm start         # starts server on PORT (default 3000)
npm test          # runs all unit tests
```

## Google OAuth Setup
1. Go to https://console.cloud.google.com → APIs & Services → Credentials
2. Create OAuth 2.0 Client ID (Web Application)
3. Add authorized redirect URI: `http://localhost:3000/auth/google/callback`
4. Copy Client ID and Secret into `.env`

## Schoology PDF Format (CSW-specific)

The parser handles the exact Schoology grade export format from csw.schoology.com:

| PDF Pattern | Example | Parser Output |
|---|---|---|
| Phase-prefixed header | `5-BIOLOGY : 7205 2 5-BIOLOGY PD D` | phase=5, name=Biology, courseId=7205 |
| Non-phased header | `DRIVER ED : DRIVER ED - B MP3` | phase=null, excluded=true |
| Course Grade row | `Course Grade 92%` | grade=92 (GPA-relevant) |
| N/A grade | `Course Grade N/A` | excluded from GPA |
| School year | `M1: 2025-08-25 - 2025-10-24` | schoolYear=2025-2026 |

**Only the `Course Grade` row is used for GPA — not individual marking period grades.**

## GPA Rules

- CSW grading scale: no A+, no D+/D-
- Phase 3: +0.00 | Phase 4: +0.25 | Phase 5: +0.50 | AP/Phase 6: +1.00
- **Excluded from GPA:** Driver Education, Drug & Alcohol, Homeroom, Study Hall
- Add more via `EXCLUDE_COURSES` env var (comma-separated)

## Key Endpoints

```bash
# Health
curl http://localhost:3000/health

# Google login (open in browser)
open http://localhost:3000/auth/google

# Get user profile (frontend reads needsHighSchoolYear)
curl -H "Authorization: Bearer TOKEN" http://localhost:3000/api/me

# Set high school year (clears the popup flag)
curl -X PUT http://localhost:3000/api/me/high-school-year \
  -H "Authorization: Bearer TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"highSchoolYear": "Sophomore"}'

# Upload Schoology PDF
curl -X POST http://localhost:3000/api/reportcards/upload \
  -H "Authorization: Bearer TOKEN" \
  -F "pdf=@report_card.pdf"

# Calculate GPA (school years format)
curl -X POST http://localhost:3000/api/gpa/calculate \
  -H "Content-Type: application/json" \
  -d '{
    "schoolYears": [{
      "year": "2025-2026",
      "courses": [
        {"name":"Biology","grade":"93","credits":1.0,"phase":"5"},
        {"name":"AP Computer Science Principles","grade":"99","credits":1.0,"phase":"6"},
        {"name":"Driver Ed","grade":"84","credits":0.25,"phase":null}
      ]
    }]
  }'

# Course autocomplete
curl "http://localhost:3000/api/courses/autocomplete?q=biology&limit=5"
```

## Frontend Integration (no UI changes needed)

`/api/me` returns `needsHighSchoolYear: true` after first Google login.
The existing frontend detects this flag and shows a "What year are you?"
popup. After the user answers, frontend calls:
`PUT /api/me/high-school-year` with `{ highSchoolYear: "Sophomore" }`
The flag is permanently cleared.
