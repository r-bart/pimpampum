/**
 * @generated-from thoughts/specs/2026-08-31_zero-friction-local-agent-setup.md
 * @immutable Do NOT modify these tests — implementation must make them pass as-is.
 *
 * These tests encode the spec's acceptance criteria as executable assertions.
 * If a test seems wrong, update the spec and regenerate — don't edit tests directly.
 */
import Foundation
import Testing

@testable import PimpampumMenuBar

@Suite("Zero-friction local agent setup")
struct ZeroFrictionSetupAcceptanceTests {
  private var repositoryRoot: URL {
    var url = URL(fileURLWithPath: #filePath)
    for _ in 0..<5 { url.deleteLastPathComponent() }
    return url
  }

  private func source(_ relativePath: String) throws -> String {
    try String(
      contentsOf: repositoryRoot.appendingPathComponent(relativePath),
      encoding: .utf8
    )
  }

  @Test("Guided onboarding has three progressive steps and one mutating confirmation")
  func guidedHierarchyAndConsent() throws {
    // Spec: US-1/AC-1, US-1/AC-4, FR-4.1, FR-4.2, A11Y-2
    let onboarding = try source(
      "platforms/macos/Sources/PimpampumMenuBar/SetupOnboardingView.swift")

    #expect(onboarding.contains("1 OF 3"))
    #expect(onboarding.contains("2 OF 3"))
    #expect(onboarding.contains("3 OF 3"))
    #expect(onboarding.contains("Review & set up"))
    #expect(onboarding.contains("One private home for agent context"))
    #expect(!onboarding.localizedCaseInsensitiveContains("npm"))
    #expect(!onboarding.localizedCaseInsensitiveContains("open terminal"))
  }

  @Test("Detected supported agents are selected by default and remain user-editable")
  func detectedAgentSelection() throws {
    // Spec: US-1/AC-2, US-1/AC-3, FR-3.2, FR-3.3, EC-2, EC-3
    let models = try source(
      "platforms/macos/Sources/PimpampumMenuBar/SetupModels.swift")
    let onboarding = try source(
      "platforms/macos/Sources/PimpampumMenuBar/SetupOnboardingView.swift")

    #expect(models.contains("codex"))
    #expect(models.contains("claude-code"))
    #expect(models.contains("selectedByDefault"))
    #expect(onboarding.contains("Detected agents"))
    #expect(onboarding.contains("Ready to connect"))
    #expect(onboarding.contains("Toggle") || onboarding.contains("selection"))
  }

  @Test("Progress is durable, per-component, and distinguishes current-session availability")
  func durableProgressAndCompletion() throws {
    // Spec: US-2/AC-1, US-2/AC-2, US-2/AC-4, FR-6.5, FR-7.1, A11Y-4
    let models = try source(
      "platforms/macos/Sources/PimpampumMenuBar/SetupModels.swift")
    let store = try source(
      "platforms/macos/Sources/PimpampumMenuBar/SetupStore.swift")
    let popover = try source(
      "platforms/macos/Sources/PimpampumMenuBar/StatusPopover.swift")

    #expect(models.contains("configured"))
    #expect(models.contains("available"))
    #expect(models.contains("newSessionRequired"))
    #expect(models.contains("partial"))
    #expect(store.contains("resume"))
    #expect(popover.contains("Try again"))
    #expect(popover.contains("new agent session"))
    #expect(popover.contains("Label") || popover.contains("accessibility"))
  }

  @Test("The native process adapter is schema-bounded and never invokes a shell")
  func boundedSetupCommandRunner() throws {
    // Spec: FR-2.9, FR-9.1, SEC-4, SEC-8
    let runner = try source(
      "platforms/macos/Sources/PimpampumMenuBar/SetupCommandRunner.swift")

    #expect(runner.contains("Process"))
    #expect(runner.contains("JSONDecoder"))
    #expect(runner.contains("schemaVersion"))
    #expect(runner.contains("arguments"))
    #expect(!runner.contains("/bin/sh"))
    #expect(!runner.contains("-c\""))
    #expect(!runner.localizedCaseInsensitiveContains("bearer"))
  }

  @Test("Agents settings exposes only state-valid reversible actions")
  func agentsSettingsActions() throws {
    // Spec: US-4/AC-1, US-4/AC-2, US-4/AC-3, US-4/AC-4, A11Y-5
    let settings = try source(
      "platforms/macos/Sources/PimpampumMenuBar/AgentSettingsView.swift")
    let navigation = try source(
      "platforms/macos/Sources/PimpampumMenuBar/SyncSettings.swift")

    #expect(navigation.contains("Agents"))
    for action in ["Connect", "Test", "Repair", "Open", "Disconnect"] {
      #expect(settings.contains(action))
    }
    #expect(settings.contains("Advanced"))
    #expect(settings.contains("Not installed"))
    #expect(settings.contains("Configuration conflict"))
    #expect(settings.contains("accessibility"))
  }

  @Test("Guided setup preserves native sizing, keyboard, VoiceOver, motion and appearance")
  func nativeAccessibilityAndAppearance() throws {
    // Spec: A11Y-1, A11Y-2, A11Y-3, A11Y-4, A11Y-5
    let onboarding = try source(
      "platforms/macos/Sources/PimpampumMenuBar/SetupOnboardingView.swift")

    #expect(onboarding.contains("44"))
    #expect(onboarding.contains("keyboardShortcut"))
    #expect(onboarding.contains("accessibilityLabel"))
    #expect(onboarding.contains("accessibilityReduceMotion"))
    #expect(onboarding.contains("primary"))
    #expect(!onboarding.contains("Color.white"))
    #expect(!onboarding.contains("Color.black"))
  }
}
