/**
 * The seed mode menu on its own, for hosts that own the seed value themselves
 * (workflow node inputs). Its module sits in the editor boot chunk, which every
 * seeded widget already loads, so a new host costs no request of its own.
 */
export { SeedModeMenu, type SeedModeMenuProps } from './ui/shared/SeedModeMenu';
