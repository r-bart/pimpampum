import Foundation

struct AuthenticatedDaemonConfiguration: Sendable {
  let baseURL: URL
  let token: String
}

enum AuthenticatedDaemonConfigurationError: Error, Equatable, Sendable {
  case unreadableReceipt
  case incompatibleReceiptSchema(Int)
  case invalidBaseURL
  case unreadableToken
  case invalidToken
}

struct AuthenticatedDaemonConfigurationLoader: Sendable {
  static let supportedSchemaVersion = 1

  private let receiptURL: URL
  private let tokenURL: URL
  private let fileReader: any OverviewFileReading

  init(receiptURL: URL, tokenURL: URL, fileReader: any OverviewFileReading) {
    self.receiptURL = receiptURL
    self.tokenURL = tokenURL
    self.fileReader = fileReader
  }

  func load() throws -> AuthenticatedDaemonConfiguration {
    let receiptData: Data
    do {
      receiptData = try fileReader.data(at: receiptURL)
    } catch {
      throw AuthenticatedDaemonConfigurationError.unreadableReceipt
    }

    let receipt: InstallationReceipt
    do {
      receipt = try JSONDecoder().decode(InstallationReceipt.self, from: receiptData)
    } catch {
      throw AuthenticatedDaemonConfigurationError.unreadableReceipt
    }
    guard receipt.schemaVersion == Self.supportedSchemaVersion else {
      throw AuthenticatedDaemonConfigurationError.incompatibleReceiptSchema(receipt.schemaVersion)
    }
    guard let baseURL = URL(string: receipt.baseURL), Self.isSafeLoopback(baseURL) else {
      throw AuthenticatedDaemonConfigurationError.invalidBaseURL
    }

    let tokenData: Data
    do {
      tokenData = try fileReader.data(at: tokenURL)
    } catch {
      throw AuthenticatedDaemonConfigurationError.unreadableToken
    }
    var tokenBytes = Array(tokenData)
    while tokenBytes.last == 10 || tokenBytes.last == 13 {
      tokenBytes.removeLast()
    }
    guard tokenBytes.count >= 32, tokenBytes.allSatisfy({ (33...126).contains($0) }) else {
      throw AuthenticatedDaemonConfigurationError.invalidToken
    }

    return AuthenticatedDaemonConfiguration(
      baseURL: baseURL,
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
}

private struct InstallationReceipt: Decodable {
  let schemaVersion: Int
  let baseURL: String

  enum CodingKeys: String, CodingKey {
    case schemaVersion
    case baseURL = "baseUrl"
  }
}
