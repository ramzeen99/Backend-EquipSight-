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

      if (before.statut !== "occupe" && after.statut === "occupe") {
        console.log("🚀 Cycle machine démarré :", after);

        await scheduleCycleNotifications(after, event.params);
      }
    },
);

exports.handleScheduledTask = async (payload) => {
  if (payload.action !== "FORCE_RELEASE") return;

  // eslint-disable-next-line max-len
  const machineRef = admin.firestore().doc(`countries/${payload.countryId}/cities/${payload.cityId}/universities/${payload.univId}/dorms/${payload.dormId}/machines/${payload.machineId}`);

  await machineRef.update({
    statut: "libre",
    utilisateurActuel: null,
    startTime: null,
    endTime: null,
    reservedByName: null,
    reservationEndTime: null,
    lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
  });

  await sendPush(
      "✅ Машина освобождена",
      "Машина теперь доступна для других пользователей",
  );
};

/**
 * Programme les notifications liées à une réservation de machine
 * @param {Object} machine Données de la machine
 * @param {Object} params Contexte Firestore
 */
async function scheduleCycleNotifications(machine, params) {
  if (!machine.endTime) return;

  const end = machine.endTime.toDate().getTime();

  await schedulePush(end - 5 * 60 * 1000, "⏳ Осталось 5 минут");
  await schedulePush(end - 2 * 60 * 1000, "⚠️ Осталось 2 минуты");
  await schedulePush(end, "⏱️ Время истекло");

  await schedulePush(
      end + 30 * 1000,
      // eslint-disable-next-line max-len
      "⚠️ Машина будет автоматически освобождена через 30 секунд для других пользователей",
  );

  await scheduleTask(end + 60 * 1000, {
    action: "FORCE_RELEASE",
    dormId: params.dormId,
    machineId: params.machineId,
    countryId: params.countryId,
    cityId: params.cityId,
    univId: params.univId,
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
