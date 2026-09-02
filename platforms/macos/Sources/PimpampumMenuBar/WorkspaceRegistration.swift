import Foundation

/// One `pimpampum workspace:add <workspace-id> <name> <root-path>` invocation, built from the folder
/// the user chose. The identifier follows the CLI's `slugSchema` (lowercase kebab-case, at most 80
/// characters) and the name its 120-character bound, so a rejection can only come from the daemon.
struct WorkspaceRegistrationRequest: Equatable, Sendable {
  static let maximumIdentifierLength = 80
  static let maximumNameLength = 120

  let id: String
  let name: String
  let rootPath: String

  var arguments: [String] { ["workspace:add", id, name, rootPath] }

  /// Nil when the folder cannot become a workspace: a relative path, the filesystem root, or a
  /// name with no letter or digit to derive an identifier from. A file URL's path never carries a
  /// NUL byte, so that check belongs to the decoder of the CLI's answer, not here.
  static func forFolder(_ folder: URL) -> WorkspaceRegistrationRequest? {
    let url = folder.standardizedFileURL
    let path = url.path
    guard NSString(string: path).isAbsolutePath, path != "/" else { return nil }
    let name = boundedName(url.lastPathComponent)
    guard let id = identifier(from: name) else { return nil }
    return WorkspaceRegistrationRequest(id: id, name: name, rootPath: path)
  }

  /// The folder name with control characters removed, trimmed, and cut to the CLI's bound.
  static func boundedName(_ raw: String) -> String {
    let visible = raw.components(separatedBy: .controlCharacters).joined()
      .trimmingCharacters(in: .whitespacesAndNewlines)
    return String(visible.prefix(maximumNameLength))
  }

  /// Lowercase ASCII letters and digits, runs of anything else collapsed to one hyphen, no hyphen
  /// at either end, at most 80 characters. Diacritics are folded first so "Señor" becomes "senor"
  /// rather than "se-or".
  static func identifier(from name: String) -> String? {
    let folded = name.folding(
      options: [.diacriticInsensitive, .caseInsensitive, .widthInsensitive],
      locale: nil
    ).lowercased()
    var result = ""
    var separatorPending = false
    for scalar in folded.unicodeScalars {
      let isLetter = scalar >= "a" && scalar <= "z"
      let isDigit = scalar >= "0" && scalar <= "9"
      guard isLetter || isDigit else {
        separatorPending = true
        continue
      }
      if separatorPending, !result.isEmpty {
        guard result.count + 2 <= maximumIdentifierLength else { break }
        result.append("-")
      } else {
        guard result.count + 1 <= maximumIdentifierLength else { break }
      }
      separatorPending = false
      result.unicodeScalars.append(scalar)
    }
    return result.isEmpty ? nil : result
  }
}

/// What the daemon answered: the workspace as registered.
struct RegisteredWorkspace: Equatable, Sendable {
  let id: String
  let name: String
  let rootPath: String
}

/// `workspace:add` prints one indented `{ "data": { id, name, rootPath, … } }` envelope. A bare
/// object is accepted too, so the app survives a CLI that drops the envelope.
enum WorkspaceRegistrationDecoder {
  static let maximumBytes = 65_536
  static let maximumPathLength = 4_096

  static func decode(_ data: Data) throws -> RegisteredWorkspace {
    guard !data.isEmpty else { throw SetupClientError.invalidResponse }
    guard data.count <= maximumBytes else { throw SetupClientError.responseTooLarge }
    guard let object = try? JSONSerialization.jsonObject(with: data),
      let dictionary = object as? [String: Any]
    else { throw SetupClientError.invalidResponse }
    let payload = (dictionary["data"] as? [String: Any]) ?? dictionary
    guard let id = payload["id"] as? String,
      let name = payload["name"] as? String,
      let rootPath = payload["rootPath"] as? String,
      bounded(id, maximum: WorkspaceRegistrationRequest.maximumIdentifierLength),
      bounded(name, maximum: WorkspaceRegistrationRequest.maximumNameLength),
      bounded(rootPath, maximum: maximumPathLength),
      NSString(string: rootPath).isAbsolutePath
    else { throw SetupClientError.invalidResponse }
    return RegisteredWorkspace(id: id, name: name, rootPath: rootPath)
  }

  private static func bounded(_ value: String, maximum: Int) -> Bool {
    !value.isEmpty && value.count <= maximum && !value.contains("\0")
  }
}

/// The registration as the two surfaces show it: the last step of the guided setup and the empty
/// overview. One state, because the same session drives both.
enum WorkspaceRegistrationState: Equatable, Sendable {
  case idle
  case registering(folderName: String)
  case registered(RegisteredWorkspace)
  case failed(String)

  var isRegistering: Bool {
    if case .registering = self { return true }
    return false
  }

  /// Nil while idle; otherwise the one row the surfaces render under the button.
  var notice: WorkspaceRegistrationNotice? {
    switch self {
    case .idle:
      return nil
    case .registering(let folderName):
      return WorkspaceRegistrationNotice(
        symbol: "folder.badge.plus",
        text: WorkspaceRegistrationCopy.registering(folderName: folderName),
        inProgress: true,
        isFailure: false
      )
    case .registered(let workspace):
      return WorkspaceRegistrationNotice(
        symbol: "checkmark.circle",
        text: WorkspaceRegistrationCopy.registered(workspace),
        inProgress: false,
        isFailure: false
      )
    case .failed(let message):
      return WorkspaceRegistrationNotice(
        symbol: "exclamationmark.triangle",
        text: WorkspaceRegistrationCopy.failed(message),
        inProgress: false,
        isFailure: true
      )
    }
  }
}

struct WorkspaceRegistrationNotice: Equatable, Sendable {
  let symbol: String
  let text: String
  let inProgress: Bool
  let isFailure: Bool
}

/// Copy for the workspace action, frozen here so neither SwiftUI body decides a word of it.
enum WorkspaceRegistrationCopy {
  static let button = "Add a workspace"
  static let buttonAccessibilityLabel = "Add a folder as a workspace"
  static let onboardingDetail =
    "Pick a folder your agents work in. Pimpampum tracks the projects they create there."
  static let emptyWorkspacesDetail = "Add a folder as a workspace to start tracking projects."
  static let emptyProjectsDetail = "Projects appear here as your agents create them."
  static let folderRejected = "Choose a folder whose name contains a letter or a digit."

  static func registering(folderName: String) -> String {
    "Adding “\(folderName)”…"
  }

  static func registered(_ workspace: RegisteredWorkspace) -> String {
    "Workspace “\(workspace.name)” added."
  }

  static func failed(_ message: String) -> String {
    "Could not add the workspace. \(message)"
  }
}
