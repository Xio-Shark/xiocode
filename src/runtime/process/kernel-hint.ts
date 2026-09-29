/** How a user gets an indeterminate operation out of limbo, inside and outside the session. */
export function adjudicationHint(opId: string, domainPath: string): string {
  return `inspect the process, then run \`/kernel adjudicate ${opId}\` in this session `
    + `(or \`xio kernel adjudicate ${opId} --domain ${domainPath}\` after it exits)`;
}
