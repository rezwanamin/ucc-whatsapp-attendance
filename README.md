# WhatsApp Group Attendance — Problem Group

This project monitors one WhatsApp group and sends matching attendance messages to a Google Sheet.

## Supported messages

- `Ratna Entry Time 10.12am`
- `Ratna Entry 10:12 AM`
- `Ratna Left time 6.30pm`
- `Ratna Left 6:30 PM`

It supports unlimited ENTRY/LEFT sessions per person per day.

## Important

This uses WhatsApp Web automation through Baileys, not the official WhatsApp Business API. It should be treated as an unofficial integration and can be affected by WhatsApp changes or account restrictions. Use an account you are comfortable dedicating to this automation.

## Part 1 — Google Sheet

1. Create a blank Google Sheet.
2. Extensions → Apps Script.
3. Replace the default code with `google_apps_script/Code.gs`.
4. Save.
5. Run `setup()` once and authorize it.
6. Deploy → New deployment → Web app.
7. Execute as: Me.
8. Who has access: Anyone.
9. Copy the `/exec` URL.

Put that URL into `.env` as `GOOGLE_APPS_SCRIPT_URL`.

## Part 2 — Oracle Cloud Always Free VM

Recommended target: Ubuntu on OCI Ampere A1, 1–2 OCPU and 6–12 GB RAM, Always Free eligible.

Install Node.js 20+ and Git, then:

    git clone <your-project>
    cd whatsapp-attendance
    npm install
    cp .env.example .env
    nano .env
    npm start

On first run, a QR appears in the terminal. On the dedicated WhatsApp account:
WhatsApp → Linked devices → Link a device → scan the QR.

The `auth_info/` folder contains the WhatsApp session. Back it up securely and do not publish it.

## Part 3 — Keep it running

Use systemd or PM2. Example with PM2:

    sudo npm install -g pm2
    pm2 start src/index.js --name whatsapp-attendance
    pm2 save
    pm2 startup

Then run the exact command PM2 prints.

## Target group

Problem Group

## Data flow

WhatsApp → Baileys listener → parser → Google Apps Script webhook → Google Sheets.

## Recommended sheet tabs

- Attendance Logs
- Daily Summary
- Errors

The Daily Summary calculates total closed-session minutes and shows ACTIVE when the latest session has an ENTRY without a matching LEFT.
