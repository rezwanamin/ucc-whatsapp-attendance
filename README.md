# UCC WhatsApp Attendance V4

Diagnostic version.

## Routes
- `/health` — service health
- `/status` — WhatsApp/group status
- `/debug` — diagnostic configuration/status
- `/qr?token=YOUR_QR_TOKEN` — secure QR page
- `/test-google?token=YOUR_QR_TOKEN` — sends one TEST USER attendance event to Google Apps Script

Do not commit `.env` or `auth_info`.
