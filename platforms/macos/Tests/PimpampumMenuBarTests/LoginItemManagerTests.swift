import Foundation
import Testing

@testable import PimpampumMenuBar

private final class LoginServiceStub: LoginItemServicing {
  var state: LoginItemRegistrationState
  var registerError: Error?
  var unregisterError: Error?
  var stateAfterRegistration: LoginItemRegistrationState?
  private(set) var registrationCount = 0
  private(set) var unregistrationCount = 0

  init(state: LoginItemRegistrationState) {
    self.state = state
  }

  func register() throws {
    registrationCount += 1
    if let registerError { throw registerError }
    if let stateAfterRegistration { state = stateAfterRegistration }
  }

  func unregister() async throws {
    unregistrationCount += 1
    if let unregisterError { throw unregisterError }
  }
}

private final class LoginFilesStub: LoginRegistrationFileAccess {
  var stored: [URL: Data] = [:]
  private(set) var writes: [(URL, Data)] = []

  func read(_ url: URL) throws -> Data {
    guard let data = stored[url] else { throw CocoaError(.fileNoSuchFile) }
    return data
  }

  func writePrivate(_ data: Data, to url: URL) throws {
    stored[url] = data
    writes.append((url, data))
  }
}

@Suite("Login item registration")
struct LoginItemManagerTests {
  private let dataDirectory = URL(fileURLWithPath: "/tmp/Pimpampum Data")
  private let now = Date(timeIntervalSince1970: 1_800_000_000)
  private let requestId = "3B56CE4F-3D67-4DE5-8AF3-3F93BB2A54F0"

  @Test("Ignores ordinary application launches")
  func ignoresOrdinaryLaunch() async {
    let coordinator = LoginRegistrationCoordinator(
      service: LoginServiceStub(state: .enabled),
      files: LoginFilesStub(),
      now: { now }
    )
    #expect(!(await coordinator.handle(arguments: [], dataDirectory: dataDirectory)))
  }

