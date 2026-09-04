import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getClientStateValue } from './api';
import { fetchSessionBlobStrict } from './session';

vi.mock('./api', () => ({
  getClientStateValue: vi.fn(),
  setClientStateValue: vi.fn(),
}));

describe('fetchSessionBlobStrict', () => {
  beforeEach(() => vi.mocked(getClientStateValue).mockReset());

  it('propagates transport failures instead of treating them as a missing session', async () => {
    const failure = new Error('backend unavailable');
    vi.mocked(getClientStateValue).mockRejectedValueOnce(failure);

    await expect(fetchSessionBlobStrict()).rejects.toBe(failure);
  });
});
