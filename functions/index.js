const {onDocumentUpdated} = require("firebase-functions/v2/firestore");
const {setGlobalOptions} = require("firebase-functions/v2");
const {onDocumentCreated} = require("firebase-functions/v2/firestore");
const {onRequest} = require("firebase-functions/v2/https");
const admin = require("firebase-admin");

admin.initializeApp();
setGlobalOptions({maxInstances: 10});

exports.onMachineUpdate = onDocumentUpdated(
    // eslint-disable-next-line max-len
    "countries/{countryId}/cities/{cityId}/universities/{univId}/dorms/{dormId}/machines/{machineId}",
    async (event) => {
      const before = event.data.before.data();
      const after = event.data.after.data();
      const machineId = event.params.machineId;
      const dormId = event.params.dormId;
      const userId = after.reservedByUid;

      if (before.statut !== "reservee" && after.statut === "reservee") {
        const reservationStart = new Date();
        const reservationEnd = new Date(reservationStart.getTime() + 5*60000);

        const notifications = [
          {type: "REMINDER_5_MIN",
            sendAt: new Date(reservationEnd.getTime() - 5*60000)},
          {type: "REMINDER_2_MIN",
            sendAt: new Date(reservationEnd.getTime() - 2*60000)},
          {type: "END",
            sendAt: new Date(reservationEnd.getTime())},
          {type: "AGGRESSIVE",
            sendAt: new Date(reservationEnd.getTime() + 30*1000)},
        ];

        for (const n of notifications) {
          await admin.firestore().collection("scheduled_notifications").add({
            machineId,
            dormId,
            countryId: event.params.countryId,
            cityId: event.params.cityId,
            univId: event.params.univId,
            userId,
            type: n.type,
            sendAt: n.sendAt,
            status: "pending",
          });
        }

        await sendPushToUser(
            after.reservedByUid,
            "⏳ Машина забронирована",
            "Ваша бронь активна",
        );
      }
    },
);

// eslint-disable-next-line require-jsdoc
async function sendPush(userId, title, body) {
  const tokensSnap = await admin
      .firestore()
      .collection("users")
      .doc(userId)
      .collection("fcmTokens")
      .get();

  if (tokensSnap.empty) return;
  const tokens = tokensSnap.docs.map((doc) => doc.id);

  await admin.messaging().sendEachForMulticast({
    tokens,
    notification: {title, body},
  });
}

exports.onScheduledNotificationCreated =
onDocumentCreated("scheduled_notifications/{notifId}", async (event) => {
  const data = event.data.data();
  if (!data) return;
  const now = new Date();
  const sendAt = data.sendAt.toDate();
  const delay = sendAt - now;

  if (delay <= 0) {
    // envoyer la notification maintenant
    await sendPush(data.userId, getTitle(data.type), getBody(data.type));

    // marquer la notification comme envoyée ou supprimer
    await admin.firestore().collection("scheduled_notifications")
        .doc(event.params.notifId).delete();
  } else {
    const {CloudTasksClient} = require("@google-cloud/tasks");
    const tasksClient = new CloudTasksClient();

    if (delay > 0) {
      const project = process.env.GCLOUD_PROJECT;
      const location = "us-central1";
      const queue = "scheduled-notifications";
      const url = `https://us-central1-${project}.cloudfunctions.net/handleScheduledTask`;
      const payload = {
        action: "SEND_NOTIFICATION",
        notifId: event.params.notifId,
      };

      const task = {
        httpRequest: {
          httpMethod: "POST",
          url,
          headers: {"Content-Type": "application/json"},
          body: Buffer.from(JSON.stringify(payload)).toString("base64"),
        },
        scheduleTime: {seconds: Math.floor(sendAt.getTime() / 1000)},
      };
      await tasksClient.createTask({
        parent: tasksClient.queuePath(project, location, queue),
        task,
      });
    }
  }
});

// eslint-disable-next-line require-jsdoc
function getTitle(type) {
  switch (type) {
    case "REMINDER_5_MIN": return "⏳ Осталось 5 минут";
    case "REMINDER_2_MIN": return "⏳ Осталось 2 минуты";
    case "END": return "✅ Время вышло";
  }
}

// eslint-disable-next-line require-jsdoc
function getBody(type) {
  switch (type) {
    case "REMINDER_5_MIN": return "До окончания работы машины осталось 5 минут";
    case "REMINDER_2_MIN":
      return "До окончания работы машины осталось 2 минуты";
    case "END": return "Машина теперь свободна";
  }
}

exports.handleScheduledTask = onRequest(
    {region: "us-central1"},
    async (req, res) => {
      const {notifId} = req.body;
      if (!notifId) return res.status(400).send("Missing notifId");

      const notifRef = admin.firestore()
          .collection("scheduled_notifications")
          .doc(notifId);

      const notifSnap = await notifRef.get();
      if (!notifSnap.exists) {
        return res.status(404).send("Notification not found");
      }

      const data = notifSnap.data();

      await sendPush(
          data.userId,
          getTitle(data.type),
          getBody(data.type),
      );

      if (data.type === "END" || data.type === "AGGRESSIVE") {
        const machineRef = admin.firestore().doc(
            `countries/${data.countryId}/cities/${data.cityId}
            /universities/${data.univId}/dorms/${data.dormId}
            /machines/${data.machineId}`,
        );

        const machineSnap = await machineRef.get();
        const machine = machineSnap.data();

        if (machine && machine.statut !== "libre") {
          await machineRef.update({
            statut: "libre",
            reservedByUid: null,
            reservedByName: null,
            reservationEndTime: null,
            lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
          });
        }
      }

      await notifRef.delete();
      return res.status(200).send("Task executed");
    },
);

// eslint-disable-next-line require-jsdoc
async function sendPushToUser(userId, title, body) {
  const tokensSnap = await admin
      .firestore()
      .collection("users")
      .doc(userId)
      .collection("fcmTokens")
      .get();

  if (tokensSnap.empty) return;

  const tokens = tokensSnap.docs.map((doc) => doc.id);

  await admin.messaging().sendEachForMulticast({
    tokens,
    notification: {
      title,
      body,
    },
  }); 
}

