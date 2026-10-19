// The activity services on NodeDb (contract/services.activity.contract.ts).

import { defineActivityContract } from './contract/services.activity.contract';
import { withNodeSpaceDb } from './services.fixtures';

defineActivityContract('node', withNodeSpaceDb);
