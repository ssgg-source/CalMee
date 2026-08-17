export const CALMEE_EDITION = 'community' as const;

/**
 * The public composition root exposes only community product capabilities.
 * CalMee Pro supplies a separate private capability registry; shared components
 * must depend on this shape rather than importing Pro implementations.
 */
export const editionCapabilities = {
  commercialNoteConnectors: false,
  longTermPersonProfiles: false,
  managedCloudSync: false,
  enterpriseConnectors: false,
} as const;

export type EditionCapabilities = {
  [Key in keyof typeof editionCapabilities]: boolean;
};
