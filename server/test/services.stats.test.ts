// The statistics services on NodeDb (contract/services.stats.contract.ts).

import { defineStatsContract } from './contract/services.stats.contract';
import { withNodeSpaceDb } from './services.fixtures';

defineStatsContract('node', withNodeSpaceDb);
