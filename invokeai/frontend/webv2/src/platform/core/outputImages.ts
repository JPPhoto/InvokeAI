/**
 * Shared adapter from backend invocation-output contracts to image names.
 *
 * This deliberately understands only the output shapes owned by the backend
 * contract. It is not a general object walker: metadata and invocation inputs
 * may contain images, but they are not outputs.
 */
export const getOutputImageNames = (output: unknown): string[] => {
  const imageNames = new Set<string>();

  const visitOutputValue = (value: unknown): void => {
    if (!value || typeof value !== 'object') {
      return;
    }

    if (Array.isArray(value)) {
      value.forEach(visitOutputValue);
      return;
    }

    const record = value as Record<string, unknown>;
    const imageName = record.image_name;
    if (typeof imageName === 'string') {
      imageNames.add(imageName);
      return;
    }

    if ('image' in record) {
      visitOutputValue(record.image);
    }

    if ('collection' in record) {
      visitOutputValue(record.collection);
    }

    // `values` is the workflow-return wrapper. Its keys are user-selected and
    // therefore must never be interpreted as field names.
    if ('values' in record && record.values && typeof record.values === 'object') {
      Object.values(record.values as Record<string, unknown>).forEach(visitOutputValue);
    }
  };

  if (output && typeof output === 'object' && !Array.isArray(output)) {
    visitOutputValue(output);
  }

  return [...imageNames];
};
