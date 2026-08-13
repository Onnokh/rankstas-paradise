export const isBrandQuery = (
  query: string,
  brandTerms: ReadonlyArray<string>,
): boolean =>
  brandTerms.some((term) => query.toLowerCase().includes(term.toLowerCase()))

export const brandLikePatterns = (
  brandTerms: ReadonlyArray<string>,
): ReadonlyArray<string> =>
  brandTerms.map((term) => `%${term.toLowerCase()}%`)
