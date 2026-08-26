import Foundation

// The production boundary is MainAppLoginItemService, backed by SMAppService.

enum LoginItemRegistrationState: String, Codable, Equatable, Sendable {
  case enabled
  case requiresApproval
  case error
}

struct LoginRegistrationRequest: Codable, Equatable, Sendable {
  let requestId: String
  let requestedAt: Date
  let expiresAt: Date
}

struct LoginRegistrationAcknowledgement: Codable, Equatable, Sendable {
  let requestId: String
  let createdAt: Date
  let status: LoginItemRegistrationState
  let registrationChanged: Bool
}

protocol LoginItemServicing {
  var state: LoginItemRegistrationState { get }
  func register() throws
  func unregister() async throws
}

protocol LoginRegistrationFileAccess {
  func read(_ url: URL) throws -> Data
  func writePrivate(_ data: Data, to url: URL) throws
}

struct LoginRegistrationCoordinator {
  static let requestFileName = "login-registration-request.json"
  static let acknowledgementFileName = "login-registration-acknowledgement.json"
  static let unregistrationAcknowledgementFileName =
    "login-unregistration-acknowledgement.json"

  let service: LoginItemServicing
  let files: LoginRegistrationFileAccess
  let now: () -> Date

  init(
    service: LoginItemServicing,
    files: LoginRegistrationFileAccess,
    now: @escaping () -> Date
  ) {
    self.service = service
    self.files = files
    self.now = now
  }

  func handle(arguments: [String], dataDirectory: URL) async -> Bool {
    if arguments == ["--unregister-login-item"] {
      await unregister(dataDirectory: dataDirectory)
      return true
    }
    guard arguments.count == 2, arguments[0] == "--register-login-item" else {
      return false
    }
    let requestId = arguments[1]
    let acknowledgementURL = dataDirectory.appendingPathComponent(Self.acknowledgementFileName)
    let status: LoginItemRegistrationState
    var registrationChanged = false
    do {
      let requestURL = dataDirectory.appendingPathComponent(Self.requestFileName)
      let request = try decoder().decode(
        LoginRegistrationRequest.self, from: files.read(requestURL))
      try validate(request: request, expectedId: requestId, currentDate: now())
      let initialState = service.state
      if initialState == .error {
        try service.register()
        registrationChanged = service.state != .error
      }
      status = service.state
    } catch {
      status = .error
      registrationChanged = false
    }

    let acknowledgement = LoginRegistrationAcknowledgement(
      requestId: requestId,
      createdAt: now(),
      status: status,
      registrationChanged: registrationChanged
    )
    if let data = try? encoder().encode(acknowledgement) {
      try? files.writePrivate(data, to: acknowledgementURL)
    }
    return true
  }

  private func unregister(dataDirectory: URL) async {
    let previousStatus = service.state
    let status: String
    do {
      if previousStatus != .error {
        try await service.unregister()
      }
      status = "disabled"
    } catch {
      status = "error"
    }
    let acknowledgement = LoginUnregistrationAcknowledgement(
      createdAt: now(),
      previousStatus: previousStatus,
      status: status
    )
    let acknowledgementURL = dataDirectory.appendingPathComponent(
      Self.unregistrationAcknowledgementFileName
    )
    if let data = try? encoder().encode(acknowledgement) {
      try? files.writePrivate(data, to: acknowledgementURL)
    }
  }

  private func validate(
    request: LoginRegistrationRequest,
    expectedId: String,
    currentDate: Date
  ) throws {
    guard UUID(uuidString: expectedId) != nil, request.requestId == expectedId else {
      throw LoginRegistrationError.invalidRequest
    }
    guard request.requestedAt <= request.expiresAt,
      currentDate >= request.requestedAt,
      currentDate <= request.expiresAt
    else {
      throw LoginRegistrationError.expiredRequest
    }
  }

  private func decoder() -> JSONDecoder {
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .iso8601
    return decoder
  }

  private func encoder() -> JSONEncoder {
    let encoder = JSONEncoder()
    encoder.dateEncodingStrategy = .iso8601
    encoder.outputFormatting = [.sortedKeys]
    return encoder
  }
}

private struct LoginUnregistrationAcknowledgement: Codable {
  let createdAt: Date
  let previousStatus: LoginItemRegistrationState
  let status: String
}

private enum LoginRegistrationError: Error {
  case invalidRequest
  case expiredRequest
}
