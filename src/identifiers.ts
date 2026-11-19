export const FACET_TYPES = ["API", "ACTOR", "AGENT"] as const;
export type FacetType = (typeof FACET_TYPES)[number];

export const USERNAME_MIN = 8 as const;
export const USERNAME_MAX = 16 as const;
export const USERNAME_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export const FACET_NAME_MIN = 4 as const;
export const FACET_NAME_MAX = 32 as const;
export const FACET_NAME_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export const SEMVER_REGEX =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;

export function isValidFacetType(value: string): value is FacetType {
  return (FACET_TYPES as readonly string[]).includes(value);
}

export function isValidUsername(value: string): boolean {
  return (
    value.length >= USERNAME_MIN &&
    value.length <= USERNAME_MAX &&
    USERNAME_REGEX.test(value)
  );
}

export function isValidFacetName(value: string): boolean {
  return (
    value.length >= FACET_NAME_MIN &&
    value.length <= FACET_NAME_MAX &&
    FACET_NAME_REGEX.test(value)
  );
}

export function isValidSemver(value: string): boolean {
  return SEMVER_REGEX.test(value);
}

export function parseSemver(value: string): {
  major: number;
  minor: number;
  patch: number;
} | null {
  if (!isValidSemver(value)) return null;
  const [majorStr, minorStr, patchStr] = value.split(".");
  return {
    major: Number(majorStr),
    minor: Number(minorStr),
    patch: Number(patchStr),
  };
}

export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) {
    throw new Error(`Invalid SemVer comparison: '${a}' vs '${b}'`);
  }
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  return pa.patch - pb.patch;
}

export function parseFacetRef(
  facetArg: string,
  providerArg?: string,
): { provider: string; facetName: string } {
  const trimmedFacet = facetArg.trim();
  const trimmedProvider = providerArg?.trim();
  if (trimmedFacet.includes("/")) {
    const parts = trimmedFacet.split("/");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new Error(
        `Invalid facet reference '${facetArg}'. Expected <provider>/<facet-name>.`,
      );
    }
    const [providerFromRef, facetName] = parts;
    if (trimmedProvider && trimmedProvider !== providerFromRef) {
      throw new Error(
        `Conflicting provider '${trimmedProvider}' and facet reference '${facetArg}'.`,
      );
    }
    if (!isValidUsername(providerFromRef)) {
      throw new Error(
        `Invalid provider '${providerFromRef}'. Must be 8-16 lowercase hyphenated kebab-case characters.`,
      );
    }
    if (!isValidFacetName(facetName)) {
      throw new Error(
        `Invalid facetName '${facetName}'. Must be 4-32 lowercase hyphenated kebab-case characters.`,
      );
    }
    return { provider: providerFromRef, facetName };
  }

  if (!trimmedProvider) {
    throw new Error(
      `Specify --provider <provider> with --facet ${trimmedFacet}, or pass --facet <provider>/<facet-name>.`,
    );
  }
  if (!isValidUsername(trimmedProvider)) {
    throw new Error(
      `Invalid provider '${trimmedProvider}'. Must be 8-16 lowercase hyphenated kebab-case characters.`,
    );
  }
  if (!isValidFacetName(trimmedFacet)) {
    throw new Error(
      `Invalid facetName '${trimmedFacet}'. Must be 4-32 lowercase hyphenated kebab-case characters.`,
    );
  }
  return { provider: trimmedProvider, facetName: trimmedFacet };
}
