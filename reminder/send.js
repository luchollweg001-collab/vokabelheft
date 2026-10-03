// Runs every hour (GitHub Actions). For each user with a reminder subscription:
// send a push if it is past their reminder hour, they haven't practised today
// and we haven't already reminded them today. TEST=true sends to everyone right away.
import admin from 'firebase-admin';
import webpush from 'web-push';

const { FIREBASE_SERVICE_ACCOUNT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY } = process.env;
const TEST = process.env.TEST === 'true';

if (!FIREBASE_SERVICE_ACCOUNT || !VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
  console.log('Secrets fehlen noch (FIREBASE_SERVICE_ACCOUNT / VAPID_*). Nichts zu tun.');
  process.exit(0);
}

admin.initializeApp({ credential: admin.credential.cert(JSON.parse(FIREBASE_SERVICE_ACCOUNT)) });
const db = admin.firestore();
webpush.setVapidDetails('https://luchollweg001-collab.github.io/vokabelheft/', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

const localDate = (tz, d) => d.toLocaleDateString('sv-SE', { timeZone: tz });
const localHour = (tz, d) => Number(d.toLocaleString('en-US', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }));

const now = new Date();
const snap = await db.collectionGroup('settings').get();
let sent = 0, checked = 0;

for (const d of snap.docs) {
  if (d.id !== 'reminder') continue;
  const r = d.data();
  const subs = Object.entries(r.subs || {});
  if (!subs.length) continue;
  checked++;
  const tz = r.tz || 'Europe/Berlin';
  const today = localDate(tz, now);
  const due = TEST || (localHour(tz, now) >= (r.hour ?? 21) && r.lastPracticed !== today && r.lastSent !== today);
  if (!due) continue;

  const userRef = d.ref.parent.parent;
  const open = (await userRef.collection('words').where('mastered', '==', false).count().get()).data().count;
  const payload = JSON.stringify({
    title: '¡Hola! 📚 Zeit für Vokabeln',
    body: open
      ? `Du hast heute noch nicht geübt – ${open} Wort${open === 1 ? '' : 'e'} ${open === 1 ? 'wartet' : 'warten'} auf dich.`
      : 'Du hast heute noch nicht geübt. Trag ein paar neue Wörter ein!',
    url: './?practice'
  });

  const update = {};
  for (const [key, sub] of subs) {
    try {
      await webpush.sendNotification(sub, payload, { TTL: 3 * 3600 });
      sent++;
    } catch (err) {
      console.log(`Push an Gerät ${key} fehlgeschlagen: ${err.statusCode} ${err.body || err.message}`);
      // Subscription expired or the app was removed from the home screen
      if (err.statusCode === 404 || err.statusCode === 410) update[`subs.${key}`] = admin.firestore.FieldValue.delete();
    }
  }
  if (!TEST) update.lastSent = today;
  if (Object.keys(update).length) await d.ref.update(update);
}

console.log(`${checked} Nutzer mit Erinnerung geprüft, ${sent} Mitteilung(en) gesendet${TEST ? ' (Test)' : ''}.`);
