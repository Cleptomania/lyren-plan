// The settings services on NodeDb (contract/services.settings.contract.ts).

import { defineSettingsContract } from './contract/services.settings.contract';
import { withNodeSpaceDb } from './services.fixtures';

defineSettingsContract('node', withNodeSpaceDb);
