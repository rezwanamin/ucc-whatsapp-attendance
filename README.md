# UCC WhatsApp Attendance V6

Attendance processing rule:
- Process any message from the configured `Problem Group`, regardless of sender/fromMe.
- Ignore non-attendance text.
- Parse Entry/Left time and send valid attendance to Google Apps Script.

Important:
- Do not commit `.env` or `auth_info`.
- Existing QR/session behavior is unchanged in this version.
