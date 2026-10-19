// The task filter and sort SQL against the reference implementation on NodeDb
// (contract/services.filter.contract.ts).

import { defineFilterContract } from './contract/services.filter.contract';
import { withNodeSpaceDb } from './services.fixtures';

defineFilterContract('node', withNodeSpaceDb);
