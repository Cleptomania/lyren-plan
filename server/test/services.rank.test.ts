// Ranks on NodeDb (contract/services.rank.contract.ts).

import { defineRankContract } from './contract/services.rank.contract';
import { withNodeSpaceDb } from './services.fixtures';

defineRankContract('node', withNodeSpaceDb);
