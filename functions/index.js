const {onDocumentUpdated} = require("firebase-functions/v2/firestore");
const {setGlobalOptions} = require("firebase-functions/v2");
const {onDocumentCreated} = require("firebase-functions/v2/firestore");
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

        notifications.forEach(async (n) => {
          await admin.firestore().collection("scheduled_notifications").add({
            machineId,
            dormId,
            userId,
            type: n.type,
            sendAt: n.sendAt,
            status: "pending",
          });
        });


        await sendPushToUser(
            after.reservedByUid,
            "⏳ Machine réservée",
            "Votre réservation est active",
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

    if (data.type === "END") {
      // libérer machine si pas déjà libérée
      const machineRef = admin.firestore()
          .doc(`dorms/${data.dormId}/machines/${data.machineId}`);
      const machineSnap = await machineRef.get();
      const machine = machineSnap.data();
      if (machine && machine.statut !== "libre") {
        await machineRef.update({
          statut: "libre",
          reservedByUid: null,
          reservedByName: null,
          reservationEndTime: null,
        });
      }
    }

    // marquer la notification comme envoyée ou supprimer
    await admin.firestore().collection("scheduled_notifications")
        .doc(event.params.notifId).delete();
  } else {
    const {CloudTasksClient} = require("@google-cloud/tasks");
    const tasksClient = new CloudTasksClient();

    if (delay > 0) {
      const project = process.env.GCP_PROJECT;
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
    case "REMINDER_5_MIN": return "⏳ Plus que 5 minutes";
    case "REMINDER_2_MIN": return "⏳ Plus que 2 minutes";
    case "END": return "✅ Temps écoulé";
  }
}

// eslint-disable-next-line require-jsdoc
function getBody(type) {
  switch (type) {
    case "REMINDER_5_MIN": return "Votre machine se termine dans 5 minutes";
    case "REMINDER_2_MIN": return "Votre machine se termine dans 2 minutes";
    case "END": return "Votre machine est maintenant libre";
  }
}

exports.handleScheduledTask = async (payload) => {
  if (payload.action === "FORCE_RELEASE") {
    const machineRef = admin
        .firestore()
        .doc(`dorms/${payload.dormId}/machines/${payload.machineId}`);

    await machineRef.update({
      statut: "libre",
      reservedBy: null,
      reservationStart: null,
      reservationEndTime: null,
    });
  }
};

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

