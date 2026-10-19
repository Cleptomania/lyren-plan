// The one case-folding function (server/src/core/fold.ts, design §3.4).

import { describe, expect, it } from 'vitest';
import { searchTokens } from '@shared/filter';
import { fold } from '../src/core/fold';

// Greek (final sigma), German (ß, umlauts), Turkish (dotted and dotless i), combining marks, title case.
const SAMPLES = ['ΟΔΟΣ', 'ΣΑΣ', 'Σ', 'ΌΣΟΣ ΜΑΣ', 'Straße', 'STRASSE', 'ÄRGER Übel', 'İstanbul', 'IŞIK', 'ı', 'é', 'Å', 'ǅ', '', 'x'];

describe('fold', () => {
  it('lower-cases like String#toLowerCase, so it matches searchTokens', () => {
    expect(fold('ÄRGER Été')).toBe('ärger été');
    expect(searchTokens('ÄRGER ΟΔΟΣ')).toEqual(['ÄRGER', 'ΟΔΟΣ'].map(fold));
  });

  it('commutes with joining by a newline, so stored folds can be concatenated in SQL', () => {
    for (const a of SAMPLES) {
      for (const b of SAMPLES) expect(fold(`${a}\n${b}`), JSON.stringify([a, b])).toBe(`${fold(a)}\n${fold(b)}`);
    }
  });
});
