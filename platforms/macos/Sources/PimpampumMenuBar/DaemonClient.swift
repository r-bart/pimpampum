import Foundation

/// What one authenticated daemon call can fail with, before a client maps it onto its own error
/// type. Each client keeps its own `LocalizedError` enum, because those messages are the panel's
/// copy; this enum only carries the failure across the shared call.
enum DaemonClientFailure: Error {
  case configuration(AuthenticatedDaemonConfigurationError)
  /// The transport threw something that was not a cancellation. `OverviewClient` rethrows the
  /// underlying error unchanged; the settings clients report their own `transportFailure`.
  case transport(any Error)
  case unauthorized
  /// A non-200 status, with the daemon's own message when the body carried a typed error envelope.
  case serverStatus(Int, String?)
}

/// One successful daemon response: the body, and the bearer token the request carried so a client
/// can reject a payload that echoes it back.
struct DaemonResponse: Sendable {
  let data: Data
  let token: String
}

/// The half of `OverviewClient`, `BackupSettingsClient` and `SyncSettingsClient` that does not
/// depend on what the daemon returns: the authenticated loopback configuration, the bearer request,
/// and the one call that maps transport, 401 and non-200 onto `DaemonClientFailure`. It also owns
/// the single ISO-8601 decoder every payload is read with and the two payload guards the settings
/// clients share.
///
/// A cancellation is never wrapped: it is rethrown as `CancellationError` before the transport
/// failure is built, so a cancelled refresh stays a cancellation instead of becoming an error the
/// panel would show.
struct DaemonClient: Sendable {
  private let receiptURL: URL
  private let tokenURL: URL
  private let fileReader: any OverviewFileReading
  private let transport: any OverviewTransport

  init(
    receiptURL: URL,
    tokenURL: URL,
    fileReader: any OverviewFileReading,
    transport: any OverviewTransport
  ) {
    self.receiptURL = receiptURL
    self.tokenURL = tokenURL
    self.fileReader = fileReader
    self.transport = transport
  }

  /// Reads the receipt and the token, then performs one authenticated request against `path`.
  /// `jsonBody`, when present, is sent as an `application/json` body.
  func send(method: String, path: String, jsonBody: Data? = nil) async throws -> DaemonResponse {
    let configuration = try loadConfiguration()
    var request = URLRequest(url: configuration.baseURL.appending(path: path))
    request.httpMethod = method
    request.setValue("Bearer \(configuration.token)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    if let jsonBody {
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.httpBody = jsonBody
    }

    let data: Data
    let response: HTTPURLResponse
    do {
      (data, response) = try await transport.data(for: request)
    } catch is CancellationError {
      throw CancellationError()
    } catch {
      throw DaemonClientFailure.transport(error)
    }

    guard response.statusCode != 401 else { throw DaemonClientFailure.unauthorized }
    guard response.statusCode == 200 else {
      throw DaemonClientFailure.serverStatus(
        response.statusCode,
        Self.serverMessage(from: data, redacting: configuration.token)
      )
    }
    return DaemonResponse(data: data, token: configuration.token)
  }

  private func loadConfiguration() throws -> AuthenticatedDaemonConfiguration {
    do {
      return try AuthenticatedDaemonConfigurationLoader(
        receiptURL: receiptURL,
        tokenURL: tokenURL,
        fileReader: fileReader
      ).load()
    } catch let error as AuthenticatedDaemonConfigurationError {
      throw DaemonClientFailure.configuration(error)
    }
  }

  /// The daemon writes `2026-09-02T10:00:00.000Z` but older records carry whole seconds, so both
  /// forms are accepted and anything else is a corrupt payload.
  static func decoder() -> JSONDecoder {
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .custom { decoder in
      let container = try decoder.singleValueContainer()
      let value = try container.decode(String.self)
      let fractional = ISO8601DateFormatter()
      fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
      if let date = fractional.date(from: value) { return date }
      let standard = ISO8601DateFormatter()
      standard.formatOptions = [.withInternetDateTime]
      if let date = standard.date(from: value) { return date }
      throw DecodingError.dataCorruptedError(
        in: container,
        debugDescription: "Expected an ISO 8601 timestamp"
      )
    }
    return decoder
  }

  static func isSafeAbsolutePath(_ path: String) -> Bool {
    !path.isEmpty && !path.contains("\0") && NSString(string: path).isAbsolutePath
  }

  /// One line of user-visible text from the daemon: present, bounded, and free of control
  /// characters that could break the panel or hide part of the message.
  static func isBoundedText(_ value: String) -> Bool {
    !value.isEmpty && value.count <= 500
      && !value.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains)
  }

  /// The daemon's own message for a refused call, redacted of the bearer token, stripped of control
  /// characters and bounded, so the panel can name the reason instead of only the status code.
  static func serverMessage(from data: Data, redacting token: String) -> String? {
    guard
      let envelope = try? JSONDecoder().decode(DaemonServerErrorEnvelope.self, from: data),
      let message = envelope.error.message
    else { return nil }
    let redacted = message.replacingOccurrences(of: token, with: "[redacted]")
    let sanitized = redacted.unicodeScalars
      .filter { !CharacterSet.controlCharacters.contains($0) }
      .prefix(500)
    let value = String(String.UnicodeScalarView(sanitized))
      .trimmingCharacters(in: .whitespacesAndNewlines)
    return value.isEmpty ? nil : value
  }
}

private struct DaemonServerErrorEnvelope: Decodable {
  struct ServerError: Decodable {
    let message: String?
  }

  let error: ServerError
}
