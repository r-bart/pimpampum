// CaptureFlow takes the five canonical screenshots in evidence order, with the offline and
// recovery waits between them, and records the source hash of every capture at the moment it
// was taken so a later edit of the file is caught when the evidence is staged.

import { sha256 } from '../lib/hashTree.mjs';
import { requireAbsolute } from '../lib/paths.mjs';
import { readPng } from './artifacts.mjs';
import {
  OMARCHY_SCREENSHOT_ARGUMENTS,
  TASK_3_3_AUTOMATED_ONLY,
  TASK_3_3_CAPTURE_GUIDANCE,
  TASK_3_3_REVIEW_MATRIX,
} from './contract.mjs';

export class CaptureFlow {
  constructor(session) {
    this.session = session;
    this.screenshots = {};
    this.sourceHashes = {};
  }

  static instruction(name, context) {
    const matrixPrompt =
      name === 'activePopout'
        ? `Before taking the five canonical captures, directly exercise every item in this live matrix through supported Omarchy controls and Pimpampum's public CLI/API; do not infer a state from static validation: ${TASK_3_3_REVIEW_MATRIX.join(' ')} Not required live, covered by automated tests only: ${TASK_3_3_AUTOMATED_ONLY.join(' ')}`
        : '';
    return [matrixPrompt, context?.instruction, TASK_3_3_CAPTURE_GUIDANCE[name]]
      .filter(Boolean)
      .join(' ');
  }

  /** One guided capture; a production candidate records the omarchy command in the transcript. */
  async capture(name, context) {
    const { dependencies, target } = this.session;
    const guidedContext = { ...context, instruction: CaptureFlow.instruction(name, context) };
    if (!target.productionCandidate) {
      this.screenshots[name] = await dependencies.captureScreenshot(name, guidedContext);
    } else {
      if (
        typeof dependencies.prepareScreenshot !== 'function' ||
        typeof dependencies.resolveScreenshotPath !== 'function'
      ) {
        throw new Error('Production candidate capture requires transcript-aware screenshot IO');
      }
      await dependencies.prepareScreenshot(name, guidedContext);
      const captured = await this.session.execute(
        `screenshot-${name}`,
        'omarchy',
        OMARCHY_SCREENSHOT_ARGUMENTS,
      );
      this.screenshots[name] = dependencies.resolveScreenshotPath(captured.stdout, name);
    }
    const source = requireAbsolute(this.screenshots[name], `${name} screenshot`);
    this.sourceHashes[name] = sha256(readPng(source, `${name} screenshot`));
  }

  /** The ordered captures: active, completed, offline (daemon stopped), recovered, workspace. */
  async run() {
    const { session } = this;
    await this.capture('activePopout', {
      instruction: 'Open the Pimpampum popout and show mixed active work.',
    });
    await this.capture('completedPopout', {
      instruction:
        'Show the completed project collapsed, expand it to inspect long content, then return it to the captured collapsed state.',
    });
    await session.execute('offline', 'systemctl', ['--user', 'stop', 'pimpampum.service']);
    await this.capture('offlineStale', {
      instruction: 'Show the Pimpampum stale/offline state.',
    });
    await session.execute('recovery', 'systemctl', ['--user', 'start', 'pimpampum.service']);
    const recovered = await session.cliData('status-recovered', ['status'], 'recovered status');
    if (recovered.running !== true) throw new Error('Pimpampum did not recover after restart');
    await this.capture('recovered', {
      instruction: 'Show the recovered online state.',
    });
    await this.capture('workspaceOpen', {
      instruction:
        'Click the project row in the Pimpampum QML popout and show the workspace opened by that UI action.',
    });
    // Secondary fallback kept in the evidence transcript; the bound screenshot proves the QML action.
    await session.execute('workspace-open', 'xdg-open', [session.target.workspace], {
      allowBackground: true,
    });
  }
}
