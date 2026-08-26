import Foundation

/// Concrete operating-system adapters. These stay deliberately thin so the
/// deterministic overview logic can be covered independently of live I/O.
struct LocalOverviewFileReader: OverviewFileReading {
  func data(at url: URL) throws -> Data {
    try Data(contentsOf: url)
  }
}

struct URLSessionOverviewTransport: OverviewTransport {
  private let session: URLSession

  init(session: URLSession = .shared) {
    self.session = session
  }

  func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
    let (data, response) = try await session.data(for: request)
    guard let httpResponse = response as? HTTPURLResponse else {
      throw OverviewClientError.invalidHTTPResponse
    }
    return (data, httpResponse)
  }
}

struct SystemOverviewClock: OverviewClock {
  func now() async -> Date { Date() }

  func sleep(for seconds: TimeInterval) async throws {
    try await Task.sleep(for: .seconds(seconds))
  }
}
