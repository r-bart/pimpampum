import QtQuick

ManagedFolderService {
  id: root

  subject: "backup"
  directoryUnavailableMessage: "Backup directory is unavailable"
  openFailureMessage: "Could not open the backup directory"
  operationFailedMessage: "Automatic backup operation failed"
  operationFailureMessages: ({
    "status": "Could not read automatic backup settings",
    "configure": "Could not configure that backup directory",
    "retry": "Could not refresh the backup",
    "disable": "Could not disable automatic backup"
  })
  property string snapshotPath: ""
  property string backupState: "disabled"
  property string lastAttemptAt: ""
  property string lastSuccessAt: ""

  function isNullableTimestamp(value) {
    return value === null || (typeof value === "string" && !isNaN(Date.parse(value)))
  }

  function validateStatus(value) {
    if (!isObject(value) || typeof value.enabled !== "boolean") return false
    if (vocabulary.backupStates.indexOf(value.state) === -1) return false
    if (value.directory !== null && !isAbsolutePath(value.directory)) return false
    if (value.snapshotPath !== null && !isAbsolutePath(value.snapshotPath)) return false
    if (!isNullableTimestamp(value.lastAttemptAt) || !isNullableTimestamp(value.lastSuccessAt)) return false
    if (value.error !== null && (typeof value.error !== "string" || value.error.length === 0
        || value.error.length > 500)) return false
    if (value.enabled !== (value.directory !== null)) return false
    if (value.enabled) return value.state !== "disabled" && isAbsolutePath(value.snapshotPath)
    if (value.snapshotPath !== null) return false
    // Off with nothing, or `error` with a message and no destination: the daemon could not read
    // its settings file (M-C6) and the card shows the reason under "Backup needs attention".
    if (value.state === "disabled") return value.error === null
    return value.state === "error" && value.error !== null
  }

  function applyStatus(value) {
    snapshotPath = value.snapshotPath || ""
    backupState = value.state
    lastAttemptAt = value.lastAttemptAt || ""
    lastSuccessAt = value.lastSuccessAt || ""
  }

  function retry() {
    run("retry", "")
  }

  function disable() {
    run("disable", "")
  }

  StateVocabulary { id: vocabulary }
}
