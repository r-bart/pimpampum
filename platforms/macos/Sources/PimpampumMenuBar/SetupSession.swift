import Combine
import Foundation

/// The guided setup as one unit of work that outlives any single view. The store and the current
/// step used to be state of a conditionally rendered child: the overview poll switching to
/// `.online` mid-apply, or the help button swapping the branch, destroyed both while `setup apply`
/// was still running. The app owns this object, so a setup in flight is never torn down.
@MainActor
final class SetupSession: ObservableObject {
  let store: SetupStore
  @Published private(set) var step: SetupOnboardingStep = SetupOnboardingStep.first

  private weak var overviewStore: OverviewStore?
  private let registerLoginItem: @MainActor () -> Void
  private var subscriptions: Set<AnyCancellable> = []

  init(
    store: SetupStore,
    overviewStore: OverviewStore? = nil,
    registerLoginItem: @escaping @MainActor () -> Void = {}
  ) {
    self.store = store
    self.overviewStore = overviewStore
    self.registerLoginItem = registerLoginItem
    store.objectWillChange
      .sink { [weak self] _ in self?.objectWillChange.send() }
      .store(in: &subscriptions)
    // A poll that lands while the daemon is being installed reports a half-installed daemon, and
    // its answer replaced the onboarding with "Loading overview". Polling waits for the mutation.
    store.$activity
      .map(\.hasBegunMutation)
      .removeDuplicates()
      .sink { [weak self] paused in self?.overviewStore?.setPollingPaused(paused) }
      .store(in: &subscriptions)
    store.$activity
      .combineLatest(store.$progress, store.$completion)
      .sink { [weak self] activity, progress, completion in
        guard let self,
          SetupOnboardingPresentation.showsDurableProgress(
            activity: activity,
            progress: progress,
            completion: completion
          )
        else { return }
        self.step = .progress
      }
      .store(in: &subscriptions)
  }

  static func bundled(overviewStore: OverviewStore?) -> SetupSession {
    SetupSession(
      store: SetupStore.bundled(),
      overviewStore: overviewStore,
      registerLoginItem: SetupAssistant().prepareApp
    )
  }

  /// While active, the popover keeps rendering the onboarding whatever the daemon reports. A first
  /// step nobody has moved past is not a session yet, so a fresh machine still shows the overview
  /// as soon as a receipt appears.
  var isActive: Bool {
    step != SetupOnboardingStep.first || store.activity.hasBegunMutation
      || store.completion != nil
  }

  func begin() {
    store.start()
  }

  func move(to step: SetupOnboardingStep) {
    self.step = step
  }

  /// Moves to the outcome step and applies the plan the user just reviewed. With unresolved
  /// conflicts the step shows the decision first and `SetupStore.resolveConflict` applies later.
  func reviewAndSetUp() async {
    guard store.canConfirm else { return }
    step = .progress
    guard store.plan?.conflicts.isEmpty == true else { return }
    await store.apply()
  }

  /// Back to the first step with no outcome on screen, for a setup that failed or finished.
  func startOver() {
    guard !store.activity.hasBegunMutation else { return }
    store.reset()
    step = SetupOnboardingStep.first
  }

  func cancelConflictRecovery() {
    store.reset()
    step = .agents
  }

  /// Done. Registration of the login item is a fallback for the installed copy only: from a copy in
  /// Downloads it would register the transient bundle. The relaunch comes last, because on that
  /// same copy it terminates this process.
  func finish() async {
    if store.canRegisterLoginItemFromThisProcess { registerLoginItem() }
    store.reset()
    step = SetupOnboardingStep.first
    await store.relaunchInstalledApplicationIfNeeded()
  }
}
