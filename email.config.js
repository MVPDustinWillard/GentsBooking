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
  sms: {
    enabled: false,             // Set to true to send real SMS messages
    accountSid: 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    authToken:  'your_auth_token',
    fromNumber: '+1xxxxxxxxxx', // Your Twilio phone number (e.g. +16035550100)
  },
};
