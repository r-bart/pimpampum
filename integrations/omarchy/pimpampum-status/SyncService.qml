import QtQuick

ManagedFolderService {
  id: root

  subject: "synchronization"
  directoryUnavailableMessage: "Shared folder is unavailable"
  openFailureMessage: "Could not open the shared folder"
  operationFailedMessage: "Synchronization operation failed"
  property bool paused: false
  property string deviceId: ""
  property string syncState: "disabled"
  property string lastImportAt: ""
  property string lastExportAt: ""
  property int pendingCount: 0
  property int conflictCount: 0

  function validateStatus(value) {
    if (!isObject(value) || typeof value.enabled !== "boolean" || typeof value.paused !== "boolean") return false
    if (vocabulary.syncStates.indexOf(value.state) === -1) return false
    if (value.directory !== null && !isAbsolutePath(value.directory)) return false
    if (value.deviceId !== null && (typeof value.deviceId !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value.deviceId))) return false
    if (typeof value.pendingSnapshotCount !== "number" || typeof value.conflictCount !== "number") return false
    return value.enabled === (value.directory !== null)
  }

  function applyStatus(value) {
    paused = value.paused
    deviceId = value.deviceId || ""
    syncState = value.state
    lastImportAt = value.lastImportAt || ""
    lastExportAt = value.lastExportAt || ""
    pendingCount = value.pendingSnapshotCount
    conflictCount = value.conflictCount
  }

  function syncNow() {
    run("now", "")
  }

  function setPaused(value) {
    run(value ? "pause" : "resume", "")
  }

  function forget() {
    run("forget", "")
  }

  StateVocabulary { id: vocabulary }
}