  @Test("Preserves enabled and approval-required registrations")
  func preservesExistingRegistration() async throws {
    for expectedState in [LoginItemRegistrationState.enabled, .requiresApproval] {
      let service = LoginServiceStub(state: expectedState)
      let files = LoginFilesStub()
      try seedRequest(files)
      let coordinator = LoginRegistrationCoordinator(
        service: service,
        files: files,
        now: { now }
      )

      #expect(
        await coordinator.handle(
          arguments: ["--register-login-item", requestId],
          dataDirectory: dataDirectory
        ))
      let acknowledgement = try decodeAcknowledgement(files.writes.last!.1)
      #expect(acknowledgement.status == expectedState)
      #expect(acknowledgement.requestId == requestId)
      #expect(service.registrationCount == 0)
      #expect(!acknowledgement.registrationChanged)
    }
  }

  @Test("Reports when a new registration changes external state")
  func reportsNewRegistration() async throws {
    for expectedState in [LoginItemRegistrationState.enabled, .requiresApproval] {
      let service = LoginServiceStub(state: .error)
      service.stateAfterRegistration = expectedState
      let files = LoginFilesStub()
      try seedRequest(files)
      let coordinator = LoginRegistrationCoordinator(
        service: service,
        files: files,
        now: { now }
      )

      #expect(
        await coordinator.handle(
          arguments: ["--register-login-item", requestId],
          dataDirectory: dataDirectory
        ))
      let acknowledgement = try decodeAcknowledgement(files.writes.last!.1)
      #expect(acknowledgement.status == expectedState)
      #expect(acknowledgement.registrationChanged)
      #expect(service.registrationCount == 1)
    }
  }

  @Test("Reports registration errors without leaking their details")
  func registrationError() async throws {
    struct ExpectedFailure: Error {}
    let service = LoginServiceStub(state: .error)
    service.registerError = ExpectedFailure()
    let files = LoginFilesStub()
    try seedRequest(files)
    let coordinator = LoginRegistrationCoordinator(
      service: service,
      files: files,
      now: { now }
    )

    #expect(
      await coordinator.handle(
        arguments: ["--register-login-item", requestId],
        dataDirectory: dataDirectory
      ))
    let acknowledgement = try decodeAcknowledgement(files.writes.last!.1)
    #expect(acknowledgement.status == .error)
    #expect(!acknowledgement.registrationChanged)
    #expect(!String(decoding: files.writes.last!.1, as: UTF8.self).contains("ExpectedFailure"))
  }

  @Test("Reports an error when registration returns without a usable state")
  func postRegistrationErrorState() async throws {
    let service = LoginServiceStub(state: .error)
    let files = LoginFilesStub()
    try seedRequest(files)
    let coordinator = LoginRegistrationCoordinator(
      service: service,
      files: files,
      now: { now }
    )

    #expect(
      await coordinator.handle(
        arguments: ["--register-login-item", requestId],
        dataDirectory: dataDirectory
      ))
    let acknowledgement = try decodeAcknowledgement(files.writes.last!.1)
    #expect(acknowledgement.status == .error)
    #expect(!acknowledgement.registrationChanged)
    #expect(service.registrationCount == 1)
  }

  @Test("Rejects mismatched, malformed, future and expired requests")
  func rejectsUnsafeRequests() async throws {
    let cases: [(String, LoginRegistrationRequest?)] = [
      ("not-a-uuid", validRequest()),
      (
        requestId,
        LoginRegistrationRequest(
          requestId: "7068B181-4FE4-4C5F-9C34-03604E920199",
          requestedAt: now.addingTimeInterval(-1),
          expiresAt: now.addingTimeInterval(1)
        )
      ),
      (
        requestId,
        LoginRegistrationRequest(
          requestId: requestId,
          requestedAt: now.addingTimeInterval(1),
          expiresAt: now.addingTimeInterval(2)
        )
      ),
      (
        requestId,
        LoginRegistrationRequest(
          requestId: requestId,
          requestedAt: now.addingTimeInterval(-2),
          expiresAt: now.addingTimeInterval(-1)
        )
      ),
      (requestId, nil),
    ]

    for (argumentId, request) in cases {
      let files = LoginFilesStub()
      let requestURL = dataDirectory.appendingPathComponent(
        LoginRegistrationCoordinator.requestFileName
      )
      if let request {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        files.stored[requestURL] = try encoder.encode(request)
      }
      let service = LoginServiceStub(state: .error)
      let coordinator = LoginRegistrationCoordinator(
        service: service,
        files: files,
        now: { now }
      )
      #expect(
        await coordinator.handle(
          arguments: ["--register-login-item", argumentId],
          dataDirectory: dataDirectory
        ))
      #expect(try decodeAcknowledgement(files.writes.last!.1).status == .error)
      #expect(!(try decodeAcknowledgement(files.writes.last!.1).registrationChanged))
      #expect(service.registrationCount == 0)
    }
  }

  @Test("Unregisters explicitly and reports success or failure")
  func unregistersExplicitly() async throws {
    for fails in [false, true] {
      struct ExpectedFailure: Error {}
      let service = LoginServiceStub(state: .enabled)
      if fails { service.unregisterError = ExpectedFailure() }
      let files = LoginFilesStub()
      let coordinator = LoginRegistrationCoordinator(
        service: service,
        files: files,
        now: { now }
      )

      #expect(
        await coordinator.handle(
          arguments: ["--unregister-login-item"],
          dataDirectory: dataDirectory
        ))
      #expect(service.unregistrationCount == 1)
      let value =
        try JSONSerialization.jsonObject(with: files.writes.last!.1)
        as! [String: Any]
      #expect(value["status"] as? String == (fails ? "error" : "disabled"))
      #expect(value["previousStatus"] as? String == "enabled")
      #expect(
        files.writes.last!.0.lastPathComponent
          == LoginRegistrationCoordinator.unregistrationAcknowledgementFileName)
    }
  }

  @Test("Treats an already absent login item as disabled without mutation")
  func unregistersAbsentItemIdempotently() async throws {
    let service = LoginServiceStub(state: .error)
    let files = LoginFilesStub()
    let coordinator = LoginRegistrationCoordinator(
      service: service,
      files: files,
      now: { now }
    )

    #expect(
      await coordinator.handle(
        arguments: ["--unregister-login-item"],
        dataDirectory: dataDirectory
      ))
    #expect(service.unregistrationCount == 0)
    let value = try JSONSerialization.jsonObject(with: files.writes.last!.1) as! [String: Any]
    #expect(value["status"] as? String == "disabled")
    #expect(value["previousStatus"] as? String == "error")
  }

  private func validRequest() -> LoginRegistrationRequest {
    LoginRegistrationRequest(
      requestId: requestId,
      requestedAt: now.addingTimeInterval(-1),
      expiresAt: now.addingTimeInterval(1)
    )
  }

  private func seedRequest(_ files: LoginFilesStub) throws {
    let encoder = JSONEncoder()
    encoder.dateEncodingStrategy = .iso8601
    files.stored[
      dataDirectory.appendingPathComponent(LoginRegistrationCoordinator.requestFileName)
    ] = try encoder.encode(validRequest())
  }

  private func decodeAcknowledgement(_ data: Data) throws -> LoginRegistrationAcknowledgement {
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .iso8601
    return try decoder.decode(LoginRegistrationAcknowledgement.self, from: data)
  }
}
