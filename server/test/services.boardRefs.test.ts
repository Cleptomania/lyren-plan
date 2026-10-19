// Board references on NodeDb (contract/services.boardRefs.contract.ts).

import { defineBoardRefsContract } from './contract/services.boardRefs.contract';
import { withNodeSpaceDb } from './services.fixtures';

defineBoardRefsContract('node', withNodeSpaceDb);
