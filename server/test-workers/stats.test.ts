// The single-scan statistics and dashboard against the queries they replaced (server/test/contract/
// stats.contract.ts), on DoDb in workerd.

import { defineStatsEquivalence } from '../test/contract/stats.contract';
import { withDoSpaceDb } from './spaceDb';

defineStatsEquivalence('durable-object', withDoSpaceDb);
