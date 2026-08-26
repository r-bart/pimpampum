import Foundation

protocol OverviewReading: Sendable {
  func fetchOverview() async throws -> Overview
}

protocol OverviewFileReading: Sendable {
  func data(at url: URL) throws -> Data
}

protocol OverviewTransport: Sendable {
  func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

enum OverviewClientError: Error, Equatable, LocalizedError, Sendable {
  case unreadableReceipt
  case incompatibleReceiptSchema(Int)
  case invalidBaseURL
  case unreadableToken
  case invalidToken
  case unauthorized
  case incompatibleOverviewSchema(Int)
  case invalidHTTPResponse
  case serverStatus(Int)
  case invalidPayload

  var errorDescription: String? {
    switch self {
    case .unreadableReceipt:
      "Pimpampum's installation receipt could not be read. Run pimpampum install."
    case .incompatibleReceiptSchema(let version):
      "The installed Pimpampum receipt uses unsupported schema version \(version)."
    case .invalidBaseURL:
      "Pimpampum's configured URL must be an authenticated loopback HTTP endpoint."
    case .unreadableToken:
      "Pimpampum's local token file could not be read. Run pimpampum install."
    case .invalidToken:
      "Pimpampum's local token is invalid. Run pimpampum install to repair it."
    case .unauthorized:
      "Pimpampum rejected the local token. Run pimpampum install to reconcile it."
    case .incompatibleOverviewSchema(let version):
      "Pimpampum returned unsupported overview schema version \(version)."
    case .invalidHTTPResponse:
      "Pimpampum returned a non-HTTP response."
    case .serverStatus(let status):
      "Pimpampum returned HTTP status \(status)."
    case .invalidPayload:
      "Pimpampum returned an invalid overview response."
    }
  }
}

struct OverviewClient: OverviewReading {
  static let supportedSchemaVersion = 1
  static let maximumItems = 500

  private let receiptURL: URL
  private let tokenURL: URL
  private let fileReader: any OverviewFileReading
  private let transport: any OverviewTransport

  init(
    receiptURL: URL,
    tokenURL: URL,
    fileReader: any OverviewFileReading = LocalOverviewFileReader(),
    transport: any OverviewTransport = URLSessionOverviewTransport()
  ) {
    self.receiptURL = receiptURL
    self.tokenURL = tokenURL
    self.fileReader = fileReader
    self.transport = transport
  }

  func fetchOverview() async throws -> Overview {
    let configuration = try loadConfiguration()
    var request = URLRequest(url: configuration.overviewURL)
    request.httpMethod = "GET"
    request.setValue("Bearer \(configuration.token)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Accept")

    let (data, response) = try await transport.data(for: request)
    guard response.statusCode != 401 else { throw OverviewClientError.unauthorized }
    guard response.statusCode == 200 else {
      throw OverviewClientError.serverStatus(response.statusCode)
    }

    let metadata: MetadataEnvelope
    do {
      metadata = try Self.decoder().decode(MetadataEnvelope.self, from: data)
    } catch {
      throw OverviewClientError.invalidPayload
    }
    guard metadata.meta.schemaVersion == Self.supportedSchemaVersion else {
      throw OverviewClientError.incompatibleOverviewSchema(metadata.meta.schemaVersion)
    }

    let envelope: OverviewEnvelope
    do {
      envelope = try Self.decoder().decode(OverviewEnvelope.self, from: data)
    } catch {
      throw OverviewClientError.invalidPayload
    }
    guard Self.isValid(envelope.data) else { throw OverviewClientError.invalidPayload }
    return envelope.data
  }

  private func loadConfiguration() throws -> ClientConfiguration {
    let receiptData: Data
    do {
      receiptData = try fileReader.data(at: receiptURL)
    } catch {
      throw OverviewClientError.unreadableReceipt
    }

    let receipt: InstallationReceipt
    do {
      receipt = try JSONDecoder().decode(InstallationReceipt.self, from: receiptData)
    } catch {
      throw OverviewClientError.unreadableReceipt
    }
    guard receipt.schemaVersion == Self.supportedSchemaVersion else {
      throw OverviewClientError.incompatibleReceiptSchema(receipt.schemaVersion)
    }
    guard let baseURL = URL(string: receipt.baseURL), Self.isSafeLoopback(baseURL) else {
      throw OverviewClientError.invalidBaseURL
    }

    let tokenData: Data
    do {
      tokenData = try fileReader.data(at: tokenURL)
    } catch {
      throw OverviewClientError.unreadableToken
    }
    var tokenBytes = Array(tokenData)
    while tokenBytes.last == 10 || tokenBytes.last == 13 {
      tokenBytes.removeLast()
    }
    guard tokenBytes.count >= 32, tokenBytes.allSatisfy({ (33...126).contains($0) }) else {
      throw OverviewClientError.invalidToken
    }

    return ClientConfiguration(
      overviewURL: baseURL.appending(path: "api/v1/overview"),
      token: String(decoding: tokenBytes, as: UTF8.self)
    )
  }

  private static func isSafeLoopback(_ url: URL) -> Bool {
    guard url.scheme == "http", url.user == nil, url.password == nil else { return false }
    guard url.query == nil, url.fragment == nil, url.path.isEmpty || url.path == "/" else {
      return false
    }
    guard let host = url.host?.lowercased() else { return false }
    return host == "127.0.0.1" || host == "localhost" || host == "::1"
  }

  private static func isValid(_ overview: Overview) -> Bool {
    guard overview.daemon.uptimeSeconds >= 0 else { return false }
    guard overview.counts.allValues.allSatisfy({ $0 >= 0 }) else { return false }
    guard overview.projects.count <= maximumItems, overview.activeWork.count <= maximumItems else {
      return false
    }
    guard
      overview.projects.allSatisfy({ project in
        !project.id.isEmpty && !project.workspace.id.isEmpty && !project.workspace.rootPath.isEmpty
          && project.allCounts.allSatisfy { $0 >= 0 }
      })
    else { return false }
    guard Set(overview.projects.map(\.id)).count == overview.projects.count else { return false }
    guard
      overview.activeWork.allSatisfy({ work in
        !work.targetId.isEmpty && !work.projectId.isEmpty && !work.agentId.isEmpty
          && work.expiresAt > overview.generatedAt
          && (work.targetType == .task ? work.taskId != nil && work.taskTitle != nil : true)
      })
    else { return false }
    return true
  }

  private static func decoder() -> JSONDecoder {
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
}

private struct InstallationReceipt: Decodable {
  let schemaVersion: Int
  let baseURL: String

  enum CodingKeys: String, CodingKey {
    case schemaVersion
    case baseURL = "baseUrl"
  }
}

private struct MetadataEnvelope: Decodable {
  let meta: OverviewMetadata
}

private struct ClientConfiguration {
  let overviewURL: URL
  let token: String
}
