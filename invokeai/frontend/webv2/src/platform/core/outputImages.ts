/**
 * Shared adapter from backend invocation-output contracts to image names.
 *
 * This deliberately understands only the output shapes owned by the backend
 * contract. It is not a general object walker: metadata and invocation inputs
 * may contain images, but they are not outputs.
 */
export const getOutputImageNames = (output: unknown): string[] => {
  const imageNames = new Set<string>();

  const visitImageField = (value: unknown): void => {
    if (!value || typeof value !== 'object') {
      return;
    }

    const record = value as Record<string, unknown>;
    const imageName = record.image_name;
    if (typeof imageName === 'string') {
      imageNames.add(imageName);
    }
  };

  const visitImageCollection = (value: unknown): void => {
    if (!Array.isArray(value)) {
      return;
    }

    value.forEach(visitImageField);
  };

  const visitWorkflowReturnValue = (value: unknown): void => {
    if (!value || typeof value !== 'object') {
      return;
    }

    if (Array.isArray(value)) {
      visitImageCollection(value);
      return;
    }

    const record = value as Record<string, unknown>;
    visitImageField(record);

    if (record.type === 'image_output') {
      visitImageField(record.image);
    } else if (record.type === 'image_collection_output') {
      visitImageCollection(record.collection);
    } else if (
      'image' in record &&
      Object.keys(record).every((key) => key === 'image' || key === 'width' || key === 'height')
    ) {
      // Older workflow-return values omitted the output type for a single-image wrapper.
      visitImageField(record.image);
    } else if ('collection' in record && Object.keys(record).every((key) => key === 'collection')) {
      // Older workflow-return values omitted the output type for a collection wrapper.
      visitImageCollection(record.collection);
    }
  };

  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    return [];
  }

  const record = output as Record<string, unknown>;
  if (record.type === 'workflow_return_output' || 'values' in record) {
    if (record.values && typeof record.values === 'object' && !Array.isArray(record.values)) {
      Object.values(record.values as Record<string, unknown>).forEach(visitWorkflowReturnValue);
    }
  } else if (record.type === 'image_output') {
    visitImageField(record.image);
  } else if (record.type === 'image_collection_output') {
    visitImageCollection(record.collection);
  } else if ('image' in record) {
    // Older queue results omitted the output type for single-image outputs.
    visitImageField(record.image);
  } else if ('collection' in record) {
    // Older queue results omitted the output type for image collections.
    visitImageCollection(record.collection);
  } else {
    visitWorkflowReturnValue(record);
  }

  return [...imageNames];
};
