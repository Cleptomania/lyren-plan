// The space service suites (server/test/contract/services.*.contract.ts, design §14.4) on DoDb in workerd:
// each test's database is a fresh TestDbDO (spaceDb.ts).

import { defineActivityContract } from '../test/contract/services.activity.contract';
import { defineBoardRefsContract } from '../test/contract/services.boardRefs.contract';
import { defineEntitiesContract } from '../test/contract/services.entities.contract';
import { defineFilterContract } from '../test/contract/services.filter.contract';
import { defineRankContract } from '../test/contract/services.rank.contract';
import { defineSettingsContract } from '../test/contract/services.settings.contract';
import { defineStatsContract } from '../test/contract/services.stats.contract';
import { withDoSpaceDb } from './spaceDb';

defineEntitiesContract('durable-object', withDoSpaceDb);
defineRankContract('durable-object', withDoSpaceDb);
defineActivityContract('durable-object', withDoSpaceDb);
defineBoardRefsContract('durable-object', withDoSpaceDb);
defineSettingsContract('durable-object', withDoSpaceDb);
defineStatsContract('durable-object', withDoSpaceDb);
defineFilterContract('durable-object', withDoSpaceDb);
