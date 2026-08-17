export const CALMEE_EDITION = 'community' as const;

/**
 * The public composition root exposes the capabilities available in this build.
 * Shared components depend on this shape so unfinished integrations stay out of
 * the user interface until they are ready.
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
