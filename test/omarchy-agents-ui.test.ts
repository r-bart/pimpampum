import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const pluginRoot = join(process.cwd(), 'integrations/omarchy/pimpampum-status');
const read = (name: string): string => readFileSync(join(pluginRoot, name), 'utf8');

describe('Omarchy Guided and Agents UI', () => {
  it('presents detection, one confirmation, progress, partial failure and completion', () => {
    const card = read('AgentsSettingsCard.qml');

    for (const copy of [
      'Connect your agents',
      'Detected agents are selected',
      'Connect selected agents',
      'Connecting ',
      'Some agents could not be connected',
      'Try again',
      'Agents are connected',
    ]) {
      expect(card).toContain(copy);
    }
    expect(card).toContain('stage = "confirmation"');
    expect(card).toContain('actionEnabled: !root.service.busy');
  });

  it('offers explicit conflict decisions and shared state-labelled agent actions', () => {
    const card = read('AgentsSettingsCard.qml');
    const service = read('AgentConnectionService.qml');

    for (const label of ['Keep existing', 'Replace', 'Cancel']) expect(card).toContain(label);
    expect(card).toContain('service.replace(conflictConnectorId)');
    expect(card).toContain('Disconnect agent');
    expect(card).toContain('The daemon and all project data remain available');
    for (const state of [
      'Not installed',
      'Not connected',
      'Connecting',
      'Connected',
      'New session required',
      'Needs repair',
      'Configuration conflict',
      'Unsupported version',
    ]) {
      expect(`${card}\n${service}`).toContain(state);
    }
  });

  it('is keyboard accessible, bounded, and delegates through the typed service only', () => {
    const card = read('AgentsSettingsCard.qml');
    const popout = read('StatusPopout.qml');
    const service = read('AgentConnectionService.qml');

    expect(card).toContain('activeFocusOnTab: enabled');
    expect(card).toContain('Keys.onPressed: function(event)');
    expect(card).toContain('Accessible.name:');
    expect(popout).toContain('AgentsSettingsCard {');
    expect(popout).toContain('boundsBehavior: Flickable.StopAtBounds');
    expect(`${card}\n${service}`).not.toMatch(
      /systemctl.+(?:stop|start)|mcpServers|\.claude\.json|config\.toml|bearer|token/iu,
    );
  });
});
