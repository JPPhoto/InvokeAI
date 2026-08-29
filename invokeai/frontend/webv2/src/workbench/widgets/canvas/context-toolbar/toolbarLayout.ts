/** Fixed geometry of the canvas context toolbar; every number is a CSS pixel. */
export const TOOLBAR_HEIGHT_PX = 40;
export const TOOLBAR_GAP_PX = 8;
export const TOOLBAR_NUMBER_FIELD_WIDTH_PX = 60;

export type ToolbarRegionId = 'geometry' | 'intensity' | 'color' | 'modes';
/** `compact` is the geometry region at two numeric slots; `menu` is the More menu. */
export type ToolbarRegionPlacement = 'bar' | 'compact' | 'menu';

export const TOOLBAR_REGION_WIDTH_PX = {
  color: 64,
  geometry: 3 * TOOLBAR_NUMBER_FIELD_WIDTH_PX + 2 * TOOLBAR_GAP_PX,
  geometryCompact: 2 * TOOLBAR_NUMBER_FIELD_WIDTH_PX + TOOLBAR_GAP_PX,
  identity: 108,
  identityCompact: 32,
  intensity: 152,
  more: 32,
  status: 236,
  statusCompact: 104,
} as const;

/** Bar order; the spacer sits between `more` and `status`. */
export const TOOLBAR_REGION_ORDER: readonly ToolbarRegionId[] = ['geometry', 'intensity', 'color', 'modes'];

/** First to leave the bar when the widget narrows; the active tool's primary region leaves last of all. */
const DEMOTION_ORDER: readonly ToolbarRegionId[] = ['modes', 'color', 'intensity', 'geometry'];

export interface ToolbarLayoutInput {
  /** The region kept in the bar for as long as anything fits, or null for tools with no primary control. */
  primary: ToolbarRegionId | null;
  /**
   * Width the tool's modes content needs in the bar: 0 for content that
   * truncates (a hint), null when the region is empty and hidden, so it costs
   * neither width nor a gap.
   */
  modesWidth: number | null;
  /** Whether geometry, intensity and color are reserved; hint-only tools reserve nothing. */
  reservesToolRegions: boolean;
  width: number;
}

export interface ToolbarLayout {
  identity: 'full' | 'compact';
  /** Where each region renders; a hidden region still reads `bar`. */
  regions: Readonly<Record<ToolbarRegionId, ToolbarRegionPlacement>>;
  status: 'full' | 'compact';
}

const regionWidth = (region: ToolbarRegionId, placement: ToolbarRegionPlacement, modesWidth: number | null): number =>
  region === 'modes'
    ? (modesWidth ?? 0)
    : region === 'geometry' && placement === 'compact'
      ? TOOLBAR_REGION_WIDTH_PX.geometryCompact
      : TOOLBAR_REGION_WIDTH_PX[region];

/** Every displayed region costs its width plus the gap before it; a hidden region costs nothing. */
const requiredWidth = (layout: ToolbarLayout, modesWidth: number | null, reservesToolRegions = true): number => {
  const identity =
    layout.identity === 'full' ? TOOLBAR_REGION_WIDTH_PX.identity : TOOLBAR_REGION_WIDTH_PX.identityCompact;
  const status = layout.status === 'full' ? TOOLBAR_REGION_WIDTH_PX.status : TOOLBAR_REGION_WIDTH_PX.statusCompact;
  let total = identity + TOOLBAR_REGION_WIDTH_PX.more + status + 2 * TOOLBAR_GAP_PX;
  for (const region of TOOLBAR_REGION_ORDER) {
    const placement = layout.regions[region];
    const displayed = region === 'modes' ? modesWidth !== null : reservesToolRegions;
    if (placement !== 'menu' && displayed) {
      total += regionWidth(region, placement, modesWidth) + TOOLBAR_GAP_PX;
    }
  }
  return total;
};

const ALL_IN_BAR = { color: 'bar', geometry: 'bar', intensity: 'bar', modes: 'bar' } as const;
const MODES_ONLY = { color: 'menu', geometry: 'menu', intensity: 'menu', modes: 'bar' } as const;

/**
 * The widest primary region any tool or operation declares
 * (`toolAdapters.test.ts` enforces it). Identity and status compact at widths derived from it, so upgrading
 * either never evicts a tool's primary region as the bar widens.
 */
export const TOOLBAR_PRIMARY_MAX_WIDTH_PX = 244;

/** Below this width the identity shows only its icon: a full identity, the widest primary and a full status no longer fit. */
export const TOOLBAR_IDENTITY_FULL_MIN_WIDTH_PX = requiredWidth(
  { identity: 'full', regions: MODES_ONLY, status: 'full' },
  TOOLBAR_PRIMARY_MAX_WIDTH_PX
);
/** Below this width Apply and Cancel become icons and the chip an icon: a compact identity, the widest primary and a full status no longer fit. */
export const TOOLBAR_STATUS_FULL_MIN_WIDTH_PX = requiredWidth(
  { identity: 'compact', regions: MODES_ONLY, status: 'full' },
  TOOLBAR_PRIMARY_MAX_WIDTH_PX
);

const withRegion = (
  layout: ToolbarLayout,
  region: ToolbarRegionId,
  placement: ToolbarRegionPlacement
): ToolbarLayout => ({
  ...layout,
  regions: { ...layout.regions, [region]: placement },
});

/**
 * Identity and status compact at fixed widths, so their boxes depend on the
 * width alone and every tool shares them (an upgrade of either can send a
 * secondary region to the menu at that exact width; never the primary). The
 * regions between then fit
 * greedily in a fixed priority: modes, color, intensity and geometry leave for
 * the More menu, the active tool's primary region excepted; then geometry
 * shrinks to two slots; and only when the primary still does not fit does it
 * leave too, so the bar overflows into the menu rather than clipping. A region
 * without width (a truncating hint, or no modes content) is never demoted
 * because demoting it frees nothing.
 */
export const resolveToolbarLayout = ({
  modesWidth,
  primary,
  reservesToolRegions,
  width,
}: ToolbarLayoutInput): ToolbarLayout => {
  let layout: ToolbarLayout = {
    identity: width >= TOOLBAR_IDENTITY_FULL_MIN_WIDTH_PX ? 'full' : 'compact',
    regions: ALL_IN_BAR,
    status: width >= TOOLBAR_STATUS_FULL_MIN_WIDTH_PX ? 'full' : 'compact',
  };
  const fits = () => requiredWidth(layout, modesWidth, reservesToolRegions) <= width;
  for (const region of DEMOTION_ORDER) {
    if (fits()) {
      return layout;
    }
    const present = region === 'modes' ? modesWidth !== null : reservesToolRegions;
    if (region !== primary && present && regionWidth(region, 'bar', modesWidth) > 0) {
      layout = withRegion(layout, region, 'menu');
    }
  }
  if (!fits() && reservesToolRegions && layout.regions.geometry === 'bar') {
    layout = withRegion(layout, 'geometry', 'compact');
  }
  if (!fits() && primary && regionWidth(primary, 'bar', modesWidth) > 0) {
    layout = withRegion(layout, primary, 'menu');
  }
  return layout;
};

/** Width the bar needs before any region leaves it for the given modes width. */
export const fullToolbarWidth = (modesWidth: number | null, reservesToolRegions = true): number =>
  requiredWidth({ identity: 'full', regions: ALL_IN_BAR, status: 'full' }, modesWidth, reservesToolRegions);
