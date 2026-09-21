/**
 * Collect image names from an invocation output, including named values returned by
 * `workflow_return`. A collection is intentionally flattened: callers that render one
 * thumbnail use the first name, while queue result routing uses every name.
 */
export const getOutputImageNames = (output: unknown): string[] => {
  const imageNames = new Set<string>();

  const visitImageValue = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visitImageValue);
      return;
    }

    if (!value || typeof value !== 'object') {
      return;
    }

    const imageName = (value as { image_name?: unknown }).image_name;
    if (typeof imageName === 'string') {
      imageNames.add(imageName);
      return;
    }

    if ('image' in value) {
      visitImageValue(value.image);
    }

    if ('collection' in value) {
      visitImageValue(value.collection);
    }

    // `values` is the only output field whose nested values are all returned
    // values. Do not walk arbitrary output fields such as `value` or metadata.
    if ('values' in value) {
      visitImageValue(value.values);
    }

    // A workflow return value is a mapping from names to output values. Its
    // entries need one more explicit descent, without opening unrelated fields.
    if (!('image' in value) && !('collection' in value) && !('values' in value)) {
      Object.entries(value)
        .filter(([key]) => key !== 'output_meta')
        .forEach(([, nestedValue]) => visitImageValue(nestedValue));
    }
  };

  if (output && typeof output === 'object' && !Array.isArray(output)) {
    const result = output as Record<string, unknown>;

    visitImageValue(result.image);
    visitImageValue(result.collection);
    visitImageValue(result.values);
  }

  return [...imageNames];
};
