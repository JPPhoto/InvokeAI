import { describe, expect, it } from 'vitest';

import { getOutputImageNames } from './outputImages';

describe('getOutputImageNames', () => {
  it('reads direct images, collections, and workflow-return values independent of names', () => {
    expect(
      getOutputImageNames({
        collection: [{ image_name: 'a.png' }, { image_name: 'b.png' }],
        image: { image_name: 'a.png' },
        values: {
          collection: { collection: [{ image_name: 'c.png' }] },
          image: { image: { image_name: 'd.png' } },
          values: { image_name: 'e.png' },
        },
      })
    ).toEqual(['a.png', 'b.png', 'c.png', 'd.png', 'e.png']);
  });

  it('does not inspect metadata, controls, or nested input objects', () => {
    expect(
      getOutputImageNames({
        input: { image: { image_name: 'input.png' } },
        metadata: { image: { image_name: 'metadata.png' } },
        output_meta: { image: { image_name: 'meta-output.png' } },
        values: { result: { image: { image_name: 'result.png' } } },
      })
    ).toEqual(['result.png']);
  });

  it('accepts return keys named image, collection, and values', () => {
    expect(
      getOutputImageNames({
        values: {
          collection: [{ image_name: 'collection.png' }],
          image: { image_name: 'image.png' },
          values: { image_name: 'values.png' },
        },
      })
    ).toEqual(['collection.png', 'image.png', 'values.png']);
  });
});
