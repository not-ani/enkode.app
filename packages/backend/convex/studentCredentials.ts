export const USERNAME_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

export function normalizeUsername(username: string) {
  return username.trim().toLowerCase();
}

export function studentCredentialEmail(organizationSlug: string, username: string) {
  return `${normalizeUsername(username)}.${organizationSlug}@students.enkode.invalid`;
}
