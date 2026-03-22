// Gents Barber Shop — notification config
// Credentials are read from environment variables (.env locally, Railway vars in production)

const gmailUser = process.env.GMAIL_USER || '';
const gmailPass = (process.env.GMAIL_PASS || '').trim();

module.exports = {
  // ── Email (nodemailer / Gmail SMTP) ────────────────────────────────────────
  // Enable automatically when GMAIL_USER and GMAIL_PASS env vars are set.
  // To get a Gmail App Password: Google Account → Security → 2-Step Verification → App Passwords
  enabled: !!(gmailUser && gmailPass),
  from: gmailUser ? `"Gents Barber Shop" <${gmailUser}>` : '"Gents Barber Shop" <noreply@gentsbarbershop.com>',
  smtp: {
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    family: 4,
    auth: {
      user: gmailUser,
      pass: gmailPass,
    },
  },

  // ── SMS (Twilio) ────────────────────────────────────────────────────────────
  // Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER in .env (local)
  // or as Railway environment variables for production.
  sms: {
    enabled: !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_FROM_NUMBER),
    accountSid: process.env.TWILIO_ACCOUNT_SID || '',
    authToken:  process.env.TWILIO_AUTH_TOKEN  || '',
    fromNumber: process.env.TWILIO_FROM_NUMBER || '',
  },
};
