// The import's rows (server/test/contract/import.contract.ts) on NodeDb; the same contract runs on DoDb in
// workerd (server/test-workers/importCost.test.ts).

import { defineImportContract } from './contract/import.contract';
import { withNodeSpaceDb } from './services.fixtures';

defineImportContract('node', withNodeSpaceDb);
