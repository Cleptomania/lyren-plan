// The entity helpers on NodeDb (contract/services.entities.contract.ts).

import { defineEntitiesContract } from './contract/services.entities.contract';
import { withNodeSpaceDb } from './services.fixtures';

defineEntitiesContract('node', withNodeSpaceDb);
