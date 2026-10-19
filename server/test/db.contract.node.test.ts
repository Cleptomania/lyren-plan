// The Db contract (contract/db.contract.ts) on NodeDb, with the portability checks on (vitest sets
// VITEST): an in-memory database per case. The limit cases need Node 24.15 or later.

import { NodeDb } from '../src/runtime/node/nodeDb';
import { defineDbContract } from './contract/db.contract';

const probe = new NodeDb(':memory:');
const limits = probe.emulatesDurableObject;
probe.close();

defineDbContract(
  'node',
  async (body) => {
    const db = new NodeDb(':memory:');
    try {
      return body(db);
    } finally {
      db.close();
    }
  },
  { limits },
);
