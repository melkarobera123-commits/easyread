const { onUserCreated } = require("firebase-functions/v2/auth");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();
const ADMIN_EMAIL = "melkarobera123@gmail.com";
const dayKey = () => new Date().toISOString().slice(0, 10);

exports.countRegisteredUsers = onUserCreated(async (event) => {
  const uid = event.data.uid;
  const createdAt = event.data.metadata?.creationTime || new Date().toISOString();
  await db.doc("privateMetrics/users/" + uid).set({ createdAt, counted: true }, { merge: true });
  await db.doc("privateMetrics/summary").set({
    registeredUsers: admin.firestore.FieldValue.increment(1),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
});

exports.recordVisitor = onCall({ enforceAppCheck: true }, async (request) => {
  // A stable random client ID is used only to avoid repeatedly counting one browser
  // on the same day. It is not an account identifier.
  const visitorId = String(request.data?.visitorId || "");
  if (!/^[a-f0-9-]{32,64}$/i.test(visitorId)) {
    throw new HttpsError("invalid-argument", "A valid visitor session ID is required.");
  }
  const day = dayKey();
  const visitRef = db.doc("privateMetrics/visits/" + day + "_" + visitorId);
  const activeRef = request.auth ? db.doc("privateMetrics/active/" + day + "_" + request.auth.uid) : null;
  await db.runTransaction(async (tx) => {
    const visit = await tx.get(visitRef);
    if (!visit.exists) {
      tx.create(visitRef, { day, createdAt: admin.firestore.FieldValue.serverTimestamp() });
      tx.set(db.doc("privateMetrics/daily/" + day), {
        visitors: admin.firestore.FieldValue.increment(1),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    }
    if (activeRef) {
      const active = await tx.get(activeRef);
      if (!active.exists) {
        tx.create(activeRef, { day, uid: request.auth.uid, createdAt: admin.firestore.FieldValue.serverTimestamp() });
        tx.set(db.doc("privateMetrics/daily/" + day), {
          activeReaders: admin.firestore.FieldValue.increment(1),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
      }
    }
  });
  return { ok: true };
});

exports.getAdminMetrics = onCall({ enforceAppCheck: true }, async (request) => {
  if (!request.auth || String(request.auth.token.email || "").toLowerCase() !== ADMIN_EMAIL) {
    throw new HttpsError("permission-denied", "Administrator access only.");
  }
  const summary = await db.doc("privateMetrics/summary").get();
  const days = Array.from({ length: 30 }, (_, i) => {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() - i);
    return date.toISOString().slice(0, 10);
  });
  const dailyDocs = await Promise.all(days.map(day => db.doc("privateMetrics/daily/" + day).get()));
  const daily = dailyDocs.map((snap, i) => ({ date: days[i], ...(snap.exists ? snap.data() : { visitors: 0, activeReaders: 0 }) })).reverse();
  const totals = daily.reduce((acc, item) => ({
    visitors30d: acc.visitors30d + Number(item.visitors || 0),
    activeReaderDays30d: acc.activeReaderDays30d + Number(item.activeReaders || 0)
  }), { visitors30d: 0, activeReaderDays30d: 0 });
  return { registeredUsers: Number(summary.data()?.registeredUsers || 0), ...totals, daily };
});
