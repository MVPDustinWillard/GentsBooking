// Gents Barber Shop — notification config
// Set enabled: true and fill in real credentials to activate each channel.

module.exports = {
  // ── Email (nodemailer / Gmail SMTP) ────────────────────────────────────────
  enabled: false,
  from: '"Gents Barber Shop" <noreply@gentsbarbershop.com>',
  smtp: {
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    auth: {
      user: 'your-email@gmail.com',
      pass: 'your-app-password',  // Gmail App Password (not your regular password)
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
