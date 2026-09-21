# UCC WhatsApp Attendance V8

Parser fix:
- Accepts harmless trailing punctuation such as `.`, `!`, `?`.
- Sender/fromMe is not used as a processing filter.
- Only configured group messages are processed.
