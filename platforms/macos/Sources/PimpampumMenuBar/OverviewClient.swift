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
      "\(PimpampumBrand.displayName)'s installation receipt could not be read. Run pimpampum install."
    case .incompatibleReceiptSchema(let version):
      "The installed \(PimpampumBrand.displayName) receipt uses unsupported schema version \(version)."
    case .invalidBaseURL:
      "\(PimpampumBrand.displayName)'s configured URL must be an authenticated loopback HTTP endpoint."
    case .unreadableToken:
      "\(PimpampumBrand.displayName)'s local token file could not be read. Run pimpampum install."
    case .invalidToken:
      "\(PimpampumBrand.displayName)'s local token is invalid. Run pimpampum install to repair it."
    case .unauthorized:
      "\(PimpampumBrand.displayName) rejected the local token. Run pimpampum install to reconcile it."
    case .incompatibleOverviewSchema(let version):
      "\(PimpampumBrand.displayName) returned unsupported overview schema version \(version)."
    case .invalidHTTPResponse:
      "\(PimpampumBrand.displayName) returned a non-HTTP response."
    case .serverStatus(let status):
      "\(PimpampumBrand.displayName) returned HTTP status \(status)."
    case .invalidPayload:
      "\(PimpampumBrand.displayName) returned an invalid overview response."
    }
  }
}

struct OverviewClient: OverviewReading {
  static let supportedSchemaVersion = 2
  static let maximumItems = 500

  private let client: DaemonClient

  init(
    receiptURL: URL,
    tokenURL: URL,
    fileReader: any OverviewFileReading = LocalOverviewFileReader(),
    transport: any OverviewTransport = URLSessionOverviewTransport()
  ) {
    client = DaemonClient(
      receiptURL: receiptURL,
      tokenURL: tokenURL,
      fileReader: fileReader,
      transport: transport
    )
  }

  func fetchOverview() async throws -> Overview {
    let response: DaemonResponse
    do {
      response = try await client.send(method: "GET", path: "api/v1/overview")
    } catch let failure as DaemonClientFailure {
      throw Self.map(failure)
    }
    let data = response.data

    let metadata: MetadataEnvelope
    do {
      metadata = try DaemonClient.decoder().decode(MetadataEnvelope.self, from: data)
    } catch {
      throw OverviewClientError.invalidPayload
    }
    guard metadata.meta.schemaVersion == Self.supportedSchemaVersion else {
      throw OverviewClientError.incompatibleOverviewSchema(metadata.meta.schemaVersion)
    }

    let envelope: OverviewEnvelope
    do {
      envelope = try DaemonClient.decoder().decode(OverviewEnvelope.self, from: data)
    } catch {
      throw OverviewClientError.invalidPayload
    }
    guard Self.isValid(envelope.data) else { throw OverviewClientError.invalidPayload }
    return envelope.data
  }

  /// The overview poll is the one caller that rethrows a transport failure unchanged: `OverviewStore`
  /// separates "the daemon is not answering" from a typed client error, and it needs the original.
  /// A refused status keeps only its code, because the popover's offline copy names the repair.
  private static func map(_ failure: DaemonClientFailure) -> any Error {
    switch failure {
    case .configuration(.unreadableReceipt): OverviewClientError.unreadableReceipt
    case .configuration(.incompatibleReceiptSchema(let version)):
      OverviewClientError.incompatibleReceiptSchema(version)
    case .configuration(.invalidBaseURL): OverviewClientError.invalidBaseURL
    case .configuration(.unreadableToken): OverviewClientError.unreadableToken
    case .configuration(.invalidToken): OverviewClientError.invalidToken
    case .transport(let error): error
    case .unauthorized: OverviewClientError.unauthorized
    case .serverStatus(let status, _): OverviewClientError.serverStatus(status)
    }
  }

  private static func isValid(_ overview: Overview) -> Bool {
    guard overview.daemon.uptimeSeconds >= 0 else { return false }
    guard overview.counts.allValues.allSatisfy({ $0 >= 0 }) else { return false }
    guard
      overview.projects.count <= maximumItems,
      overview.specs.count <= maximumItems,
      overview.activeWork.count <= maximumItems
    else {
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
      overview.specs.allSatisfy({ spec in
        !spec.id.isEmpty && !spec.projectId.isEmpty && !spec.projectTitle.isEmpty
          && !spec.workspace.id.isEmpty && !spec.workspace.rootPath.isEmpty
          && !spec.slug.isEmpty && !spec.title.isEmpty
          && spec.allCounts.allSatisfy { $0 >= 0 }
      })
    else { return false }
    guard Set(overview.specs.map(\.id)).count == overview.specs.count else { return false }
    guard
      overview.activeWork.allSatisfy({ work in
        !work.targetId.isEmpty && !work.projectId.isEmpty && !work.specId.isEmpty
          && !work.specTitle.isEmpty && !work.agentId.isEmpty
          && work.expiresAt > overview.generatedAt
          && (work.targetType == .task
            ? work.taskId != nil && work.taskTitle != nil
            : work.taskId == nil && work.taskTitle == nil)
      })
    else { return false }
    return true
  }
}

private struct MetadataEnvelope: Decodable {
  let meta: OverviewMetadata
}
