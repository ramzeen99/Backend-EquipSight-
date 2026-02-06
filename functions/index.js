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

      if (before.statut !== "reservee" && after.statut === "reservee") {
        await sendPushToUser(
            after.reservedByUid,
            "⏳ Машина забронирована",
            "Ваша бронь активна",
        );
      }

      if (
        before.statut !== "occupe" &&
        after.statut === "occupe" &&
        after.endTime
      ) {
        const endTime = after.endTime.toDate();
        const userId = after.utilisateurActuelUid;

        const notifications = [
          // eslint-disable-next-line max-len
          {type: "REMINDER_5_MIN", sendAt: new Date(endTime.getTime() - 5 * 60000)},
          // eslint-disable-next-line max-len
          {type: "REMINDER_2_MIN", sendAt: new Date(endTime.getTime() - 2 * 60000)},
          {type: "END", sendAt: endTime},
          {type: "AGGRESSIVE", sendAt: new Date(endTime.getTime() + 30 * 1000)},
          // eslint-disable-next-line max-len
          {type: "AUTO_RELEASE", sendAt: new Date(endTime.getTime() + 60 * 1000)},
        ];

        for (const n of notifications) {
          await admin.firestore().collection("scheduled_notifications").add({
            ...event.params,
            machineId: event.params.machineId,
            userId,
            type: n.type,
            sendAt: n.sendAt,
            status: "pending",
          });
        }
      }
    },
);

exports.onScheduledNotificationCreated =
onDocumentCreated("scheduled_notifications/{notifId}", async (event) => {
  const data = event.data.data();
  if (!data) return;
  const now = new Date();
  const sendAt = data.sendAt.toDate();
  const delay = sendAt - now;

  if (delay <= 0) {
    // envoyer la notification maintenant
    await sendPushToUser(data.userId, getTitle(data.type), getBody(data.type));

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
    case "END": return "⛔ Время вышло";
    case "AGGRESSIVE": return "⚠️ Внимание";
    case "AUTO_RELEASE":
      return "🔓 Машина освобождена автоматически";
  }
}

// eslint-disable-next-line require-jsdoc
function getBody(type) {
  switch (type) {
    case "REMINDER_5_MIN":
      return "До окончания цикла осталось 5 минут";
    case "REMINDER_2_MIN":
      return "До окончания цикла осталось 2 минуты";
    case "END":
      return "Цикл завершён. Пожалуйста, освободите машину";
    case "AGGRESSIVE":
      // eslint-disable-next-line max-len
      return "Машина будет автоматически освобождена через 30 секунд для других пользователей";
    case "AUTO_RELEASE":
      // eslint-disable-next-line max-len
      return "Машина была освобождена и теперь доступна для других пользователей";
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

      await sendPushToUser(
          data.userId,
          getTitle(data.type),
          getBody(data.type),
      );

      if (data.type === "AUTO_RELEASE") {
        const machineRef = admin.firestore().doc(
        // eslint-disable-next-line max-len
            `countries/${data.countryId}/cities/${data.cityId}/universities/${data.univId}/dorms/${data.dormId}/machines/${data.machineId}`,
        );

        await machineRef.update({
          statut: "libre",
          utilisateurActuel: null,
          startTime: null,
          endTime: null,
          lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
        });
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

