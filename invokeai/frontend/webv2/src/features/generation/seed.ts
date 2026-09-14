/**
 * Generation's seed policy, published on its own so pure cores elsewhere can
 * reuse the arithmetic without importing the settings surface.
 */
export {
  getSeedSequenceLength,
  getSeedStep,
  isSeedMode,
  planSeedSubmission,
  SEED_MAX,
  SEED_MODES,
  wrapSeed,
  type SeedMode,
  type SeedSequenceInput,
  type SeedStep,
  type SeedSubmissionPlan,
} from './core/seed';
