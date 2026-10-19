// The single-scan statistics and dashboard against the queries they replaced (contract/stats.contract.ts),
// on NodeDb.

import { defineStatsEquivalence } from './contract/stats.contract';
import { withNodeSpaceDb } from './services.fixtures';

defineStatsEquivalence('node', withNodeSpaceDb);
