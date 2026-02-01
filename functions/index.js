const {onDocumentUpdated} = require("firebase-functions/v2/firestore");
const {setGlobalOptions} = require("firebase-functions/v2");
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
        console.log("🔔 Nouvelle réservation détectée :", after);

        await scheduleReservationNotifications(after, event);
      }
    },
);

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

    await sendPush(
        "✅ Machine libérée",
        "La machine est maintenant disponible",
    );
  }
};

/**
 * Programme les notifications liées à une réservation de machine
 * @param {Object} machine Données de la machine
 * @param {Object} context Contexte Firestore
 */
async function scheduleReservationNotifications(machine, context) {
  const end = machine.reservationEndTime.toDate();

  // rappels
  await schedulePush(end - 5 * 60 * 1000, "⏳ 5 minutes restantes");
  await schedulePush(end - 2 * 60 * 1000, "⚠️ 2 minutes restantes");
  await schedulePush(end, "⏱️ Temps écoulé");

  // notification agressive
  await schedulePush(
      end + 30 * 1000,
      "⚠️ La machine sera libérée automatiquement dans 30 secondes",
  );

  // libération forcée
  await scheduleTask(end + 60 * 1000, {
    action: "FORCE_RELEASE",
    dormId: context.params.dormId,
    machineId: context.params.machineId,
  });
}

// eslint-disable-next-line require-jsdoc
async function sendPush(title, body) {
  console.log("📲 PUSH (simulé):", title, body);
}

// eslint-disable-next-line require-jsdoc
async function schedulePush(timestamp, message) {
  console.log(
      "⏰ Notification programmée pour",
      new Date(timestamp).toISOString(),
      message,
  );
}

// eslint-disable-next-line require-jsdoc
async function scheduleTask(timestamp, payload) {
  console.log(
      "🛠️ Task programmée pour",
      new Date(timestamp).toISOString(),
      payload,
  );
}
