import Foundation

struct LocalApplicationConfigurationReader: ApplicationConfigurationReading {
  func data(at url: URL) throws -> Data {
    try Data(contentsOf: url)
  }
}
