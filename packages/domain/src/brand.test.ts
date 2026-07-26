import { expect, test } from "bun:test"

import { brandLikePatterns, isBrandQuery } from "./brand.ts"

test("isBrandQuery matches any configured brand term case-insensitively", () => {
  const brandTerms = ["Brandy", "ACME"]
  expect(isBrandQuery("brandy shoes", brandTerms)).toBe(true)
  expect(isBrandQuery("acme widgets", brandTerms)).toBe(true)
  expect(isBrandQuery("widget search", brandTerms)).toBe(false)
})

test("isBrandQuery returns false when brandTerms is empty", () => {
  expect(isBrandQuery("anything", [])).toBe(false)
})

test("brandLikePatterns lowercases terms and wraps them for SQL LIKE", () => {
  expect(brandLikePatterns(["Brandy", "ACME"])).toEqual(["%brandy%", "%acme%"])
})
