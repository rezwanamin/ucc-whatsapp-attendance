const SHEET_NAME = 'Attendance Logs';
const SUMMARY_SHEET = 'Daily Summary';
const ERROR_SHEET = 'Errors';
const TZ = 'Asia/Dhaka';

function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  const logs = getOrCreate_(ss, SHEET_NAME);
  const summary = getOrCreate_(ss, SUMMARY_SHEET);
  const errors = getOrCreate_(ss, ERROR_SHEET);

  logs.clear();
  logs.appendRow([
    'ID','Date','Name','Type','Time','Raw Message','Status',
    'Received At','Message ID','Sender JID','Group'
  ]);

  summary.clear();
  summary.appendRow([
    'Date','Name','Sessions','Total Minutes','Total Hours','Current Status'
  ]);

  errors.clear();
  errors.appendRow([
    'Date','Name','Type','Time','Reason','Raw Message','Received At'
  ]);
}

function doGet() {
  return ContentService.createTextOutput(
    JSON.stringify({ok:true, service:'WhatsApp Attendance'})
  ).setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    if (data.event !== 'attendance') throw new Error('Unsupported event');

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const logs = getOrCreate_(ss, SHEET_NAME);
    const errors = getOrCreate_(ss, ERROR_SHEET);

    const date = Utilities.formatDate(
      new Date(data.receivedAt),
      TZ,
      'yyyy-MM-dd'
    );

    const time = data.time; // HH:mm
    const name = data.name;

    const rows = logs.getDataRange().getValues();
    const prior = rows.slice(1).filter(r =>
      String(r[1]) === date &&
      String(r[2]).toLowerCase() === name.toLowerCase() &&
      String(r[6]) !== 'ERROR'
    );

    let status = 'OK';
    const last = prior.length ? prior[prior.length - 1] : null;

    if (data.type === 'ENTRY' && last && String(last[3]) === 'ENTRY') {
      status = 'REVIEW: ENTRY while already inside';
    }

    if (data.type === 'LEFT' && (!last || String(last[3]) !== 'ENTRY')) {
      status = 'REVIEW: LEFT without active ENTRY';
    }

    logs.appendRow([
      Utilities.getUuid(),
      date,
      name,
      data.type,
      time,
      data.rawMessage,
      status,
      data.receivedAt,
      data.messageId || '',
      data.senderJid || '',
      data.groupName || ''
    ]);

    if (status !== 'OK') {
      errors.appendRow([
        date, name, data.type, time, status,
        data.rawMessage, data.receivedAt
      ]);
    }

    rebuildSummary_(ss);
    return json_({ok:true, status});
  } catch (err) {
    return json_({ok:false, error:String(err)});
  }
}

function rebuildSummary_(ss) {
  const logs = ss.getSheetByName(SHEET_NAME);
  const summary = ss.getSheetByName(SUMMARY_SHEET);
  if (!logs || !summary) return;

  const values = logs.getDataRange().getValues();
  const map = {};

  values.slice(1).forEach(r => {
    if (!r[1] || !r[2] || r[6] !== 'OK') return;

    const key = `${r[1]}||${String(r[2]).toLowerCase()}`;
    if (!map[key]) map[key] = {date:r[1], name:r[2], sessions:[], open:false};

    const obj = map[key];
    const minutes = toMinutes_(r[4]);

    if (r[3] === 'ENTRY') {
      obj.sessions.push({in:minutes, out:null});
      obj.open = true;
    } else if (r[3] === 'LEFT') {
      for (let i=obj.sessions.length-1; i>=0; i--) {
        if (obj.sessions[i].out === null) {
          obj.sessions[i].out = minutes;
          obj.open = false;
          break;
        }
      }
    }
  });

  const output = [['Date','Name','Sessions','Total Minutes','Total Hours','Current Status']];

  Object.values(map).forEach(o => {
    let total = 0, closed = 0, open = false;
    o.sessions.forEach(s => {
      if (s.in != null && s.out != null) {
        let diff = s.out - s.in;
        if (diff < 0) diff += 1440;
        total += diff;
        closed++;
      } else if (s.in != null && s.out === null) {
        open = true;
      }
    });

    output.push([
      o.date, o.name, closed + (open ? 1 : 0),
      total, `${Math.floor(total/60)}h ${total%60}m`,
      open ? 'ACTIVE' : 'LEFT'
    ]);
  });

  summary.clearContents();
  summary.getRange(1,1,output.length,output[0].length).setValues(output);
}

function toMinutes_(hhmm) {
  const p = String(hhmm).split(':');
  return Number(p[0])*60 + Number(p[1]);
}

function getOrCreate_(ss, name) {
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
