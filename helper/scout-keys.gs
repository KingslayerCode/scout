// Scout keys: swaps a Google sign-in code or a renewal key for a fresh hourly key.
// It exists because only this script knows the Client Secret (kept in Script Properties as CLIENT_SECRET), so the web page never has to.
const CLIENT_ID = '205279511864-5t1kng7vpjsk98oor9nuev8jksvckuk7.apps.googleusercontent.com';

function doGet() { return ContentService.createTextOutput('Scout keys is running.'); }

function doPost(e) {
  let b = {};
  try { b = JSON.parse(e.postData.contents); } catch (x) { return out_({ error: 'bad_request' }); }
  const form = { client_id: CLIENT_ID, client_secret: PropertiesService.getScriptProperties().getProperty('CLIENT_SECRET') };
  if (typeof b.code === 'string') { form.grant_type = 'authorization_code'; form.code = b.code; form.redirect_uri = 'postmessage'; }
  else if (typeof b.refresh_token === 'string') { form.grant_type = 'refresh_token'; form.refresh_token = b.refresh_token; }
  else return out_({ error: 'bad_request' });
  let j;
  try { j = JSON.parse(UrlFetchApp.fetch('https://oauth2.googleapis.com/token', { method: 'post', payload: form, muteHttpExceptions: true }).getContentText()); }
  catch (x) { return out_({ error: 'bad_response' }); }
  return out_({ access_token: j.access_token, refresh_token: j.refresh_token, expires_in: j.expires_in, error: j.error, error_description: j.error_description });
}

function out_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
